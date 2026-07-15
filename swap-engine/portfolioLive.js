'strict'


require('dotenv').config();
const { createRequire } = require("node:module");
const { readFile } = require("node:fs/promises");
const { appendFileSync, mkdirSync } = require("node:fs");
const { dirname } = require("node:path");
const { Connection, Keypair } = require("@solana/web3.js");
const { PairGraph } = require("./graph.js");
const { buildNextHopCandidates } = require("./frontier.js");
const { asBigInt, bigintMax, subtractBps, bpsBetween } = require("./amount.js");
const { quoteEdge } = require("./projection.js");
const { jsonReplacer } = require("./persistence.js");
const {
  buildGraph = requireEnrichedPools,
  loadEnrichedPools
} = require("./enrichedPoolAdapter.js");
const { LiveExecutor } = require("./liveExecutor.js");
const { LivePoolStateProvider } = require("./livePoolStateProvider.js");
const { WalletBalanceProvider } = require("./walletBalanceProvider.js");
const {
  buildPortfolioSnapshot,
  evaluatePortfolioCandidate,
  fixedCostBps,
  minimumComparableOutputAtomic,
  normalizeTargetWeights,
  planInventoryAwareBatch,
  realizedComparableBps
} = require("./portfolioPolicy.js");
const { markPortfolioToTarget } = require("./portfolioValuation.js");

//const require = require('meta.url');
const { MathAdapter } = require("../math/mathAdapter.js");

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const USD1 = "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB";

const DEFAULT_PORTFOLIO_MINTS = [WSOL, USDC, USDT, USD1, PYUSD];
const DEFAULT_COMPARABLE_MINTS = [USDC, USDT, USD1, PYUSD];
const MINT_ALIASES = new Map([
  ["WSOL", WSOL],
  ["SOL", WSOL],
  ["USDC", USDC],
  ["USDT", USDT],
  ["PYUSD", PYUSD],
  ["USD1", USD1]
]);

async function main() {
  for (let step = 0; step < maxSteps; step += 1) {
    await runPortfolioStep({
      step,
      graph,
      poolStateProvider,
      balanceProvider,
      executor,
      connection,
      wallet,
      config,
      logs
    });
    if (step + 1 < maxSteps && intervalMs > 0) await sleep(intervalMs);
  }
  const poolFile = env("POOL_FILE", "pools/03_ROUTED.json");
  const rpcUrl = env("RPC_URL", env("SOLANA_RPC_URL", ""));
  const keypairPath = env("KEYPAIR_PATH", "./keyPair/solflare_keypair.json");
  if (!rpcUrl) throw new Error("RPC_URL or SOLANA_RPC_URL is required");

  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = await loadKeypair(keypairPath);
  const pools = loadEnrichedPools(poolFile);
  const graph = new PairGraph();
  const currentSlot = await connection.getSlot("confirmed");
  const mathAdapter = new MathAdapter({ connection });
  const graphResult = buildGraph = require(EnrichedPools(graph, pools, {
    now: Date.now(),
    currentSlot,
    mathAdapter
  }))
};

const portfolioMints = envMintSet(
  "PORTFOLIO_MINTS",
  new Set(DEFAULT_PORTFOLIO_MINTS)
);
const allowedTokens = envMintSet("TOKEN_ALLOWLIST", graphResult.allowedTokens);
const comparableMints = envMintSet(
  "OPPORTUNITY_COMPARABLE_MINTS",
  new Set(DEFAULT_COMPARABLE_MINTS)
);
const valuationMint = resolveMint(env("VALUATION_MINT", "USDC"));
portfolioMints.add(valuationMint);
allowedTokens.add(valuationMint);

const targetWeightsBps = normalizeTargetWeights(
  portfolioMints,
  envMintNumberMap("PORTFOLIO_TARGET_WEIGHTS_BPS")
);
const poolsByAddress = new Map(
  pools.map((pool) => [pool.poolAddress || pool.address || pool.id, pool])
);

