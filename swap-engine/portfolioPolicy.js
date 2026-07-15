import { asBigInt, bpsBetween } from "./amount.js";

const BPS_DENOMINATOR = 10_000n;
const SCORE_SCALE = 10_000n;

export function normalizeTargetWeights(portfolioMints, configuredWeights = new Map()) {
  const mints = [...new Set(portfolioMints ?? [])];
  if (mints.length === 0) throw new RangeError("portfolioMints must not be empty");

  const raw = new Map();
  let configuredTotal = 0;
  for (const mint of mints) {
    const value = Number(configuredWeights.get?.(mint) ?? configuredWeights[mint] ?? 0);
    const safe = Number.isFinite(value) && value > 0 ? value : 0;
    raw.set(mint, safe);
    configuredTotal += safe;
  }

  if (configuredTotal <= 0) {
    const base = Math.floor(10_000 / mints.length);
    let assigned = 0;
    for (const [index, mint] of mints.entries()) {
      const weight = index === mints.length - 1 ? 10_000 - assigned : base;
      raw.set(mint, weight);
      assigned += weight;
    }
    return raw;
  }

  const normalized = new Map();
  let assigned = 0;
  for (const [index, mint] of mints.entries()) {
    const weight = index === mints.length - 1
      ? 10_000 - assigned
      : Math.floor((raw.get(mint) * 10_000) / configuredTotal);
    normalized.set(mint, Math.max(0, weight));
    assigned += Math.max(0, weight);
  }
  return normalized;
}

export function buildPortfolioSnapshot({
  balancesByMint,
  valuesByMint,
  targetWeightsBps,
  minTargetRatioBps = 5_000,
  maxTargetRatioBps = 15_000
}) {
  if (!(balancesByMint instanceof Map) || !(valuesByMint instanceof Map)) {
    throw new TypeError("balancesByMint and valuesByMint must be Map instances");
  }
  if (!(targetWeightsBps instanceof Map) || targetWeightsBps.size === 0) {
    throw new TypeError("targetWeightsBps must be a non-empty Map");
  }

  const totalValueAtomic = [...valuesByMint.values()]
    .reduce((sum, value) => sum + asBigInt(value), 0n);
  const entries = new Map();

  for (const [mint, weight] of targetWeightsBps) {
    const currentValueAtomic = asBigInt(valuesByMint.get(mint) ?? 0n);
    const targetValueAtomic =
      totalValueAtomic > 0n
        ? (totalValueAtomic * BigInt(Math.max(0, Math.round(weight)))) / BPS_DENOMINATOR
        : 0n;
    const minValueAtomic =
      (targetValueAtomic * BigInt(Math.max(0, Math.round(minTargetRatioBps)))) /
      BPS_DENOMINATOR;
    const maxValueAtomic =
      (targetValueAtomic * BigInt(Math.max(0, Math.round(maxTargetRatioBps)))) /
      BPS_DENOMINATOR;

    entries.set(mint, {
      mint,
      balanceAtomic: asBigInt(balancesByMint.get(mint) ?? 0n),
      currentValueAtomic,
      targetValueAtomic,
      minValueAtomic,
      maxValueAtomic,
      deviationBps: targetValueAtomic > 0n
        ? bpsBetween(currentValueAtomic, targetValueAtomic)
        : 0
    });
  }

  return {
    totalValueAtomic,
    entries,
    targetWeightsBps: new Map(targetWeightsBps),
    unpricedMints: new Set(
      [...balancesByMint.entries()]
        .filter(([mint, balance]) =>
          asBigInt(balance) > 0n &&
          !valuesByMint.has(mint)
        )
        .map(([mint]) => mint)
    )
  };
}

