require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { PairGraph } = require("../src/graph.js");
const {
  buildGraphFromEnrichedPools,
  loadEnrichedPools
} = require("../src/enrichedPoolAdapter.js");
const { buildNextHopCandidates } = require("../src/frontier.js");
const { bestProjectionToTarget, quoteEdge } = require("../src/projection.js");
const { bpsBetween } = require("../src/amount.js");

const WSOL = "So11111111111111111111111111111111111111112";

async function main() {
  const args = parseArgs();
  const pools = loadEnrichedPools(args.poolFile);
  const graph = new PairGraph();
  const { allowedTokens, edgeCount, skipped } = buildGraphFromEnrichedPools(graph, pools, {
    now: Date.now(),
    currentSlot: args.currentSlot
  });

  const rows = [];
  for (const edge of graph.outgoing(args.startMint)) {
    const row = {
      pool: edge.poolAddress,
      dex: edge.dexType,
      type: edge.mathType,
      route: `${symbolFor(pools, edge.tokenInMint)} -> ${symbolFor(pools, edge.tokenOutMint)}`,
      inputMint: edge.tokenInMint,
      outputMint: edge.tokenOutMint,
      feeBps: edge.feeBps
    };

    try {
      const quote = await quoteEdge(edge, args.amountAtomic);
      row.firstOut = quote.outputAmountAtomic.toString();
      row.firstLegBps = bpsBetween(quote.outputAmountAtomic, args.amountAtomic);

      const projection = await bestProjectionToTarget({
        graph,
        fromMint: edge.tokenOutMint,
        targetMint: args.targetMint,
        amountAtomic: quote.outputAmountAtomic,
        maxHops: args.maxHops - 1,
        allowedTokens,
        excludedPools: new Set([edge.poolAddress]),
        edgeFilter: (candidate, amount) =>
          candidate.executionReady &&
          !candidate.stale &&
          !candidate.outlier &&
          !candidate.quarantined &&
          (!candidate.maxInputAtomic || BigInt(amount) <= BigInt(candidate.maxInputAtomic))
      });

      if (!projection) {
        row.status = "no_return_path";
        row.reason = `Can quote first leg, but cannot return to ${symbolFor(pools, args.targetMint)} within ${args.maxHops - 1} more hops`;
      } else {
        row.projectedFinal = projection.finalAmountAtomic.toString();
        row.projectedBps = bpsBetween(projection.finalAmountAtomic, args.startingTargetValueAtomic);
        row.pnlAtomic = (BigInt(projection.finalAmountAtomic) - args.amountAtomic).toString();
        row.pnl = BigInt(row.pnlAtomic) > 0n ? "profit" : BigInt(row.pnlAtomic) < 0n ? "loss" : "flat";
        row.suffix = projection.path.map(({ edge: suffixEdge }) =>
          `${symbolFor(pools, suffixEdge.tokenInMint)} -> ${symbolFor(pools, suffixEdge.tokenOutMint)}`
        );
        const requiredBps = args.minProfitBps + args.safetyBufferBps;
        row.status = row.projectedBps >= requiredBps ? "eligible" : "below_threshold";
        row.reason =
          row.status === "eligible"
            ? `Projected ${formatBps(row.projectedBps)} bps meets required ${formatBps(requiredBps)} bps`
            : `Projected ${formatBps(row.projectedBps)} bps is below required ${formatBps(requiredBps)} bps`;
      }
    } catch (error) {
      row.status = "quote_failed";
      row.reason = error?.message || String(error);
    }
    rows.push(row);
  }

  const candidates = await buildNextHopCandidates({
    graph,
    currentMint: args.startMint,
    currentAmountAtomic: args.amountAtomic,
    startingTargetValueAtomic: args.startingTargetValueAtomic,
    targetMint: args.targetMint,
    legIndex: 0,
    maxHops: args.maxHops,
    minProfitBps: args.minProfitBps,
    safetyBufferBps: args.safetyBufferBps,
    allowedTokens,
    currentSlot: args.currentSlot,
    maxPoolSlotLag: args.maxPoolSlotLag,
    maxPoolAgeMs: args.maxPoolAgeMs,
    now: Date.now()
  });

  rows.sort((a, b) => Number(b.projectedBps ?? -999999) - Number(a.projectedBps ?? -999999));

  const summary = {
    generatedAt: new Date().toISOString(),
    poolFile: args.poolFile,
    pools: pools.length,
    directedEdges: edgeCount,
    skippedEdges: skipped.length,
    start: symbolFor(pools, args.startMint),
    target: symbolFor(pools, args.targetMint),
    amountAtomic: args.amountAtomic.toString(),
    startingTargetValueAtomic: args.startingTargetValueAtomic.toString(),
    maxHops: args.maxHops,
    requiredBps: args.minProfitBps + args.safetyBufferBps,
    outgoingEdges: rows.length,
    eligibleCandidates: candidates.length,
    statusCounts: countBy(rows, "status"),
    quotes: rows
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(args.logOut, buildSimpleLog(summary));

  console.log(`Wrote ${args.out}`);
  console.log(`Wrote ${args.logOut}`);
  console.log({
    outgoingEdges: summary.outgoingEdges,
    eligibleCandidates: summary.eligibleCandidates,
    statusCounts: summary.statusCounts,
    best: rows[0] && {
      route: rows[0].route,
      status: rows[0].status,
      projectedBps: rows[0].projectedBps,
      reason: rows[0].reason
    }
  });
}

function parseArgs() {
  const args = {
    poolFile: process.env.POOL_FILE || "pools/wsol_stables_max5bps_no_cpmm.ready.json",
    out: "reports/wsol_quote_summary.json",
    logOut: "reports/wsol_quote_summary.simple.log",
    startMint: process.env.START_MINT || WSOL,
    targetMint: process.env.TARGET_MINT || WSOL,
    amountAtomic: BigInt(process.env.CYCLE_AMOUNT_ATOMIC || "10000000"),
    startingTargetValueAtomic: BigInt(
      process.env.STARTING_TARGET_VALUE_ATOMIC ||
      process.env.CYCLE_STARTING_TARGET_VALUE_ATOMIC ||
      process.env.CYCLE_AMOUNT_ATOMIC ||
      "10000000"
    ),
    maxHops: envNumber("MAX_HOPS", 4),
    minProfitBps: envNumber("MIN_PROFIT_BPS", 0),
    safetyBufferBps: envNumber("SAFETY_BUFFER_BPS", 0),
    maxPoolSlotLag: envNumber("MAX_POOL_SLOT_LAG", 999999),
    maxPoolAgeMs: envNumber("MAX_POOL_AGE_MS", 999999999),
    currentSlot: envNumber("CURRENT_SLOT", 100)
  };
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    const next = process.argv[i + 1];
    if ((arg === "--pool-file" || arg === "--in") && next) { args.poolFile = next; i += 1; }
    else if ((arg === "--out" || arg === "--output") && next) { args.out = next; i += 1; }
    else if (arg === "--log-out" && next) { args.logOut = next; i += 1; }
  }
  return args;
}