const config = {
  valuationMint,
  targetMint: valuationMint,
  maxHops: envNumber("MAX_HOPS", 4),
  valuationMaxHops: envNumber("VALUATION_MAX_HOPS", 3),
  minProfitBps: envNumber("MIN_PROFIT_BPS", 3),
  safetyBufferBps: envNumber("SAFETY_BUFFER_BPS", 1.5),
  slippageBufferBps: envNumber("SLIPPAGE_BUFFER_BPS", 0),
  priorityFeeBps: envNumber("PRIORITY_FEE_BPS", 0),
  staleStateBufferBps: envNumber("STALE_STATE_BUFFER_BPS", 0),
  maxPoolSlotLag: envNumber("MAX_POOL_SLOT_LAG", 100_000),
  maxPoolAgeMs: envNumber("MAX_POOL_AGE_MS", 300_000),
  maxCandidates: envNumber("MAX_CANDIDATES", 20),
  quoteTopN: envNumber("QUOTE_TOP_N", 100),
  maxSingleSwapSlippageBps: envNumber("MAX_SINGLE_SWAP_SLIPPAGE_BPS", 4),
  cycleMode: "portfolio_inventory",
  valueBaselineMode: "current_value",
  allowedTokens,
  comparableMints,
  portfolioMints,
  targetWeightsBps,
  haircutsBpsByMint: envMintNumberMap("TOKEN_HAIRCUT_BPS"),
  stableTradeAmountAtomic: envBigInt("STABLE_TRADE_AMOUNT_ATOMIC", 1_000_000n),
  wsolTradeAmountAtomic: envBigInt("WSOL_TRADE_AMOUNT_ATOMIC", 10_000_000n),
  estimatedTxFeeLamports: envBigInt(
    "ESTIMATED_TX_FEE_LAMPORTS",
    10_000n
  ),
  estimatedTxFeeValueAtomicOverride: envBigInt(
    "ESTIMATED_TX_FEE_VALUE_ATOMIC",
    0n
  ),
  minTradeAmountAtomic: envBigInt("MIN_TRADE_AMOUNT_ATOMIC", 1n),
  minTradeValueAtomic: envBigInt("MIN_TRADE_VALUE_ATOMIC", 10_000n),
  minTargetRatioBps: envNumber("MIN_TARGET_RATIO_BPS", 5_000),
  maxTargetRatioBps: envNumber("MAX_TARGET_RATIO_BPS", 15_000),
  maxInventoryAdjustmentBps: envNumber("MAX_INVENTORY_ADJUSTMENT_BPS", 6),
  inventoryEdgePremiumBps: envNumber("INVENTORY_EDGE_PREMIUM_BPS", 2),
  maxInventoryAcquisitionLossBps: envNumber(
    "MAX_INVENTORY_ACQUISITION_LOSS_BPS",
    20
  ),
  allowInventoryEdges: envBool("ALLOW_INVENTORY_EDGES", true),
  haltOnUnpricedInventory: envBool(
    "HALT_ON_UNPRICED_INVENTORY",
    true
  ),
  maxOneWayInventoryTrades: envNumber("MAX_ONE_WAY_INVENTORY_TRADES", 1),
  maxCycleLength: envNumber("MAX_INVENTORY_CYCLE_LENGTH", 5),
  maxExecutionAttemptsPerStep: envNumber("MAX_EXECUTION_ATTEMPTS_PER_STEP", 5),
  maxTradesPerStep: envNumber("MAX_TRADES_PER_STEP", 4)
};

const poolStateProvider = new LivePoolStateProvider({
  connection,
  poolsByAddress,
  graph,
  mathAdapter
});
const balanceProvider = new WalletBalanceProvider({
  connection,
  owner: wallet.publicKey
});
const executor = new LiveExecutor({
  connection,
  wallet,
  dryRun: envBool("DRY_RUN", true),
  computeUnitLimit: envNumber("COMPUTE_UNIT_LIMIT", 400_000),
  computeUnitPriceMicroLamports: envNumber(
    "COMPUTE_UNIT_PRICE_MICRO_LAMPORTS",
    0
  )
});
const logs = {
  summary: env("QUOTE_SIMPLE_LOG", "data/summary.log"),
  execution: env("EXECUTION_LOG", "data/execution.jsonl"),
  executedPools: env("EXECUTED_POOLS_LOG", "data/executed_pools.log")
};

const started = {
  timestamp: new Date().toISOString(),
  event: "portfolio_live_started",
  poolFile,
  pools: pools.length,
  directedEdges: graphResult.edgeCount,
  skipped: graphResult.skipped.length,
  wallet: wallet.publicKey.toBase58(),
  dryRun: executor.dryRun,
  valuationMint,
  portfolioMints: [...portfolioMints],
  targetWeightsBps: Object.fromEntries(targetWeightsBps),
  minProfitBps: config.minProfitBps,
  safetyBufferBps: config.safetyBufferBps,
  inventoryEdgePremiumBps: config.inventoryEdgePremiumBps,
  maxInventoryAcquisitionLossBps:
    config.maxInventoryAcquisitionLossBps
};
logJson(logs.execution, started);
console.log("[portfolio-live] loaded", {
  pools: pools.length,
  directedEdges: graphResult.edgeCount,
  wallet: wallet.publicKey.toBase58(),
  dryRun: executor.dryRun,
  valuationMint: shortMint(valuationMint),
  targetWeightsBps: Object.fromEntries(
    [...targetWeightsBps].map(([mint, weight]) => [shortMint(mint), weight])
  )
});

const runForever = envBool("RUN_FOREVER", false);
const maxSteps = runForever
  ? Number.POSITIVE_INFINITY
  : envNumber("MAX_LIVE_STEPS", 1);
const intervalMs = envNumber("LIVE_LOOP_INTERVAL_MS", 5_000);