export function evaluatePortfolioCandidate(candidate, snapshot, {
  maxInventoryAdjustmentBps = 6,
  inventoryEdgePremiumBps = 2,
  maxInventoryAcquisitionLossBps = 20,
  allowInventoryEdges = true
} = {}) {
  const source = snapshot.entries.get(candidate.inputMint);
  const destination = snapshot.entries.get(candidate.outputMint);
  if (!source || !destination) {
    return blocked(candidate, "mint_not_in_portfolio");
  }

  const inputValueAtomic = readAtomic(
    candidate.baselineTargetValueAtomic ??
      candidate.reason?.baselineTargetValueAtomic
  );
  const outputValueAtomic = readAtomic(candidate.projectedFinalTargetAtomic);
  if (inputValueAtomic <= 0n || outputValueAtomic <= 0n) {
    return blocked(candidate, "candidate_not_valued");
  }

  const sourceAvailableAtomic = positive(source.currentValueAtomic - source.minValueAtomic);
  const destinationCapacityAtomic = positive(destination.maxValueAtomic - destination.currentValueAtomic);
  if (sourceAvailableAtomic <= 0n) return blocked(candidate, "source_reserve");
  if (destinationCapacityAtomic <= 0n) return blocked(candidate, "destination_cap");

  const requiredBps = finite(candidate.requiredBps, 0);
  const immediateNetBps = finite(
    candidate.immediateNetBps,
    finite(candidate.projectedNetBps, Number.NEGATIVE_INFINITY)
  );
  const liquidationNetBps = finite(
    candidate.liquidationNetBps,
    finite(candidate.projectedVsCurrentBps, Number.NEGATIVE_INFINITY)
  );
  const adjustmentBps = inventoryAdjustmentBps(
    source,
    destination,
    maxInventoryAdjustmentBps
  );

  const lockedProfit = liquidationNetBps >= requiredBps;
  const immediateEdge =
    allowInventoryEdges &&
    immediateNetBps >= requiredBps + inventoryEdgePremiumBps;
  const destinationNeedsInventory =
    destination.currentValueAtomic < destination.targetValueAtomic;
  const sourceCanFundInventory =
    source.currentValueAtomic > source.targetValueAtomic ||
    source.currentValueAtomic - inputValueAtomic >= source.minValueAtomic;
  const acquisitionRiskOk =
    liquidationNetBps >= -Math.abs(maxInventoryAcquisitionLossBps);
  const inventoryEdge =
    immediateEdge &&
    acquisitionRiskOk &&
    destinationNeedsInventory &&
    sourceCanFundInventory;
  // A positive immediate edge that does not improve inventory may still be
  // useful as one leg of a matched cycle. It is never allowed as a one-way
  // trade by the planner.
  const cycleOnlyEdge = immediateEdge && !inventoryEdge;

  if (!lockedProfit && !inventoryEdge && !cycleOnlyEdge) {
    return blocked(candidate, "below_profit_threshold", {
      immediateNetBps,
      liquidationNetBps,
      requiredBps,
      adjustmentBps
    });
  }

  const executionReason = lockedProfit
    ? "locked_profit"
    : inventoryEdge
      ? "inventory_edge"
      : "cycle_only_edge";
  const baseScoreBps = lockedProfit ? liquidationNetBps : immediateNetBps;
  const adjustedScoreBps = baseScoreBps + adjustmentBps;
  if (adjustedScoreBps < requiredBps) {
    return blocked(candidate, "inventory_adjusted_below_threshold", {
      immediateNetBps,
      liquidationNetBps,
      requiredBps,
      adjustmentBps,
      adjustedScoreBps
    });
  }

  return {
    ...candidate,
    accepted: true,
    executionReason,
    requiredBps,
    immediateNetBps,
    liquidationNetBps,
    inventoryAdjustmentBps: adjustmentBps,
    adjustedScoreBps,
    inputValueAtomic,
    outputValueAtomic,
    sourceAvailableAtomic,
    destinationCapacityAtomic
  };
}

export function planInventoryAwareBatch(candidates, snapshot, {
  maxTrades = 4,
  maxCycleLength = 5,
  maxOneWayInventoryTrades = 1,
  minTradeValueAtomic = 1n,
  maxInventoryAdjustmentBps = 6,
  inventoryEdgePremiumBps = 2,
  maxInventoryAcquisitionLossBps = 20,
  allowInventoryEdges = true
} = {}) {
  const evaluated = candidates
    .map((candidate) =>
      evaluatePortfolioCandidate(candidate, snapshot, {
        maxInventoryAdjustmentBps,
        inventoryEdgePremiumBps,
        maxInventoryAcquisitionLossBps,
        allowInventoryEdges
      })
    )
    .filter((candidate) => candidate.accepted)
    .sort(compareEvaluated);

  const workingValues = new Map(
    [...snapshot.entries].map(([mint, entry]) => [mint, entry.currentValueAtomic])
  );
  const selected = [];
  const usedPools = new Set();
  const usedKeys = new Set();

  const cycles = findCandidateCycles(evaluated, { maxCycleLength })
    .sort((a, b) => b.cycleScoreBps - a.cycleScoreBps);

  for (const cycle of cycles) {
    if (selected.length + cycle.edges.length > maxTrades) continue;
    if (cycle.edges.some((edge) => usedPools.has(edge.poolAddress))) continue;

    const trialValues = new Map(workingValues);
    const plannedCycle = [];
    let viable = true;
    for (const edge of cycle.edges) {
      const planned = planOne(edge, snapshot, trialValues, minTradeValueAtomic);
      if (!planned) {
        viable = false;
        break;
      }
      plannedCycle.push({
        ...planned,
        underlyingExecutionReason: planned.executionReason,
        executionReason: "inventory_neutral_cycle",
        cycleKey: cycle.key
      });
    }
    if (!viable) continue;

    const cycleInputValue = plannedCycle
      .reduce((sum, edge) => sum + asBigInt(edge.inputValueAtomic), 0n);
    const cycleOutputValue = plannedCycle
      .reduce((sum, edge) => sum + asBigInt(edge.outputValueAtomic), 0n);
    const cycleLiquidationBps = cycleInputValue > 0n
      ? bpsBetween(cycleOutputValue, cycleInputValue)
      : Number.NEGATIVE_INFINITY;
    const cycleRequiredBps = Math.max(
      ...plannedCycle.map((edge) => finite(edge.requiredBps, 0))
    );
    if (cycleLiquidationBps < cycleRequiredBps) continue;
    for (const edge of plannedCycle) {
      edge.cycleLiquidationBps = cycleLiquidationBps;
    }

    workingValues.clear();
    for (const [mint, value] of trialValues) workingValues.set(mint, value);
    for (const planned of plannedCycle) {
      selected.push(planned);
      usedPools.add(planned.poolAddress);
      usedKeys.add(candidateKey(planned));
    }
    if (selected.length >= maxTrades) return selected;
  }

  let oneWayInventoryTrades = 0;
  for (const candidate of evaluated) {
    if (selected.length >= maxTrades) break;
    if (usedPools.has(candidate.poolAddress) || usedKeys.has(candidateKey(candidate))) continue;
    if (candidate.executionReason === "cycle_only_edge") continue;
    if (
      candidate.executionReason === "inventory_edge" &&
      oneWayInventoryTrades >= maxOneWayInventoryTrades
    ) {
      continue;
    }

    const planned = planOne(candidate, snapshot, workingValues, minTradeValueAtomic);
    if (!planned) continue;
    selected.push(planned);
    usedPools.add(planned.poolAddress);
    usedKeys.add(candidateKey(planned));
    if (candidate.executionReason === "inventory_edge") oneWayInventoryTrades += 1;
  }

  return selected;
}