function envNumber(name, fallback) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function symbolFor(pools, mint) {
  if (mint === WSOL) return "WSOL";
  for (const p of pools) {
    if ((p.tokenXMint || p.baseMint) === mint) return p.tokenXSymbol || p.baseSymbol || mint.slice(0, 6);
    if ((p.tokenYMint || p.quoteMint) === mint) return p.tokenYSymbol || p.quoteSymbol || mint.slice(0, 6);
  }
  return mint.slice(0, 6);
}

function countBy(rows, key) {
  return rows.reduce((acc, row) => {
    acc[row[key]] = (acc[row[key]] || 0) + 1;
    return acc;
  }, {});
}

function formatBps(value) {
  return Number(value).toFixed(4);
}

function buildSimpleLog(summary) {
  const lines = [
    `generatedAt=${summary.generatedAt}`,
    `poolFile=${summary.poolFile}`,
    `start=${summary.start} target=${summary.target} amountAtomic=${summary.amountAtomic} startingTargetValueAtomic=${summary.startingTargetValueAtomic}`,
    `directedEdges=${summary.directedEdges} outgoingFromStart=${summary.outgoingEdges} eligibleCandidates=${summary.eligibleCandidates} maxHops=${summary.maxHops} requiredBps=${formatBps(summary.requiredBps)}`,
    `statusCounts=${JSON.stringify(summary.statusCounts)}`,
    "",
    "Top WSOL-starting routes by projected return:",
  ];

  for (const [index, quote] of summary.quotes.entries()) {
    const projected = quote.projectedBps === undefined ? "n/a" : `${formatBps(quote.projectedBps)} bps`;
    const pnlAtomic = quote.pnlAtomic === undefined ? "n/a" : quote.pnlAtomic;
    const label = quote.pnl ? quote.pnl.toUpperCase() : quote.status.toUpperCase();
    const suffix = quote.suffix?.length ? ` | closability check: ${quote.suffix.join(" + ")}` : "";
    lines.push(
      `${String(index + 1).padStart(2, "0")}. ${label.padEnd(12)} ${projected.padStart(12)} pnlAtomic=${pnlAtomic.padStart(8)} | ${quote.route} | ${quote.dex}/${quote.type} fee=${quote.feeBps ?? "?"}bps | pool=${quote.pool}${suffix}`
    );
    if (quote.status === "quote_failed" || quote.status === "no_return_path") {
      lines.push(`    reason=${quote.reason}`);
    }
  }

  lines.push("");
  lines.push(
    summary.eligibleCandidates === 0
      ? "Result: no eligible WSOL-starting route. Every quoted route is below the configured profit threshold or failed to quote."
      : `Result: ${summary.eligibleCandidates} eligible WSOL-starting route(s).`
  );

  return `${lines.join("\n")}\n`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