async function runPortfolioStep({
  step,
  graph,
  poolStateProvider,
  balanceProvider,
  executor,
  connection,
  wallet,
  config,
  logs
}) {
  const openingNativeLamports = BigInt(
    await connection.getBalance(wallet.publicKey, "confirmed")
  );
  let currentSlot = await poolStateProvider.getCurrentSlot();
  const refreshed = await poolStateProvider.refreshAll({ currentSlot });
  currentSlot = await poolStateProvider.getCurrentSlot();

  const balancesByMint = await readPortfolioBalances(
    config.portfolioMints,
    balanceProvider
  );
  const openingValuation = await markPortfolioToTarget({
    graph,
    balancesByMint,
    targetMint: config.valuationMint,
    maxHops: config.valuationMaxHops,
    allowedTokens: config.allowedTokens,
    currentSlot,
    maxPoolSlotLag: config.maxPoolSlotLag,
    maxPoolAgeMs: config.maxPoolAgeMs,
    haircutsBpsByMint: config.haircutsBpsByMint
  });
  const snapshot = buildPortfolioSnapshot({
    balancesByMint,
    valuesByMint: openingValuation.valuesByMint,
    targetWeightsBps: config.targetWeightsBps,
    minTargetRatioBps: config.minTargetRatioBps,
    maxTargetRatioBps: config.maxTargetRatioBps
  });

  const estimatedNetworkFeeValueAtomic =
    config.estimatedTxFeeValueAtomicOverride > 0n
      ? config.estimatedTxFeeValueAtomicOverride
      : await valueWsolAmount({
        amountAtomic: config.estimatedTxFeeLamports,
        graph,
        currentSlot,
        config
      });
  if (
    config.estimatedTxFeeLamports > 0n &&
    estimatedNetworkFeeValueAtomic <= 0n
  ) {
    throw new Error(
      "network fee could not be valued; set ESTIMATED_TX_FEE_VALUE_ATOMIC"
    );
  }

  const activeUnpriced = [...openingValuation.unpricedMints]
    .filter((mint) => (balancesByMint.get(mint) ?? 0n) > 0n);
  const riskHalt =
    config.haltOnUnpricedInventory && activeUnpriced.length > 0;
  if (activeUnpriced.length > 0) {
    logJson(logs.execution, {
      timestamp: new Date().toISOString(),
      event: "portfolio_unpriced_inventory",
      mints: activeUnpriced,
      riskHalt
    });
  }

  const ranked = [];
  for (const mint of config.portfolioMints) {
    if (!config.allowedTokens.has(mint)) continue;
    if (openingValuation.unpricedMints.has(mint)) continue;

    const balanceAtomic = balancesByMint.get(mint) ?? 0n;
    const tradeAmountAtomic = chooseTradeAmount({
      mint,
      balanceAtomic,
      stableTradeAmountAtomic: config.stableTradeAmountAtomic,
      wsolTradeAmountAtomic: config.wsolTradeAmountAtomic,
      minTradeAmountAtomic: config.minTradeAmountAtomic
    });
    if (tradeAmountAtomic <= 0n) continue;

    const result = await buildNextHopCandidates({
      graph,
      currentMint: mint,
      currentAmountAtomic: tradeAmountAtomic,
      startingTargetValueAtomic: tradeAmountAtomic,
      targetMint: config.valuationMint,
      legIndex: 0,
      maxHops: config.maxHops,
      minProfitBps: config.minProfitBps,
      safetyBufferBps: config.safetyBufferBps,
      slippageBufferBps: config.slippageBufferBps,
      priorityFeeBps: config.priorityFeeBps,
      staleStateBufferBps: config.staleStateBufferBps,
      allowedTokens: config.allowedTokens,
      currentSlot,
      maxPoolSlotLag: config.maxPoolSlotLag,
      maxPoolAgeMs: config.maxPoolAgeMs,
      now: Date.now(),
      maxCandidates: config.maxCandidates,
      diagnosticsTopN: config.quoteTopN,
      cycleMode: config.cycleMode,
      valueBaselineMode: config.valueBaselineMode,
      opportunityComparableMints: config.comparableMints
    });

    for (const row of result.diagnostics?.topRanked ?? []) {
      if (!config.portfolioMints.has(row.outputMint)) continue;
      ranked.push(
        applyEstimatedNetworkFee(
          {
            ...row,
            inputAmountAtomic: tradeAmountAtomic,
            tradeAmountAtomic,
            holdingMint: mint
          },
          estimatedNetworkFeeValueAtomic
        )
      );
    }
  }

  const uniqueRanked = dedupeRanked(ranked);
  const evaluated = uniqueRanked
    .map((candidate) =>
      evaluatePortfolioCandidate(candidate, snapshot, {
        maxInventoryAdjustmentBps: config.maxInventoryAdjustmentBps,
        inventoryEdgePremiumBps: config.inventoryEdgePremiumBps,
        maxInventoryAcquisitionLossBps:
          config.maxInventoryAcquisitionLossBps,
        allowInventoryEdges: config.allowInventoryEdges
      })
    )
    .sort((a, b) =>
      Number(b.adjustedScoreBps ?? -Infinity) -
      Number(a.adjustedScoreBps ?? -Infinity)
    );

  const selected = riskHalt
    ? []
    : planInventoryAwareBatch(uniqueRanked, snapshot, {
      maxTrades: config.maxTradesPerStep,
      maxCycleLength: config.maxCycleLength,
      maxOneWayInventoryTrades: config.maxOneWayInventoryTrades,
      minTradeValueAtomic: config.minTradeValueAtomic,
      maxInventoryAdjustmentBps: config.maxInventoryAdjustmentBps,
      inventoryEdgePremiumBps: config.inventoryEdgePremiumBps,
      maxInventoryAcquisitionLossBps:
        config.maxInventoryAcquisitionLossBps,
      allowInventoryEdges: config.allowInventoryEdges
    });

  const quoteRecord = {
    timestamp: new Date().toISOString(),
    event: "portfolio_quotes",
    step,
    refreshed,
    valuationMint: config.valuationMint,
    openingNavAtomic: openingValuation.totalValueAtomic.toString(),
    estimatedTxFeeLamports: config.estimatedTxFeeLamports.toString(),
    estimatedNetworkFeeValueAtomic:
      estimatedNetworkFeeValueAtomic.toString(),
    inventory: serializeSnapshot(snapshot),
    unpricedMints: [...openingValuation.unpricedMints],
    riskHalt,
    top: evaluated.slice(0, config.quoteTopN).map(simplifyRanked),
    selected: selected.map(simplifyRanked)
  };
  logJson(logs.execution, quoteRecord);
  logSummary(logs.summary, formatPortfolioQuotes(quoteRecord));
  console.log(formatPortfolioQuotes(quoteRecord));

  const executionPlan = await revalidateSelectedBatch({
    selected,
    graph,
    poolStateProvider,
    estimatedNetworkFeeValueAtomic,
    config,
    logs
  });

  let successfulTrades = 0;
  let attempts = 0;
  for (const candidate of executionPlan) {
    if (attempts >= config.maxExecutionAttemptsPerStep) break;
    attempts += 1;

    const result = await tryExecuteCandidate({
      candidate,
      graph,
      poolStateProvider,
      balanceProvider,
      executor,
      estimatedNetworkFeeValueAtomic,
      config,
      logs
    });
    if (result.executed) successfulTrades += 1;
  }

  let closingValuation = openingValuation;
  if (successfulTrades > 0) {
    currentSlot = await poolStateProvider.getCurrentSlot();
    await poolStateProvider.refreshAll({ currentSlot });
    currentSlot = await poolStateProvider.getCurrentSlot();
    const closingBalances = await readPortfolioBalances(
      config.portfolioMints,
      balanceProvider
    );
    closingValuation = await markPortfolioToTarget({
      graph,
      balancesByMint: closingBalances,
      targetMint: config.valuationMint,
      maxHops: config.valuationMaxHops,
      allowedTokens: config.allowedTokens,
      currentSlot,
      maxPoolSlotLag: config.maxPoolSlotLag,
      maxPoolAgeMs: config.maxPoolAgeMs,
      haircutsBpsByMint: config.haircutsBpsByMint
    });
  }

  const closingNativeLamports = BigInt(
    await connection.getBalance(wallet.publicKey, "confirmed")
  );
  const feeLamportsSpent = openingNativeLamports > closingNativeLamports
    ? openingNativeLamports - closingNativeLamports
    : 0n;
  const feeCostValueAtomic = await valueWsolAmount({
    amountAtomic: feeLamportsSpent,
    graph,
    currentSlot,
    config
  });
  const closingNavAfterFeesAtomic =
    closingValuation.totalValueAtomic > feeCostValueAtomic
      ? closingValuation.totalValueAtomic - feeCostValueAtomic
      : 0n;
  const navDeltaBps = openingValuation.totalValueAtomic > 0n
    ? bpsBetween(
      closingNavAfterFeesAtomic,
      openingValuation.totalValueAtomic
    )
    : 0;
  const doneRecord = {
    timestamp: new Date().toISOString(),
    event: successfulTrades > 0 ? "portfolio_batch_done" : "portfolio_no_trade",
    step,
    successfulTrades,
    selectedTrades: selected.length,
    revalidatedTrades: executionPlan.length,
    openingNavAtomic: openingValuation.totalValueAtomic.toString(),
    closingNavAtomic: closingValuation.totalValueAtomic.toString(),
    feeLamportsSpent: feeLamportsSpent.toString(),
    feeCostValueAtomic: feeCostValueAtomic.toString(),
    closingNavAfterFeesAtomic: closingNavAfterFeesAtomic.toString(),
    navDeltaBps,
    navIsFullyPriced: closingValuation.unpricedMints.size === 0
  };
  logJson(logs.execution, doneRecord);
  logSummary(
    logs.summary,
    `${doneRecord.timestamp} BATCH executed=${successfulTrades}/${executionPlan.length} selected=${selected.length} navDelta=${formatBps(navDeltaBps)}bps fullyPriced=${doneRecord.navIsFullyPriced}`
  );
}

