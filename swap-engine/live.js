import "dotenv/config";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { PairGraph } from "./graph.js";
import { BoundedSignalQueue } from "./queue.js";
import { StatefulFrontierScanner } from "./scanner.js";
import { SwapEngine, EngineStatus } from "./engine.js";
import { JsonFileStateStore, JsonlEventStore, jsonReplacer } from "./persistence.js";
import { StructuredLogger } from "./logger.js";
import {
  buildGraphFromEnrichedPools,
  loadEnrichedPools
} from "./enrichedPoolAdapter.js";
import { LiveExecutor } from "./liveExecutor.js";
import { LivePoolStateProvider } from "./livePoolStateProvider.js";
import { WalletBalanceProvider } from "./walletBalanceProvider.js";

const WSOL = "So11111111111111111111111111111111111111112";
const DEFAULT_COMPARABLE_MINTS = [
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
  "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",
  "Fgd8Bv4SZTvUHSfUHG6Aj12R8T4sjzsCsUsfPmBejLqU",
  "9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u",
  "JuprjzYcjskJ6r7K7VwbG4U1G3G5Pk5wwvCq3TnbN1H"
];
const require = createRequire(import.meta.url);
const { MathAdapter } = require("../math/mathAdapter.js");

async function main() {
  const poolFile = env("POOL_FILE", "../pools/03_ROUTED.json");
  const rpcUrl = env("RPC_URL", env("SOLANA_RPC_URL", ""));
  const keypairPath = env("KEYPAIR_PATH", "../keyPair/solflare_keypair.json");
  if (!rpcUrl) throw new Error("RPC_URL or SOLANA_RPC_URL is required");

  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = await loadKeypair(keypairPath);
  const pools = loadEnrichedPools(poolFile);
  const graph = new PairGraph();
  const currentSlot = await connection.getSlot("confirmed");
  const mathAdapter = new MathAdapter({ connection });
  const graphResult = buildGraphFromEnrichedPools(
    graph,
    pools,
    { now: Date.now(), currentSlot, mathAdapter }
  );
  const { edgeCount, skipped } = graphResult;
  const allowedTokens = envMintSet("TOKEN_ALLOWLIST", graphResult.allowedTokens);
  const opportunityComparableMints = envMintSet(
    "OPPORTUNITY_COMPARABLE_MINTS",
    new Set(DEFAULT_COMPARABLE_MINTS)
  );
  const poolsByAddress = new Map(
    pools.map((pool) => [pool.poolAddress || pool.address || pool.id, pool])
  );

  const config = {
    startMint: env("START_MINT", WSOL),
    targetMint: env("TARGET_MINT", WSOL),
    maxHops: envNumber("MAX_HOPS", 4),
    minProfitBps: envNumber("MIN_PROFIT_BPS", 3),
    safetyBufferBps: envNumber("SAFETY_BUFFER_BPS", 1.5),
    slippageBufferBps: envNumber("SLIPPAGE_BUFFER_BPS", 0),
    priorityFeeBps: envNumber("PRIORITY_FEE_BPS", 0),
    staleStateBufferBps: envNumber("STALE_STATE_BUFFER_BPS", 0),
    maxSignalAgeMs: envNumber("MAX_SIGNAL_AGE_MS", 10_000),
    maxPoolSlotLag: envNumber("MAX_POOL_SLOT_LAG", 100_000),
    maxPoolAgeMs: envNumber("MAX_POOL_AGE_MS", 300_000),
    maxQuoteDriftBps: envNumber("MAX_QUOTE_DRIFT_BPS", 5),
    maxSingleSwapSlippageBps: envNumber("MAX_SINGLE_SWAP_SLIPPAGE_BPS", 4),
    maxIntermediateHoldMs: envNumber("MAX_INTERMEDIATE_HOLD_MS", 30_000),
    maxUnwindHops: envNumber("MAX_UNWIND_HOPS", 4),
    maxUnwindSlippageBps: envNumber("MAX_UNWIND_SLIPPAGE_BPS", 30),
    maxCandidates: envNumber("MAX_CANDIDATES", 10),
    quoteTopN: envNumber("QUOTE_TOP_N", 30),
    refreshBeforeScan: envBool("REFRESH_BEFORE_SCAN", true),
    cycleMode: env("CYCLE_MODE", "target_projection"),
    valueBaselineMode: env("VALUE_BASELINE_MODE", "current_value"),
    allowedTokens,
    opportunityComparableMints
  };

  const queue = new BoundedSignalQueue({
    capacity: envNumber("SIGNAL_QUEUE_CAPACITY", 100)
  });
  const logger = createLiveLogger(env("QUOTE_SIMPLE_LOG", "data/summary.log"));
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
    computeUnitPriceMicroLamports: envNumber("COMPUTE_UNIT_PRICE_MICRO_LAMPORTS", 0)
  });

  const scanner = new StatefulFrontierScanner({
    graph,
    queue,
    logger,
    config,
    signalStore: new JsonlEventStore(env("SIGNAL_LOG", env("EXECUTION_LOG", "data/execution.jsonl")))
  });
  const engine = new SwapEngine({
    graph,
    executor,
    poolStateProvider,
    balanceProvider,
    logger,
    stateStore: new JsonFileStateStore(env("ENGINE_STATE", "data/swap-engine-state.json")),
    eventStore: new JsonlEventStore(env("AUDIT_LOG", env("EXECUTION_LOG", "data/execution.jsonl"))),
    config
  });

  const restored = await engine.restore();
  console.log("[swap-engine/live] loaded", {
    poolFile,
    pools: pools.length,
    directedEdges: edgeCount,
    skipped: skipped.length,
    wallet: wallet.publicKey.toBase58(),
    dryRun: executor.dryRun,
    cycleMode: config.cycleMode,
    valueBaselineMode: config.valueBaselineMode,
    allowedTokens: allowedTokens.size,
    opportunityComparableMints: opportunityComparableMints.size,
    restored
  });

  if (!restored || engine.state.status === EngineStatus.IDLE_SOL) {
    const cycleAmountAtomic = BigInt(env("CYCLE_AMOUNT_ATOMIC", "10000000"));
    const available = await balanceProvider.getBalance(config.startMint);
    if (available < cycleAmountAtomic) {
      throw new Error(
        `insufficient start-token balance: required=${cycleAmountAtomic} available=${available}`
      );
    }
    await engine.startCycle({ amountAtomic: cycleAmountAtomic });
  }

  const runForever = envBool("RUN_FOREVER", false);
  const maxSteps = runForever ? Number.POSITIVE_INFINITY : envNumber("MAX_LIVE_STEPS", 1);
  const intervalMs = envNumber("LIVE_LOOP_INTERVAL_MS", 5_000);
  for (let step = 0; step < maxSteps; step += 1) {
    await runEngineStep({ engine, scanner, queue, poolStateProvider, step });
    if (step + 1 < maxSteps && intervalMs > 0) await sleep(intervalMs);
  }
}