export function findCandidateCycles(candidates, { maxCycleLength = 5 } = {}) {
  const adjacency = new Map();
  for (const candidate of candidates) {
    const list = adjacency.get(candidate.inputMint) ?? [];
    list.push(candidate);
    adjacency.set(candidate.inputMint, list);
  }
  for (const rows of adjacency.values()) rows.sort(compareEvaluated);

  const cycles = [];
  const seen = new Set();

  function visit(startMint, currentMint, path, visitedMints, usedPools) {
    if (path.length >= maxCycleLength) return;
    for (const edge of adjacency.get(currentMint) ?? []) {
      if (usedPools.has(edge.poolAddress)) continue;
      if (edge.outputMint === startMint && path.length >= 1) {
        const edges = [...path, edge];
        const key = canonicalCycleKey(edges);
        if (seen.has(key)) continue;
        seen.add(key);
        const scores = edges.map((item) => finite(item.adjustedScoreBps, -Infinity));
        cycles.push({
          key,
          edges,
          cycleScoreBps: Math.min(...scores),
          averageScoreBps: scores.reduce((sum, value) => sum + value, 0) / scores.length
        });
        continue;
      }
      if (visitedMints.has(edge.outputMint)) continue;
      const nextVisited = new Set(visitedMints);
      nextVisited.add(edge.outputMint);
      const nextPools = new Set(usedPools);
      nextPools.add(edge.poolAddress);
      visit(startMint, edge.outputMint, [...path, edge], nextVisited, nextPools);
    }
  }

  for (const startMint of adjacency.keys()) {
    visit(startMint, startMint, [], new Set([startMint]), new Set());
  }
  return cycles;
}


export function fixedCostBps({
  costValueAtomic,
  inputValueAtomic
}) {
  const cost = asBigInt(costValueAtomic);
  const input = asBigInt(inputValueAtomic);
  if (input <= 0n) return Number.POSITIVE_INFINITY;
  return Number((cost * 100_000_000n) / input) / 10_000;
}

export function minimumComparableOutputAtomic({
  inputAmountAtomic,
  inputDecimals,
  outputDecimals,
  requiredBps
}) {
  if (!Number.isInteger(inputDecimals) || inputDecimals < 0) {
    throw new RangeError("inputDecimals must be a non-negative integer");
  }
  if (!Number.isInteger(outputDecimals) || outputDecimals < 0) {
    throw new RangeError("outputDecimals must be a non-negative integer");
  }
  const input = asBigInt(inputAmountAtomic);
  const scaledBps = BigInt(Math.ceil(finite(requiredBps, 0) * Number(SCORE_SCALE)));
  const factor = 100_000_000n + scaledBps;
  const numerator =
    input *
    (10n ** BigInt(outputDecimals)) *
    factor;
  const denominator =
    (10n ** BigInt(inputDecimals)) *
    100_000_000n;
  return ceilDiv(numerator, denominator);
}