async function revalidateSelectedBatch({
  selected,
  graph,
  poolStateProvider,
  estimatedNetworkFeeValueAtomic,
  config,
  logs
}) {
  const refreshedRows = [];
  for (const candidate of selected) {
    let edge = graph.getEdge(
      candidate.poolAddress,
      candidate.inputMint,
      candidate.outputMint
    );
    if (!edge) {
      rejectBeforeExecution(candidate, "edge_missing_during_batch_revalidation", logs);
      continue;
    }
    const refreshed = await poolStateProvider.refreshEdge(edge);
    if (refreshed) edge = graph.replaceEdge(refreshed);
    const currentSlot = await poolStateProvider.getCurrentSlot();
    const fresh = await rescoreExactEdge({
      edge,
      inputAmountAtomic: asBigInt(candidate.inputAmountAtomic),
      graph,
      currentSlot,
      estimatedNetworkFeeValueAtomic,
      config
    });
    if (!fresh) {
      rejectBeforeExecution(candidate, "batch_edge_not_scoreable", logs);
      continue;
    }
    const underlyingReason =
      candidate.underlyingExecutionReason ?? candidate.executionReason;
    const validation = validateFreshReason({
      underlyingReason,
      freshCandidate: fresh,
      config
    });
    if (!validation.ok) {
      rejectBeforeExecution(candidate, validation.reason, logs, validation.details);
      continue;
    }
    refreshedRows.push({
      ...candidate,
      freshBatchImmediateNetBps: fresh.immediateNetBps,
      freshBatchLiquidationNetBps: fresh.liquidationNetBps,
      freshBatchBaselineTargetValueAtomic:
        fresh.baselineTargetValueAtomic,
      freshBatchProjectedFinalTargetAtomic:
        fresh.projectedFinalTargetAtomic
    });
  }

  const byCycle = new Map();
  const independent = [];
  for (const row of refreshedRows) {
    if (!row.cycleKey) {
      independent.push(row);
      continue;
    }
    const group = byCycle.get(row.cycleKey) ?? [];
    group.push(row);
    byCycle.set(row.cycleKey, group);
  }

  const accepted = [...independent];
  for (const [cycleKey, rows] of byCycle) {
    const originallySelected = selected.filter((row) => row.cycleKey === cycleKey);
    if (rows.length !== originallySelected.length) {
      for (const row of rows) {
        rejectBeforeExecution(row, "cycle_incomplete_after_revalidation", logs);
      }
      continue;
    }

    const inputValue = rows.reduce(
      (sum, row) =>
        sum + readAtomicOrZero(row.freshBatchBaselineTargetValueAtomic),
      0n
    );
    const outputValue = rows.reduce(
      (sum, row) =>
        sum + readAtomicOrZero(row.freshBatchProjectedFinalTargetAtomic),
      0n
    );
    const cycleNetBps =
      inputValue > 0n ? bpsBetween(outputValue, inputValue) : -Infinity;
    const requiredBps = Math.max(
      ...rows.map((row) => Number(row.requiredBps ?? 0))
    );
    if (!Number.isFinite(cycleNetBps) || cycleNetBps < requiredBps) {
      for (const row of rows) {
        rejectBeforeExecution(row, "cycle_liquidation_profit_disappeared", logs, {
          cycleNetBps,
          requiredBps
        });
      }
      continue;
    }
    accepted.push(...rows.map((row) => ({ ...row, freshCycleNetBps: cycleNetBps })));
  }

  return accepted;
}

