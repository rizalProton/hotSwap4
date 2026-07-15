require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { PairGraph } = require("../src/graph.js");
const {
  buildGraphFromEnrichedPools,
  loadEnrichedPools
} = require("../src/enrichedPoolAdapter.js");
const { quoteEdge } = require("../src/projection.js");

const WSOL = "So11111111111111111111111111111111111111112";

async function main() {
  const args = parseArgs();
  const pools = loadEnrichedPools(args.poolFile);
  const graph = new PairGraph();
  const { edgeCount, skipped } = buildGraphFromEnrichedPools(graph, pools, {
    now: Date.now(),
    currentSlot: args.currentSlot
  });

  const groups = new Map();
  for (const edge of graph.outgoing(args.currentMint)) {
    const group = groups.get(edge.tokenOutMint) || {
      inputMint: edge.tokenInMint,
      inputSymbol: symbolFor(pools, edge.tokenInMint),
      outputMint: edge.tokenOutMint,
      outputSymbol: symbolFor(pools, edge.tokenOutMint),
      quotes: []
    };

    const row = {
      pool: edge.poolAddress,
      dex: edge.dexType,
      type: edge.mathType,
      feeBps: edge.feeBps,
      divergence: divergenceInfo(edge.poolShape || {}),
      route: `${symbolFor(pools, edge.tokenInMint)} -> ${symbolFor(pools, edge.tokenOutMint)}`
    };

    try {
      const quote = await quoteEdge(edge, args.amountAtomic);
      row.status = "quoted";
      row.outputAmountAtomic = quote.outputAmountAtomic.toString();
      row.feeAtomic = quote.feeAtomic.toString();
    } catch (error) {
      row.status = "quote_failed";
      row.reason = error?.message || String(error);
    }

    group.quotes.push(row);
    groups.set(edge.tokenOutMint, group);
  }

  const grouped = [...groups.values()].map((group) => {
    const quoted = group.quotes
      .filter((quote) => quote.status === "quoted")
      .sort((a, b) => compareBigIntDesc(a.outputAmountAtomic, b.outputAmountAtomic));
    const best = quoted[0] || null;
    for (const quote of group.quotes) {
      if (quote.status !== "quoted" || !best) continue;
      quote.deltaFromBestAtomic = (
        BigInt(quote.outputAmountAtomic) - BigInt(best.outputAmountAtomic)
      ).toString();
      quote.deltaFromBestBps = bpsBetween(
        BigInt(quote.outputAmountAtomic),
        BigInt(best.outputAmountAtomic)
      );
    }
    group.quotes.sort((a, b) => {
      if (a.status !== b.status) return a.status === "quoted" ? -1 : 1;
      return compareBigIntDesc(a.outputAmountAtomic || "0", b.outputAmountAtomic || "0");
    });
    group.poolCount = group.quotes.length;
    group.quotedCount = quoted.length;
    group.failedCount = group.quotes.length - quoted.length;
    group.best = best;
    return group;
  }).sort((a, b) => {
    if (!a.best && !b.best) return a.outputSymbol.localeCompare(b.outputSymbol);
    if (!a.best) return 1;
    if (!b.best) return -1;
    return compareBigIntDesc(a.best.outputAmountAtomic, b.best.outputAmountAtomic);
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    poolFile: args.poolFile,
    inputMint: args.currentMint,
    inputSymbol: symbolFor(pools, args.currentMint),
    inputAmountAtomic: args.amountAtomic.toString(),
    directedEdges: edgeCount,
    skippedEdges: skipped.length,
    outgoingEdges: grouped.reduce((sum, group) => sum + group.poolCount, 0),
    outputGroups: grouped.length,
    groups: grouped
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(args.logOut, buildLog(summary));

  console.log(`Wrote ${args.out}`);
  console.log(`Wrote ${args.logOut}`);
  console.log({
    input: `${summary.inputSymbol} ${summary.inputAmountAtomic}`,
    outputGroups: summary.outputGroups,
    outgoingEdges: summary.outgoingEdges,
    topGroups: summary.groups.slice(0, 5).map((group) => ({
      output: group.outputSymbol,
      pools: group.poolCount,
      quoted: group.quotedCount,
      failed: group.failedCount,
      best: group.best && {
        outputAmountAtomic: group.best.outputAmountAtomic,
        pool: group.best.pool,
        dex: group.best.dex,
        feeBps: group.best.feeBps
      }
    }))
  });
}

function parseArgs() {
  const args = {
    poolFile: process.env.POOL_FILE || "pools/wsol_stables_max5bps_no_cpmm.live.json",
    currentMint: process.env.CURRENT_MINT || process.env.START_MINT || WSOL,
    amountAtomic: BigInt(process.env.CURRENT_AMOUNT_ATOMIC || process.env.CYCLE_AMOUNT_ATOMIC || "10000000"),
    currentSlot: envNumber("CURRENT_SLOT", 100),
    out: "reports/current_token_quotes.json",
    logOut: "reports/current_token_quotes.simple.log"
  };

  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    const next = process.argv[i + 1];
    if ((arg === "--pool-file" || arg === "--in") && next) { args.poolFile = next; i += 1; }
    else if ((arg === "--current-mint" || arg === "--start-mint") && next) { args.currentMint = next; i += 1; }
    else if ((arg === "--amount" || arg === "--amount-atomic") && next) { args.amountAtomic = BigInt(next); i += 1; }
    else if ((arg === "--out" || arg === "--output") && next) { args.out = next; i += 1; }
    else if (arg === "--log-out" && next) { args.logOut = next; i += 1; }
  }
  return args;
}

function buildLog(summary) {
  const lines = [
    `generatedAt=${summary.generatedAt}`,
    `poolFile=${summary.poolFile}`,
    `current=${summary.inputSymbol} mint=${summary.inputMint} amountAtomic=${summary.inputAmountAtomic}`,
    `directedEdges=${summary.directedEdges} outgoingEdges=${summary.outgoingEdges} outputGroups=${summary.outputGroups}`,
    "",
    "Opposing-pool quotes grouped by output token:"
  ];

  for (const group of summary.groups) {
    lines.push("");
    lines.push(`${summary.inputSymbol} -> ${group.outputSymbol} | pools=${group.poolCount} quoted=${group.quotedCount} failed=${group.failedCount}`);
    if (!group.best) {
      lines.push("  no quoted pools");
    }
    for (const quote of group.quotes) {
      if (quote.status === "quoted") {
        lines.push(
          `  ${quote.outputAmountAtomic.padStart(18)} out | ${String(quote.deltaFromBestBps).padStart(10)} bps_vs_best | div=${formatDivergence(quote.divergence)} | ${quote.dex}/${quote.type} fee=${quote.feeBps ?? "?"}bps | pool=${quote.pool}`
        );
      } else {
        lines.push(
          `  QUOTE_FAILED | div=${formatDivergence(quote.divergence)} | ${quote.dex}/${quote.type} fee=${quote.feeBps ?? "?"}bps | pool=${quote.pool} | ${quote.reason}`
        );
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function symbolFor(pools, mint) {
  if (mint === WSOL) return "WSOL";
  for (const p of pools) {
    if ((p.tokenXMint || p.baseMint || p.mintA) === mint) {
      return (p.tokenXSymbol || p.baseSymbol || mint.slice(0, 6)).trim();
    }
    if ((p.tokenYMint || p.quoteMint || p.mintB) === mint) {
      return (p.tokenYSymbol || p.quoteSymbol || mint.slice(0, 6)).trim();
    }
  }
  return mint.slice(0, 6);
}

function compareBigIntDesc(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a === b ? 0 : a > b ? -1 : 1;
}

function bpsBetween(value, baseline) {
  if (baseline === 0n) return 0;
  return Number(((value - baseline) * 1_000_000n) / baseline) / 100;
}

function envNumber(name, fallback) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function divergenceInfo(pool) {
  return {
    pairDivergenceBps: finiteOrNull(pool.pairDivergenceBps),
    pairMidDeviationBps: finiteOrNull(pool.pairMidDeviationBps ?? pool.midDeviationBps),
    rawDivergenceBps: finiteOrNull(pool.rawDivergenceBps),
    divergenceScore: finiteOrNull(pool.divergenceScore ?? pool.score),
    pairMidOutlier: pool.pairMidOutlier === true,
    source: pool._divergenceMeta ? "_divergenceMeta" : null
  };
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatDivergence(info = {}) {
  const parts = [];
  if (info.pairDivergenceBps !== null) parts.push(`pair=${formatNumber(info.pairDivergenceBps)}bps`);
  if (info.pairMidDeviationBps !== null) parts.push(`mid=${formatNumber(info.pairMidDeviationBps)}bps`);
  if (info.rawDivergenceBps !== null) parts.push(`raw=${formatNumber(info.rawDivergenceBps)}bps`);
  if (info.divergenceScore !== null) parts.push(`score=${formatNumber(info.divergenceScore)}`);
  if (info.pairMidOutlier) parts.push("outlier");
  return parts.length ? parts.join(",") : "n/a";
}

function formatNumber(value) {
  return Number(value).toFixed(4).replace(/\\.0+$/, "").replace(/(\\.\\d*?)0+$/, "$1");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