export function realizedComparableBps({
  inputAmountAtomic,
  outputAmountAtomic,
  inputDecimals,
  outputDecimals
}) {
  const input = asBigInt(inputAmountAtomic);
  const output = asBigInt(outputAmountAtomic);
  const inputComparable = input * (10n ** BigInt(outputDecimals));
  const outputComparable = output * (10n ** BigInt(inputDecimals));
  return bpsBetween(outputComparable, inputComparable);
}

function planOne(candidate, snapshot, workingValues, minTradeValueAtomic) {
  const source = snapshot.entries.get(candidate.inputMint);
  const destination = snapshot.entries.get(candidate.outputMint);
  if (!source || !destination) return null;

  const sourceCurrent = workingValues.get(candidate.inputMint) ?? 0n;
  const destinationCurrent = workingValues.get(candidate.outputMint) ?? 0n;
  const available = positive(sourceCurrent - source.minValueAtomic);
  const capacity = positive(destination.maxValueAtomic - destinationCurrent);
  if (available <= 0n || capacity <= 0n) return null;

  const inputValue = asBigInt(candidate.inputValueAtomic);
  const outputValue = asBigInt(candidate.outputValueAtomic);
  if (inputValue <= 0n || outputValue <= 0n) return null;

  let scaleNumerator = inputValue;
  let scaleDenominator = inputValue;
  if (available < inputValue) {
    scaleNumerator = available;
    scaleDenominator = inputValue;
  }
  if (capacity < outputValue) {
    const capacityInputEquivalent = (inputValue * capacity) / outputValue;
    if (capacityInputEquivalent * scaleDenominator < scaleNumerator * inputValue) {
      scaleNumerator = capacityInputEquivalent;
      scaleDenominator = inputValue;
    }
  }
  if (scaleNumerator <= 0n) return null;

  const plannedInput = (asBigInt(candidate.inputAmountAtomic) * scaleNumerator) / scaleDenominator;
  const plannedInputValue = (inputValue * scaleNumerator) / scaleDenominator;
  const plannedOutputValue = (outputValue * scaleNumerator) / scaleDenominator;
  const plannedOutput = (asBigInt(candidate.estimatedOutputAtomic) * scaleNumerator) / scaleDenominator;
  if (plannedInput <= 0n || plannedInputValue < asBigInt(minTradeValueAtomic)) return null;

  workingValues.set(candidate.inputMint, sourceCurrent - plannedInputValue);
  workingValues.set(candidate.outputMint, destinationCurrent + plannedOutputValue);

  return {
    ...candidate,
    inputAmountAtomic: plannedInput,
    estimatedOutputAtomic: plannedOutput,
    inputValueAtomic: plannedInputValue,
    outputValueAtomic: plannedOutputValue,
    plannedScaleBps: Number((scaleNumerator * 10_000n) / scaleDenominator)
  };
}

function inventoryAdjustmentBps(source, destination, maxAdjustmentBps) {
  const sourcePressure = pressure(source);
  const destinationPressure = pressure(destination);
  return finite(maxAdjustmentBps, 0) * (sourcePressure - destinationPressure) / 2;
}

function pressure(entry) {
  if (entry.targetValueAtomic <= 0n) return 0;
  const scaled =
    Number(
      ((entry.currentValueAtomic - entry.targetValueAtomic) * 1_000_000n) /
      entry.targetValueAtomic
    ) / 1_000_000;
  return Math.max(-1, Math.min(1, scaled));
}

function blocked(candidate, blockedReason, details = {}) {
  return {
    ...candidate,
    accepted: false,
    executionReason: null,
    blockedReason,
    ...details
  };
}

function compareEvaluated(a, b) {
  const scoreDelta = finite(b.adjustedScoreBps, -Infinity) -
    finite(a.adjustedScoreBps, -Infinity);
  if (scoreDelta !== 0) return scoreDelta;
  return finite(a.feeBps ?? a.reason?.feeBps, 0) -
    finite(b.feeBps ?? b.reason?.feeBps, 0);
}

function candidateKey(candidate) {
  return [
    candidate.poolAddress,
    candidate.inputMint,
    candidate.outputMint
  ].join(":");
}

function canonicalCycleKey(edges) {
  const parts = edges.map((edge) => candidateKey(edge));
  const rotations = [];
  for (let index = 0; index < parts.length; index += 1) {
    rotations.push([...parts.slice(index), ...parts.slice(0, index)].join("|"));
  }
  return rotations.sort()[0];
}

function readAtomic(value) {
  if (value === undefined || value === null || value === "") return 0n;
  try {
    return asBigInt(value);
  } catch {
    return 0n;
  }
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positive(value) {
  return value > 0n ? value : 0n;
}

function ceilDiv(numerator, denominator) {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  return (numerator + denominator - 1n) / denominator;
}