function validateFreshReason({
  underlyingReason,
  freshCandidate,
  config
}) {
  const requiredBps = Number(freshCandidate.requiredBps ?? 0);
  const immediateNetBps = Number(freshCandidate.immediateNetBps);
  const liquidationNetBps = Number(freshCandidate.liquidationNetBps);

  if (underlyingReason === "locked_profit") {
    return liquidationNetBps >= requiredBps
      ? { ok: true }
      : {
        ok: false,
        reason: "locked_profit_disappeared",
        details: { liquidationNetBps, requiredBps }
      };
  }
  if (
    underlyingReason === "inventory_edge" ||
    underlyingReason === "cycle_only_edge"
  ) {
    const floor = requiredBps + config.inventoryEdgePremiumBps;
    return immediateNetBps >= floor
      ? { ok: true }
      : {
        ok: false,
        reason: "inventory_edge_disappeared",
        details: { immediateNetBps, floor }
      };
  }
  return {
    ok: false,
    reason: "unknown_execution_reason",
    details: { underlyingReason }
  };
}

async function tryExecuteCandidate({
  candidate,
  graph,
  poolStateProvider,
  balanceProvider,
  executor,
  estimatedNetworkFeeValueAtomic,
  config,
  logs
}) {
  let edge = graph.getEdge(
    candidate.poolAddress,
    candidate.inputMint,
    candidate.outputMint
  );
  if (!edge) return { executed: false, reason: "edge_missing" };

  const refreshed = await poolStateProvider.refreshEdge(edge);
  if (refreshed) edge = graph.replaceEdge(refreshed);
  const currentSlot = await poolStateProvider.getCurrentSlot();
  const inputAmountAtomic = asBigInt(candidate.inputAmountAtomic);

  const preInputBalance = await balanceProvider.getBalance(edge.tokenInMint);
  if (preInputBalance < inputAmountAtomic) {
    return { executed: false, reason: "insufficient_input_balance" };
  }

  const freshCandidate = await rescoreExactEdge({
    edge,
    inputAmountAtomic,
    graph,
    currentSlot,
    estimatedNetworkFeeValueAtomic,
    config
  });
  if (!freshCandidate) {
    return rejectBeforeExecution(candidate, "fresh_edge_not_scoreable", logs);
  }

  const underlyingReason =
    candidate.underlyingExecutionReason ?? candidate.executionReason;
  const freshRequiredBps = Number(freshCandidate.requiredBps ?? 0);
  const freshImmediateBps = Number(freshCandidate.immediateNetBps);
  const freshLiquidationBps = Number(freshCandidate.liquidationNetBps);
  const freshNetworkFeeBps = Number(
    freshCandidate.estimatedNetworkFeeBps ?? 0
  );

  const freshValidation = validateFreshReason({
    underlyingReason,
    freshCandidate,
    config
  });
  if (!freshValidation.ok) {
    return rejectBeforeExecution(
      candidate,
      freshValidation.reason,
      logs,
      freshValidation.details
    );
  }

  const quote = await quoteEdge(edge, inputAmountAtomic);
  let minOutputAtomic = subtractBps(
    quote.outputAmountAtomic,
    config.maxSingleSwapSlippageBps
  );

  const isComparable =
    config.comparableMints.has(edge.tokenInMint) &&
    config.comparableMints.has(edge.tokenOutMint) &&
    Number.isInteger(edge.tokenInDecimals) &&
    Number.isInteger(edge.tokenOutDecimals);
  if (
    isComparable &&
    (underlyingReason === "inventory_edge" ||
      underlyingReason === "cycle_only_edge")
  ) {
    const profitFloor = minimumComparableOutputAtomic({
      inputAmountAtomic,
      inputDecimals: edge.tokenInDecimals,
      outputDecimals: edge.tokenOutDecimals,
      requiredBps:
        freshRequiredBps +
        config.inventoryEdgePremiumBps +
        freshNetworkFeeBps +
        config.priorityFeeBps +
        config.staleStateBufferBps
    });
    minOutputAtomic = bigintMax(minOutputAtomic, profitFloor);
  }

  if (minOutputAtomic > quote.outputAmountAtomic) {
    return rejectBeforeExecution(candidate, "profit_floor_above_quote", logs);
  }

  const preOutputBalance = await balanceProvider.getBalance(edge.tokenOutMint);
  const startRecord = {
    timestamp: new Date().toISOString(),
    event: "portfolio_swap_started",
    executionReason: candidate.executionReason,
    underlyingExecutionReason: underlyingReason,
    cycleKey: candidate.cycleKey ?? null,
    inputMint: edge.tokenInMint,
    outputMint: edge.tokenOutMint,
    poolAddress: edge.poolAddress,
    inputAmountAtomic: inputAmountAtomic.toString(),
    quotedOutputAtomic: quote.outputAmountAtomic.toString(),
    minOutputAtomic: minOutputAtomic.toString(),
    freshImmediateNetBps: freshImmediateBps,
    freshLiquidationNetBps: freshLiquidationBps,
    estimatedNetworkFeeBps: freshNetworkFeeBps,
    requiredBps: freshRequiredBps
  };
  logJson(logs.execution, startRecord);
  logSummary(
    logs.summary,
    `${startRecord.timestamp} FIRE ${shortMint(edge.tokenInMint)}->${shortMint(edge.tokenOutMint)} reason=${candidate.executionReason} immediate=${formatBps(freshImmediateBps)}bps liquidation=${formatBps(freshLiquidationBps)}bps in=${startRecord.inputAmountAtomic} minOut=${startRecord.minOutputAtomic} pool=${shortPool(edge.poolAddress)}`
  );

  try {
    const result = await executor.execute({
      edge,
      inputAmountAtomic,
      minOutputAtomic
    });
    const confirmed = await executor.confirm(result);
    if (!confirmed) throw new Error("swap was not confirmed");

    let actualOutputAtomic = asBigInt(result.actualOutputAtomic ?? 0n);
    if (!result.dryRun) {
      const postOutputBalance = await balanceProvider.getBalance(edge.tokenOutMint);
      actualOutputAtomic = postOutputBalance - preOutputBalance;
      if (actualOutputAtomic <= 0n) {
        throw new Error("post-trade balance check found no positive output delta");
      }
      if (actualOutputAtomic < minOutputAtomic) {
        throw new Error("post-trade output balance fell below minOutputAtomic");
      }
    }

    const realizedDirectBps = isComparable
      ? realizedComparableBps({
        inputAmountAtomic,
        outputAmountAtomic: actualOutputAtomic,
        inputDecimals: edge.tokenInDecimals,
        outputDecimals: edge.tokenOutDecimals
      })
      : null;
    const doneRecord = {
      timestamp: new Date().toISOString(),
      event: "portfolio_swap_confirmed",
      executionReason: candidate.executionReason,
      underlyingExecutionReason: underlyingReason,
      cycleKey: candidate.cycleKey ?? null,
      inputMint: edge.tokenInMint,
      outputMint: edge.tokenOutMint,
      poolAddress: edge.poolAddress,
      txSignature: result.txSignature,
      inputAmountAtomic: inputAmountAtomic.toString(),
      actualOutputAtomic: actualOutputAtomic.toString(),
      realizedDirectBps,
      freshImmediateNetBps: freshImmediateBps,
      freshLiquidationNetBps: freshLiquidationBps,
      estimatedNetworkFeeBps: freshNetworkFeeBps,
      dryRun: result.dryRun
    };
    logJson(logs.execution, doneRecord);
    logSummary(logs.executedPools, formatExecutedPool(doneRecord));
    console.log(JSON.stringify(doneRecord, jsonReplacer));
    return { executed: true, record: doneRecord };
  } catch (error) {
    const failRecord = {
      timestamp: new Date().toISOString(),
      event: "portfolio_swap_failed",
      inputMint: edge.tokenInMint,
      outputMint: edge.tokenOutMint,
      poolAddress: edge.poolAddress,
      error: error?.message ?? String(error)
    };
    logJson(logs.execution, failRecord);
    logSummary(
      logs.summary,
      `${failRecord.timestamp} FAIL ${shortMint(edge.tokenInMint)}->${shortMint(edge.tokenOutMint)} pool=${shortPool(edge.poolAddress)} ${failRecord.error}`
    );
    return { executed: false, reason: failRecord.error };
  }
}

