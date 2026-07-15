const { asBigInt, bpsBetween } = require("./amount.js");
const {
  bestProjectionToTarget,
  canCloseToTarget,
  isEdgeUsable,
  quoteEdge
} = require("./projection.js");

async function buildNextHopCandidates({
  graph,
  currentMint,
  currentAmountAtomic,
  startingTargetValueAtomic,
  targetMint,
  legIndex,
  maxHops,
  minProfitBps = 3,
  safetyBufferBps = 1.5,
  slippageBufferBps = 0,
  priorityFeeBps = 0,
  staleStateBufferBps = 0,
  allowedTokens,
  currentSlot,
  maxPoolSlotLag = 2,
  maxPoolAgeMs = 2_000,
  now = Date.now(),
  maxCandidates = 20,
  diagnosticsTopN = 30,
  cycleMode = "target_projection",
  valueBaselineMode = "starting_value",
  opportunityComparableMints
}) {
  if (!graph) throw new TypeError("graph is required");
  if (!currentMint || !targetMint) throw new TypeError("currentMint and targetMint are required");
  if (!Number.isInteger(legIndex) || legIndex < 0) {
    throw new RangeError("legIndex must be a non-negative integer");
  }
  if (!Number.isInteger(maxHops) || maxHops < 1) {
    throw new RangeError("maxHops must be a positive integer");
  }

  const inputAmount = asBigInt(currentAmountAtomic, "currentAmountAtomic");
  const startingValue = asBigInt(startingTargetValueAtomic, "startingTargetValueAtomic");
  const remainingAfterCandidate = maxHops - (legIndex + 1);
  if (remainingAfterCandidate < 0) return [];

  const commonUsability = (edge, amount = inputAmount) =>
    isEdgeUsable(edge, {
      allowedTokens,
      currentSlot,
      maxPoolSlotLag,
      now,
      maxPoolAgeMs,
      amountAtomic: amount
    });

  const candidates = [];
  const diagnostics = {
    outgoing: 0,
    unusable: 0,
    noClosure: 0,
    quoteFailed: 0,
    noProjection: 0,
    belowThreshold: 0,
    accepted: 0,
    topRanked: [],
    topBelowThreshold: [],
    quoteFailures: []
  };

  const baselineTargetValue =
    valueBaselineMode === "current_value" && currentMint !== targetMint
      ? (
        await bestProjectionToTarget({
          graph,
          fromMint: currentMint,
          targetMint,
          amountAtomic: inputAmount,
          maxHops: maxHops - legIndex,
          allowedTokens,
          edgeFilter: (suffixEdge, amount) => commonUsability(suffixEdge, amount)
        })
      )?.finalAmountAtomic ?? startingValue
      : startingValue;

  for (const edge of graph.outgoing(currentMint)) {
    diagnostics.outgoing += 1;
    if (edge.tokenInMint !== currentMint) continue;
    if (!commonUsability(edge, inputAmount)) {
      diagnostics.unusable += 1;
      continue;
    }

    const closureOk =
      edge.tokenOutMint === targetMint ||
      canCloseToTarget({
        graph,
        fromMint: edge.tokenOutMint,
        targetMint,
        remainingHops: remainingAfterCandidate,
        allowedTokens,
        edgeFilter: (suffixEdge) => commonUsability(suffixEdge)
      });

    if (!closureOk) {
      diagnostics.noClosure += 1;
      continue;
    }

    let firstQuote;
    try {
      firstQuote = await quoteEdge(edge, inputAmount);
    } catch (error) {
      diagnostics.quoteFailed += 1;
      if (diagnostics.quoteFailures.length < 5) {
        diagnostics.quoteFailures.push({
          poolAddress: edge.poolAddress,
          inputMint: edge.tokenInMint,
          outputMint: edge.tokenOutMint,
          reason: error?.message ?? String(error)
        });
      }
      continue;
    }

    const immediateHoldBps = immediateComparableBps({
      inputMint: currentMint,
      outputMint: edge.tokenOutMint,
      inputAmountAtomic: inputAmount,
      outputAmountAtomic: firstQuote.outputAmountAtomic,
      inputDecimals: edge.tokenInDecimals,
      outputDecimals: edge.tokenOutDecimals,
      comparableMints: opportunityComparableMints
    });
    const canScoreImmediate =
      (cycleMode === "immediate_hold" || cycleMode === "portfolio_inventory") &&
      immediateHoldBps !== null;

    let projection;
    if (edge.tokenOutMint === targetMint) {
      projection = {
        finalAmountAtomic: firstQuote.outputAmountAtomic,
        path: []
      };
    } else {
      projection = await bestProjectionToTarget({
        graph,
        fromMint: edge.tokenOutMint,
        targetMint,
        amountAtomic: firstQuote.outputAmountAtomic,
        maxHops: remainingAfterCandidate,
        allowedTokens,
        excludedPools: new Set([edge.poolAddress]),
        edgeFilter: (suffixEdge, amount) => commonUsability(suffixEdge, amount)
      });
    }

    const requiresValuationProjection = cycleMode === "portfolio_inventory";
    if (!projection && (!canScoreImmediate || requiresValuationProjection)) {
      diagnostics.noProjection += 1;
      continue;
    }

    const projectedFinalAmount = projection?.finalAmountAtomic ?? firstQuote.outputAmountAtomic;
    const grossProjectedBps = projection
      ? bpsBetween(projection.finalAmountAtomic, startingValue)
      : null;
    const projectedVsCurrentBps = projection
      ? bpsBetween(projection.finalAmountAtomic, baselineTargetValue)
      : null;
    const totalExecutionBufferBps =
      slippageBufferBps +
      priorityFeeBps +
      staleStateBufferBps;
    const immediateNetBps = immediateHoldBps === null
      ? null
      : immediateHoldBps - totalExecutionBufferBps;
    const liquidationNetBps = projectedVsCurrentBps === null
      ? null
      : projectedVsCurrentBps - totalExecutionBufferBps;
    const scoreMode =
      canScoreImmediate
        ? (cycleMode === "portfolio_inventory" ? "portfolio_inventory" : "immediate_hold")
        : "target_projection";
    const projectedNetBps =
      scoreMode === "target_projection" ? liquidationNetBps : immediateNetBps;
    const requiredBps = minProfitBps + safetyBufferBps;
    const rankedRow = {
      poolAddress: edge.poolAddress,
      inputMint: currentMint,
      outputMint: edge.tokenOutMint,
      estimatedOutputAtomic: firstQuote.outputAmountAtomic.toString(),
      projectedFinalTargetAtomic: projectedFinalAmount.toString(),
      projectedNetBps,
      projectedVsCurrentBps,
      immediateHoldBps,
      immediateNetBps,
      liquidationNetBps,
      scoreMode,
      requiredBps,
      baselineTargetValueAtomic: baselineTargetValue.toString(),
      projectedValueDeltaAtomic: projection
        ? (projection.finalAmountAtomic - baselineTargetValue).toString()
        : null,
      feeBps: Number(edge.feeBps ?? 0)
    };
    diagnostics.topRanked.push(rankedRow);

    if (projectedNetBps < requiredBps) {
      diagnostics.belowThreshold += 1;
      diagnostics.topBelowThreshold.push(rankedRow);
      continue;
    }

    diagnostics.accepted += 1;
    candidates.push({
      inputMint: currentMint,
      outputMint: edge.tokenOutMint,
      poolAddress: edge.poolAddress,
      dexType: edge.dexType,
      mathType: edge.mathType,
      inputAmountAtomic: inputAmount,
      estimatedOutputAtomic: firstQuote.outputAmountAtomic,
      projectedFinalTargetAtomic: projectedFinalAmount,
      grossProjectedBps,
      projectedVsCurrentBps,
      immediateHoldBps,
      immediateNetBps,
      liquidationNetBps,
      scoreMode,
      projectedNetBps,
      requiredBps,
      minProfitBps,
      safetyBufferBps,
      baselineTargetValueAtomic: baselineTargetValue,
      inputDecimals: edge.tokenInDecimals,
      outputDecimals: edge.tokenOutDecimals,
      slot: edge.lastUpdatedSlot,
      poolStateVersion: edge.stateVersion,
      suffixPath: (projection?.path ?? []).map(({ edge: suffixEdge }) => ({
        poolAddress: suffixEdge.poolAddress,
        inputMint: suffixEdge.tokenInMint,
        outputMint: suffixEdge.tokenOutMint
      })),
      reason: {
        depthOk: true,
        closureOk: true,
        feeBps: Number(edge.feeBps ?? 0),
        scoreMode,
        immediateHoldBps,
        immediateNetBps,
        liquidationNetBps,
        baselineTargetValueAtomic: baselineTargetValue.toString(),
        staleFlags: [...(edge.staleFlags ?? [])]
      }
    });
  }

  diagnostics.topRanked = diagnostics.topRanked
    .sort((a, b) => b.projectedNetBps - a.projectedNetBps)
    .slice(0, diagnosticsTopN);

  diagnostics.topBelowThreshold = diagnostics.topBelowThreshold
    .sort((a, b) => b.projectedNetBps - a.projectedNetBps)
    .slice(0, diagnosticsTopN);

  const sorted = candidates
    .sort((a, b) => {
      if (b.projectedNetBps !== a.projectedNetBps) {
        return b.projectedNetBps - a.projectedNetBps;
      }
      const aEdge = graph.getEdge(a.poolAddress, a.inputMint, a.outputMint);
      const bEdge = graph.getEdge(b.poolAddress, b.inputMint, b.outputMint);
      const liquidityDelta = Number(bEdge?.liquidity ?? 0) - Number(aEdge?.liquidity ?? 0);
      if (liquidityDelta !== 0) return liquidityDelta;
      return Number(aEdge?.feeBps ?? 0) - Number(bEdge?.feeBps ?? 0);
    })
    .slice(0, maxCandidates);
  Object.defineProperty(sorted, "diagnostics", {
    value: diagnostics,
    enumerable: false
  });
  return sorted;
}

function immediateComparableBps({
  inputMint,
  outputMint,
  inputAmountAtomic,
  outputAmountAtomic,
  inputDecimals,
  outputDecimals,
  comparableMints
}) {
  if (!comparableMints?.has?.(inputMint) || !comparableMints.has(outputMint)) {
    return null;
  }
  if (!Number.isInteger(inputDecimals) || !Number.isInteger(outputDecimals)) {
    return null;
  }

  const inputScale = 10n ** BigInt(inputDecimals);
  const outputScale = 10n ** BigInt(outputDecimals);
  const inputComparable = asBigInt(inputAmountAtomic) * outputScale;
  const outputComparable = asBigInt(outputAmountAtomic) * inputScale;
  return bpsBetween(outputComparable, inputComparable);
}
module.exports = { buildNextHopCandidates, immediateComparableBps };