async function runEngineStep({ engine, scanner, queue, poolStateProvider, step }) {
  let currentSlot = await poolStateProvider.getCurrentSlot();
  engine.logger.log("live_step", {
    step,
    status: engine.state.status,
    currentMint: engine.state.currentMint,
    currentAmountAtomic: engine.state.currentAmountAtomic,
    legIndex: engine.state.legIndex
  });

  if (engine.state.status === EngineStatus.WAITING_FOR_SIGNAL) {
    if (engine.config.refreshBeforeScan && typeof poolStateProvider.refreshAll === "function") {
      const refreshed = await poolStateProvider.refreshAll({ currentSlot });
      engine.logger.log("pools_refreshed_before_scan", refreshed);
      currentSlot = await poolStateProvider.getCurrentSlot();
    }

    await scanner.scan(engine.snapshot(), { currentSlot, now: Date.now() });
    const signal = queue.popBest({
      cycleId: engine.state.cycleId,
      legIndex: engine.state.legIndex,
      inputMint: engine.state.currentMint,
      now: Date.now()
    });

    if (signal) {
      await engine.processSignal(signal, { currentSlot, now: Date.now() });
    } else {
      engine.logger.log("no_signal", {
        cycleId: engine.state.cycleId,
        legIndex: engine.state.legIndex,
        currentMint: engine.state.currentMint,
        queueSize: queue.size
      });
    }
  }

  await engine.tick({ currentSlot, now: Date.now() });
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
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLiveLogger(simpleLogPath) {
  return new StructuredLogger({
    sink(line) {
      console.log(line);
      try {
        const record = JSON.parse(line);
        const simple = formatSimpleRecord(record);
        if (!simple) return;
        mkdirSync(dirname(simpleLogPath), { recursive: true });
        appendFileSync(simpleLogPath, `${simple}\n`, "utf8");
      } catch {
        // Keep logging non-fatal.
      }
    }
  });
}

function formatSimpleRecord(record) {
  if (record.event === "scanner_decision") {
    const diagnostics = record.diagnostics || {};
    const lines = [
      `${record.timestamp} QUOTES current=${shortMint(record.currentMint)} leg=${record.legIndex} candidates=${record.candidateCount} outgoing=${diagnostics.outgoing ?? 0} below=${diagnostics.belowThreshold ?? 0} failed=${diagnostics.quoteFailed ?? 0}`
    ];
    for (const row of diagnostics.topRanked || diagnostics.topBelowThreshold || []) {
      lines.push(
        `  best=${formatBps(row.projectedNetBps)}bps fee=${formatBps(row.feeBps)}bps mode=${row.scoreMode ?? "target_projection"} ${shortMint(row.inputMint)}->${shortMint(row.outputMint)} out=${row.estimatedOutputAtomic} final=${row.projectedFinalTargetAtomic} pool=${shortPool(row.poolAddress)}`
      );
    }
    for (const row of diagnostics.quoteFailures || []) {
      lines.push(
        `  fail ${shortMint(row.inputMint)}->${shortMint(row.outputMint)} pool=${shortPool(row.poolAddress)} ${row.reason}`
      );
    }
    return lines.join("\n");
  }

  if (record.event === "scanner_signal_pushed") {
    return `${record.timestamp} SIGNAL ${formatBps(record.projectedNetBps)}bps fee=${formatBps(record.feeBps)}bps mode=${record.scoreMode ?? "target_projection"} ${shortMint(record.inputMint)}->${shortMint(record.outputMint)} out=${record.estimatedOutputAtomic ?? "?"} pool=${shortPool(record.poolAddress)}`;
  }

  if (record.event === "signal_rejected") {
    return `${record.timestamp} REJECT ${record.reason} signal=${record.signalId ?? "?"} details=${JSON.stringify(record.details || {}, jsonReplacer)}`;
  }

  if (record.event === "swap_execution_started") {
    return `${record.timestamp} FIRE ${shortMint(record.inputMint)}->${shortMint(record.outputMint)} in=${record.inputAmountAtomic ?? "?"} minOut=${record.minOutputAtomic ?? "?"} pool=${shortPool(record.poolAddress)}`;
  }

  if (record.event === "inventory_transition") {
    return `${record.timestamp} HOLD ${shortMint(record.toMint)} amount=${record.amountAtomic} tx=${record.txSignature ?? "dry"}`;
  }

  return null;
}

function shortMint(mint) {
  const text = String(mint || "");
  if (text === WSOL) return "WSOL";
  if (text === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") return "USDC";
  if (text === "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB") return "USDT";
  if (text === "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB") return "USD1";
  if (text === "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo") return "PYUSD";
  if (text === "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA") return "USDS";
  if (text === "Fgd8Bv4SZTvUHSfUHG6Aj12R8T4sjzsCsUsfPmBejLqU") return "USDD";
  if (text === "9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u") return "FDUSD";
  if (text === "JuprjzYcjskJ6r7K7VwbG4U1G3G5Pk5wwvCq3TnbN1H") return "JupUSD";
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { runEngineStep };