async function rescoreExactEdge({
  edge,
  inputAmountAtomic,
  graph,
  currentSlot,
  estimatedNetworkFeeValueAtomic,
  config
}) {
  const result = await buildNextHopCandidates({
    graph,
    currentMint: edge.tokenInMint,
    currentAmountAtomic: inputAmountAtomic,
    startingTargetValueAtomic: inputAmountAtomic,
    targetMint: config.valuationMint,
    legIndex: 0,
    maxHops: config.maxHops,
    minProfitBps: config.minProfitBps,
    safetyBufferBps: config.safetyBufferBps,
    slippageBufferBps: config.slippageBufferBps,
    priorityFeeBps: config.priorityFeeBps,
    staleStateBufferBps: config.staleStateBufferBps,
    allowedTokens: config.allowedTokens,
    currentSlot,
    maxPoolSlotLag: config.maxPoolSlotLag,
    maxPoolAgeMs: config.maxPoolAgeMs,
    now: Date.now(),
    maxCandidates: config.maxCandidates,
    diagnosticsTopN: Math.max(config.quoteTopN, graph.outgoing(edge.tokenInMint).length),
    cycleMode: config.cycleMode,
    valueBaselineMode: config.valueBaselineMode,
    opportunityComparableMints: config.comparableMints
  });
  const row = result.diagnostics?.topRanked?.find(
    (candidate) =>
      candidate.poolAddress === edge.poolAddress &&
      candidate.inputMint === edge.tokenInMint &&
      candidate.outputMint === edge.tokenOutMint
  );
  return row
    ? applyEstimatedNetworkFee(
      {
        ...row,
        inputAmountAtomic
      },
      estimatedNetworkFeeValueAtomic
    )
    : null;
}

