import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Connection } from "@solana/web3.js";
import { PairGraph } from "../swap-engine/src/graph.js";
import {
  buildGraphFromEnrichedPools,
  loadEnrichedPools
} from "../swap-engine/src/enrichedPoolAdapter.js";
import { bpsBetween } from "../swap-engine/src/amount.js";
import { bestProjectionToTarget, quoteEdge } from "../swap-engine/src/projection.js";
import { LivePoolStateProvider } from "../swap-engine/src/livePoolStateProvider.js";

const require = createRequire(import.meta.url);
const { MathAdapter } = require("../math/mathAdapter.js");

const WSOL = "So11111111111111111111111111111111111111112";
const SYMBOLS = new Map([
  [WSOL, "WSOL"],
  ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC"],
  ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USDT"],
  ["USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", "USD1"],
  ["2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", "PYUSD"],
  ["USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", "USDS"],
  ["Fgd8Bv4SZTvUHSfUHG6Aj12R8T4sjzsCsUsfPmBejLqU", "USDD"],
  ["9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u", "FDUSD"]
]);

async function main() {
  const args = parseArgs();
  const rpcUrl = env("RPC_URL", env("SOLANA_RPC_URL", ""));
  if (!rpcUrl) throw new Error("RPC_URL or SOLANA_RPC_URL is required");

  const connection = new Connection(rpcUrl, "confirmed");
  const currentSlot = await connection.getSlot("confirmed");
  const pools = loadEnrichedPools(args.poolFile);
  const poolsByAddress = new Map(
    pools.map((pool) => [pool.poolAddress || pool.address || pool.id, pool])
  );
  const graph = new PairGraph();
  const mathAdapter = new MathAdapter({ connection });
  const graphResult = buildGraphFromEnrichedPools(graph, pools, {
    now: Date.now(),
    currentSlot,
    mathAdapter
  });
  const poolStateProvider = new LivePoolStateProvider({
    connection,
    poolsByAddress,
    graph,
    mathAdapter
  });

  const refreshStartedAt = Date.now();
  const refresh = args.refresh
    ? await poolStateProvider.refreshAll({ currentSlot })
    : { refreshed: 0, skipped: 0 };
  const refreshedAt = new Date().toISOString();
  const refreshedSlot = await poolStateProvider.getCurrentSlot();

  const edgeInputs = selectEdgeInputs(graph, args);
  const rows = [];
  for (const { edge, amountAtomic } of edgeInputs) {
    rows.push(await inspectEdge({
      graph,
      edge,
      amountAtomic,
      targetMint: args.targetMint,
      maxHops: args.maxHops,
      minProfitBps: args.minProfitBps,
      safetyBufferBps: args.safetyBufferBps,
      slippageBufferBps: args.slippageBufferBps,
      priorityFeeBps: args.priorityFeeBps,
      staleStateBufferBps: args.staleStateBufferBps,
      comparableMints: args.comparableMints,
      maxBranchesPerNode: args.maxBranchesPerNode
    }));
  }

  rows.sort((a, b) => {
    const bpsDelta = Number(b.projectedNetBps ?? -Infinity) -
      Number(a.projectedNetBps ?? -Infinity);
    if (bpsDelta !== 0) return bpsDelta;
    return Number(a.feeBps ?? 0) - Number(b.feeBps ?? 0);
  });

  const report = {
    generatedAt: new Date().toISOString(),
    poolFile: args.poolFile,
    refresh,
    refreshElapsedMs: Date.now() - refreshStartedAt,
    refreshedAt,
    currentSlot,
    refreshedSlot,
    directedEdges: graphResult.edgeCount,
    skippedEdges: graphResult.skipped.length,
    amountAtomic: args.amountAtomic.toString(),
    stableAmountAtomic: args.stableAmountAtomic.toString(),
    wsolAmountAtomic: args.wsolAmountAtomic.toString(),
    targetMint: args.targetMint,
    targetSymbol: sym(args.targetMint),
    maxHops: args.maxHops,
    requiredBps: args.minProfitBps + args.safetyBufferBps,
    filters: {
      poolAddress: args.poolAddress,
      inputMint: args.inputMint,
      outputMint: args.outputMint,
      allDirected: args.allDirected
    },
    rows
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(args.logOut, formatReport(report));

  console.log(formatReport(report));
  console.log(`Wrote ${args.out}`);
  console.log(`Wrote ${args.logOut}`);
}

async function inspectEdge({
  graph,
  edge,
  amountAtomic,
  targetMint,
  maxHops,
  minProfitBps,
  safetyBufferBps,
  slippageBufferBps,
  priorityFeeBps,
  staleStateBufferBps,
  comparableMints,
  maxBranchesPerNode
}) {
  const row = {
    poolAddress: edge.poolAddress,
    dexType: edge.dexType,
    mathType: edge.mathType,
    feeBps: Number(edge.feeBps ?? 0),
    inputMint: edge.tokenInMint,
    inputSymbol: sym(edge.tokenInMint),
    outputMint: edge.tokenOutMint,
    outputSymbol: sym(edge.tokenOutMint),
    inputDecimals: edge.tokenInDecimals,
    outputDecimals: edge.tokenOutDecimals,
    amountInAtomic: amountAtomic.toString(),
    quoteSource: "refreshed_onchain_state_plus_local_pool_math",
    status: "pending"
  };

  try {
    const directQuote = await quoteEdge(edge, amountAtomic);
    row.status = "quoted";
    row.directOutAtomic = directQuote.outputAmountAtomic.toString();
    row.onChainQuoteOutAtomic = row.directOutAtomic;
    row.directFeeAtomic = directQuote.feeAtomic.toString();
    row.quoteMetadata = directQuote.metadata ?? null;
    row.quotePriceImpactBps = directQuote.metadata?.priceImpactBps ??
      directQuote.metadata?.raw?.priceImpactBps ??
      null;
    row.adapterProjectedNetBps = directQuote.metadata?.projectedNetBps ??
      directQuote.metadata?.raw?.projectedNetBps ??
      null;

    const baseline = await baselineToTarget({
      graph,
      mint: edge.tokenInMint,
      amountAtomic,
      targetMint,
      maxHops,
      maxBranchesPerNode
    });
    row.baselineTargetAtomic = baseline.finalAmountAtomic.toString();
    row.baselinePath = formatPath(baseline.path);

    const projection = edge.tokenOutMint === targetMint
      ? { finalAmountAtomic: directQuote.outputAmountAtomic, path: [] }
      : await bestProjectionToTarget({
          graph,
          fromMint: edge.tokenOutMint,
          targetMint,
          amountAtomic: directQuote.outputAmountAtomic,
          maxHops: maxHops - 1,
          excludedPools: new Set([edge.poolAddress]),
          edgeFilter: usableEdge,
          maxBranchesPerNode
        });

    if (!projection) {
      row.status = "no_projection";
      row.reason = "direct quote succeeded but no target projection route was found";
      return row;
    }

    row.projectedFinalTargetAtomic = projection.finalAmountAtomic.toString();
    row.projectionOutAtomic = row.projectedFinalTargetAtomic;
    row.projectionPath = formatPath(projection.path);

    const immediateHoldBps = immediateComparableBps({
      inputMint: edge.tokenInMint,
      outputMint: edge.tokenOutMint,
      inputAmountAtomic: amountAtomic,
      outputAmountAtomic: directQuote.outputAmountAtomic,
      inputDecimals: edge.tokenInDecimals,
      outputDecimals: edge.tokenOutDecimals,
      comparableMints
    });
    row.immediateHoldBps = immediateHoldBps;
    row.projectedVsBaselineBps = bpsBetween(
      projection.finalAmountAtomic,
      baseline.finalAmountAtomic
    );
    row.scoreMode = immediateHoldBps === null ? "target_projection" : "immediate_hold";
    row.scoreBps = row.scoreMode === "immediate_hold"
      ? immediateHoldBps
      : row.projectedVsBaselineBps;
    row.projectedNetBps = row.scoreBps -
      slippageBufferBps -
      priorityFeeBps -
      staleStateBufferBps;
    row.requiredBps = minProfitBps + safetyBufferBps;
    row.fireable = row.projectedNetBps >= row.requiredBps;
    row.projectionDriftBps = immediateHoldBps === null
      ? null
      : row.projectedVsBaselineBps - immediateHoldBps;
    row.adapterVsScannerDriftBps =
      Number.isFinite(Number(row.adapterProjectedNetBps))
        ? row.projectedNetBps - Number(row.adapterProjectedNetBps)
        : null;
  } catch (error) {
    row.status = "quote_failed";
    row.reason = error?.message ?? String(error);
  }

  return row;
}

async function baselineToTarget({ graph, mint, amountAtomic, targetMint, maxHops, maxBranchesPerNode }) {
  if (mint === targetMint) return { finalAmountAtomic: amountAtomic, path: [] };
  const projection = await bestProjectionToTarget({
    graph,
    fromMint: mint,
    targetMint,
    amountAtomic,
    maxHops,
    edgeFilter: usableEdge,
    maxBranchesPerNode
  });
  return projection ?? { finalAmountAtomic: amountAtomic, path: [] };
}

function selectEdgeInputs(graph, args) {
  let edges;
  if (args.portfolioMints.size > 0) {
    edges = [...args.portfolioMints].flatMap((mint) => graph.outgoing(mint));
  } else {
    edges = args.allDirected ? graph.allEdges() : graph.outgoing(args.inputMint || WSOL);
  }
  if (args.poolAddress) {
    edges = edges.filter((edge) => edge.poolAddress === args.poolAddress);
  }
  if (args.inputMint && args.portfolioMints.size === 0) {
    edges = edges.filter((edge) => edge.tokenInMint === args.inputMint);
  }
  if (args.outputMint) {
    edges = edges.filter((edge) => edge.tokenOutMint === args.outputMint);
  }
  return edges.map((edge) => ({
    edge,
    amountAtomic: amountForMint(edge.tokenInMint, args)
  }));
}

function amountForMint(mint, args) {
  if (args.amountByMint.has(mint)) return args.amountByMint.get(mint);
  if (mint === WSOL) return args.wsolAmountAtomic;
  return args.stableAmountAtomic;
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
  if (!comparableMints.has(inputMint) || !comparableMints.has(outputMint)) return null;
  if (!Number.isInteger(inputDecimals) || !Number.isInteger(outputDecimals)) return null;
  const inputScale = 10n ** BigInt(inputDecimals);
  const outputScale = 10n ** BigInt(outputDecimals);
  const inputComparable = BigInt(inputAmountAtomic) * outputScale;
  const outputComparable = BigInt(outputAmountAtomic) * inputScale;
  return bpsBetween(outputComparable, inputComparable);
}

function usableEdge(edge, amount) {
  if (!edge.executionReady || edge.stale || edge.outlier || edge.quarantined) return false;
  if (amount !== undefined && edge.maxInputAtomic !== undefined) {
    return BigInt(amount) <= BigInt(edge.maxInputAtomic);
  }
  return true;
}

function formatReport(report) {
  const lines = [
    `${report.generatedAt} DRIFT poolFile=${report.poolFile} rows=${report.rows.length} refreshed=${report.refresh.refreshed}/${report.refresh.skipped} slot=${report.refreshedSlot} amount=${report.amountAtomic}`
  ];
  for (const row of report.rows) {
    lines.push(
      [
        `${row.inputSymbol}->${row.outputSymbol}`,
        `score=${fmt(row.projectedNetBps)}bps`,
        `required=${fmt(row.requiredBps)}bps`,
        `mode=${row.scoreMode ?? "n/a"}`,
        `quoteOut=${row.onChainQuoteOutAtomic ?? row.directOutAtomic ?? "n/a"}`,
        `projectionOut=${row.projectionOutAtomic ?? row.projectedFinalTargetAtomic ?? "n/a"}`,
        `immediate=${fmt(row.immediateHoldBps)}bps`,
        `projected=${fmt(row.projectedVsBaselineBps)}bps`,
        `driftBps=${fmt(row.projectionDriftBps)}bps`,
        `impact=${fmt(row.quotePriceImpactBps)}bps`,
        `fee=${fmt(row.feeBps)}bps`,
        `pool=${short(row.poolAddress)}`,
        row.fireable ? "FIREABLE" : row.status
      ].join(" ")
    );
    if (row.baselinePath?.length) lines.push(`  baselinePath=${row.baselinePath.join(" > ")}`);
    if (row.projectionPath?.length) lines.push(`  projectionPath=${row.projectionPath.join(" > ")}`);
    if (row.reason) lines.push(`  reason=${row.reason}`);
  }
  return lines.join("\n");
}

function formatPath(pathRows = []) {
  return pathRows.map(({ edge }) => `${sym(edge.tokenInMint)}->${sym(edge.tokenOutMint)}:${short(edge.poolAddress)}`);
}

function parseArgs() {
  const args = {
    poolFile: env("POOL_FILE", "pools/03_ROUTED.with_pyusd_jlp_peers.json"),
    poolAddress: "",
    inputMint: env("INPUT_MINT", ""),
    outputMint: env("OUTPUT_MINT", ""),
    targetMint: env("TARGET_MINT", WSOL),
    amountAtomic: BigInt(env("AMOUNT_ATOMIC", env("CYCLE_AMOUNT_ATOMIC", "10000000"))),
    stableAmountAtomic: BigInt(env("STABLE_TRADE_AMOUNT_ATOMIC", "1500000")),
    wsolAmountAtomic: BigInt(env("WSOL_TRADE_AMOUNT_ATOMIC", "10000000")),
    portfolioMints: mintSet(env("PORTFOLIO_MINTS", "")),
    amountByMint: amountMap(env("AMOUNT_BY_MINT", "")),
    maxHops: numEnv("MAX_HOPS", 4),
    maxBranchesPerNode: numEnv("MAX_BRANCHES_PER_NODE", 4),
    minProfitBps: numEnv("MIN_PROFIT_BPS", 1),
    safetyBufferBps: numEnv("SAFETY_BUFFER_BPS", 1.5),
    slippageBufferBps: numEnv("SLIPPAGE_BUFFER_BPS", 0),
    priorityFeeBps: numEnv("PRIORITY_FEE_BPS", 0),
    staleStateBufferBps: numEnv("STALE_STATE_BUFFER_BPS", 0),
    comparableMints: mintSet(env("OPPORTUNITY_COMPARABLE_MINTS", [
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
      "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"
    ].join(","))),
    refresh: !boolEnv("NO_REFRESH", false),
    allDirected: boolEnv("ALL_DIRECTED", false),
    out: env("OUT", "reports/onchain_projection_drift.json"),
    logOut: env("LOG_OUT", "reports/onchain_projection_drift.log")
  };

  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    const next = process.argv[i + 1];
    if ((arg === "--in" || arg === "--pool-file") && next) { args.poolFile = next; i += 1; }
    else if ((arg === "--pool" || arg === "--pool-address") && next) { args.poolAddress = next; i += 1; }
    else if ((arg === "--input" || arg === "--input-mint") && next) { args.inputMint = next; i += 1; }
    else if ((arg === "--output" || arg === "--output-mint") && next) { args.outputMint = next; i += 1; }
    else if ((arg === "--target" || arg === "--target-mint") && next) { args.targetMint = next; i += 1; }
    else if ((arg === "--amount" || arg === "--amount-atomic") && next) { args.amountAtomic = BigInt(next); i += 1; }
    else if (arg === "--max-branches" && next) { args.maxBranchesPerNode = Number(next) || args.maxBranchesPerNode; i += 1; }
    else if (arg === "--stable-amount" && next) { args.stableAmountAtomic = BigInt(next); i += 1; }
    else if (arg === "--wsol-amount" && next) { args.wsolAmountAtomic = BigInt(next); i += 1; }
    else if (arg === "--portfolio-mints" && next) { args.portfolioMints = mintSet(next); i += 1; }
    else if (arg === "--amount-by-mint" && next) { args.amountByMint = amountMap(next); i += 1; }
    else if (arg === "--all-directed") { args.allDirected = true; }
    else if (arg === "--no-refresh") { args.refresh = false; }
    else if (arg === "--out" && next) { args.out = next; i += 1; }
    else if (arg === "--log-out" && next) { args.logOut = next; i += 1; }
  }
  return args;
}

function mintSet(value) {
  if (!String(value).trim()) return new Set();
  return new Set(String(value).split(",").map((item) => item.trim()).filter(Boolean));
}

function amountMap(value) {
  const result = new Map();
  if (!String(value).trim()) return result;
  for (const part of String(value).split(",")) {
    const [mint, amount] = part.split(":").map((item) => item?.trim());
    if (mint && amount) result.set(mint, BigInt(amount));
  }
  return result;
}

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || String(value).trim() === "" ? fallback : value;
}

function numEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function sym(mint) {
  return SYMBOLS.get(String(mint)) ?? short(mint);
}

function short(value) {
  const text = String(value ?? "");
  return text.length > 12 ? `${text.slice(0, 6)}..${text.slice(-4)}` : text;
}

function fmt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(3) : "n/a";
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