function applyEstimatedNetworkFee(candidate, feeValueAtomic) {
  const inputValueAtomic = readAtomicOrZero(
    candidate.baselineTargetValueAtomic ??
    candidate.reason?.baselineTargetValueAtomic
  );
  const feeValue = asBigInt(feeValueAtomic ?? 0n);
  const estimatedNetworkFeeBps = fixedCostBps({
    costValueAtomic: feeValue,
    inputValueAtomic
  });

  const immediateNetBps = subtractFiniteBps(
    candidate.immediateNetBps,
    estimatedNetworkFeeBps
  );
  const liquidationNetBps = subtractFiniteBps(
    candidate.liquidationNetBps,
    estimatedNetworkFeeBps
  );
  const rawProjectedFinalTargetAtomic = readAtomicOrZero(
    candidate.projectedFinalTargetAtomic
  );
  const netProjectedFinalTargetAtomic =
    rawProjectedFinalTargetAtomic > feeValue
      ? rawProjectedFinalTargetAtomic - feeValue
      : 0n;
  return {
    ...candidate,
    rawImmediateNetBps: nullableNumber(candidate.immediateNetBps),
    rawLiquidationNetBps: nullableNumber(candidate.liquidationNetBps),
    rawProjectedFinalTargetAtomic,
    projectedFinalTargetAtomic: netProjectedFinalTargetAtomic,
    estimatedNetworkFeeValueAtomic: feeValue,
    estimatedNetworkFeeBps,
    immediateNetBps,
    liquidationNetBps,
    projectedNetBps:
      candidate.scoreMode === "target_projection"
        ? liquidationNetBps
        : immediateNetBps
  };
}

function subtractFiniteBps(value, costBps) {
  const number = Number(value);
  return Number.isFinite(number) && Number.isFinite(costBps)
    ? number - costBps
    : null;
}

function readAtomicOrZero(value) {
  try {
    return asBigInt(value ?? 0n);
  } catch {
    return 0n;
  }
}

async function valueWsolAmount({
  amountAtomic,
  graph,
  currentSlot,
  config
}) {
  if (amountAtomic <= 0n) return 0n;
  const valuation = await markPortfolioToTarget({
    graph,
    balancesByMint: new Map([[WSOL, amountAtomic]]),
    targetMint: config.valuationMint,
    maxHops: config.valuationMaxHops,
    allowedTokens: config.allowedTokens,
    currentSlot,
    maxPoolSlotLag: config.maxPoolSlotLag,
    maxPoolAgeMs: config.maxPoolAgeMs,
    haircutsBpsByMint: config.haircutsBpsByMint
  });
  return valuation.valuesByMint.get(WSOL) ?? 0n;
}

async function readPortfolioBalances(mints, balanceProvider) {
  const balances = new Map();
  for (const mint of mints) {
    balances.set(mint, await balanceProvider.getBalance(mint));
  }
  return balances;
}

function chooseTradeAmount({
  mint,
  balanceAtomic,
  stableTradeAmountAtomic,
  wsolTradeAmountAtomic,
  minTradeAmountAtomic
}) {
  const cap = mint === WSOL ? wsolTradeAmountAtomic : stableTradeAmountAtomic;
  const amount = balanceAtomic < cap ? balanceAtomic : cap;
  return amount >= minTradeAmountAtomic ? amount : 0n;
}

function dedupeRanked(rows) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const key = [
      row.poolAddress,
      row.inputMint,
      row.outputMint,
      String(row.inputAmountAtomic)
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

function simplifyRanked(row) {
  return {
    pair: `${shortMint(row.inputMint)}->${shortMint(row.outputMint)}`,
    pool: row.poolAddress,
    immediateNetBps: nullableNumber(row.immediateNetBps),
    liquidationNetBps: nullableNumber(row.liquidationNetBps),
    estimatedNetworkFeeBps: nullableNumber(row.estimatedNetworkFeeBps),
    inventoryAdjustmentBps: nullableNumber(row.inventoryAdjustmentBps),
    adjustedScoreBps: nullableNumber(row.adjustedScoreBps),
    requiredBps: nullableNumber(row.requiredBps),
    accepted: row.accepted === true,
    executionReason: row.executionReason ?? null,
    blockedReason: row.blockedReason ?? null,
    inputAmountAtomic: String(row.inputAmountAtomic ?? ""),
    estimatedOutputAtomic: String(row.estimatedOutputAtomic ?? ""),
    projectedFinalTargetAtomic: String(row.projectedFinalTargetAtomic ?? ""),
    cycleKey: row.cycleKey ?? null
  };
}

function serializeSnapshot(snapshot) {
  return [...snapshot.entries.values()].map((entry) => ({
    mint: entry.mint,
    symbol: shortMint(entry.mint),
    balanceAtomic: entry.balanceAtomic.toString(),
    valueAtomic: entry.currentValueAtomic.toString(),
    targetValueAtomic: entry.targetValueAtomic.toString(),
    minValueAtomic: entry.minValueAtomic.toString(),
    maxValueAtomic: entry.maxValueAtomic.toString(),
    deviationBps: entry.deviationBps
  }));
}

function formatPortfolioQuotes(record) {
  const lines = [
    `${record.timestamp} PORTFOLIO step=${record.step} nav=${record.openingNavAtomic} ${shortMint(record.valuationMint)} selected=${record.selected.length} riskHalt=${record.riskHalt}`
  ];
  for (const item of record.inventory) {
    lines.push(
      `  INVENTORY ${item.symbol} value=${item.valueAtomic} target=${item.targetValueAtomic} band=${item.minValueAtomic}..${item.maxValueAtomic} deviation=${formatBps(item.deviationBps)}bps`
    );
  }
  for (const row of record.top.slice(0, 10)) {
    lines.push(
      `  ${row.accepted ? "ELIGIBLE" : "BLOCKED"} ${row.pair} immediate=${formatBps(row.immediateNetBps)}bps liquidation=${formatBps(row.liquidationNetBps)}bps network=${formatBps(row.estimatedNetworkFeeBps)}bps inventory=${formatBps(row.inventoryAdjustmentBps)}bps adjusted=${formatBps(row.adjustedScoreBps)}bps reason=${row.executionReason ?? row.blockedReason} pool=${shortPool(row.pool)}`
    );
  }
  for (const row of record.selected) {
    lines.push(
      `  SELECT ${row.pair} reason=${row.executionReason} amount=${row.inputAmountAtomic} pool=${shortPool(row.pool)}`
    );
  }
  return lines.join("\n");
}

function formatExecutedPool(record) {
  return [
    record.timestamp,
    "CONFIRMED",
    String(record.executionReason || "trade").toUpperCase(),
    `${shortMint(record.inputMint)}->${shortMint(record.outputMint)}`,
    `realizedDirect=${formatBps(record.realizedDirectBps)}bps`,
    `liquidation=${formatBps(record.freshLiquidationNetBps)}bps`,
    `in=${record.inputAmountAtomic}`,
    `out=${record.actualOutputAtomic}`,
    `pool=${shortPool(record.poolAddress)}`,
    `tx=${record.txSignature ?? "dry"}`
  ].join(" ");
}

function rejectBeforeExecution(candidate, reason, logs, details = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    event: "portfolio_swap_rejected",
    inputMint: candidate.inputMint,
    outputMint: candidate.outputMint,
    poolAddress: candidate.poolAddress,
    executionReason: candidate.executionReason,
    rejectReason: reason,
    ...details
  };
  logJson(logs.execution, record);
  logSummary(
    logs.summary,
    `${record.timestamp} REJECT ${shortMint(candidate.inputMint)}->${shortMint(candidate.outputMint)} reason=${reason} pool=${shortPool(candidate.poolAddress)}`
  );
  return { executed: false, reason };
}

function logJson(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record, jsonReplacer)}\n`, "utf8");
}

function logSummary(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${text}\n`, "utf8");
}

async function loadKeypair(path) {
  const contents = await readFile(path, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(contents)));
}

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || String(value).trim() === "" ? fallback : value;
}

function envNumber(name, fallback) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBigInt(name, fallback) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") return fallback;
  return BigInt(String(value));
}

function envBool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function envMintSet(name, fallback) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") {
    return new Set(fallback ? [...fallback] : []);
  }
  return new Set(
    String(value)
      .split(",")
      .map((item) => resolveMint(item.trim()))
      .filter(Boolean)
  );
}

function envMintNumberMap(name) {
  const value = process.env[name];
  const result = new Map();
  if (value === undefined || String(value).trim() === "") return result;
  for (const part of String(value).split(",")) {
    const [rawMint, rawNumber] = part.split("=").map((item) => item.trim());
    const number = Number(rawNumber);
    if (!rawMint || !Number.isFinite(number)) continue;
    result.set(resolveMint(rawMint), number);
  }
  return result;
}

function resolveMint(value) {
  return MINT_ALIASES.get(String(value).toUpperCase()) ?? String(value);
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortMint(mint) {
  const text = String(mint || "");
  for (const [symbol, address] of MINT_ALIASES) {
    if (symbol === "SOL") continue;
    if (text === address) return symbol;
  }
  return text.length > 12 ? `${text.slice(0, 6)}..${text.slice(-4)}` : text;
}

function shortPool(poolAddress) {
  const text = String(poolAddress || "");
  return text.length > 12 ? `${text.slice(0, 6)}..${text.slice(-4)}` : text;
}

function formatBps(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(3) : "n/a";
}
/*
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  
}
*/
module.exports = { runPortfolioStep };
