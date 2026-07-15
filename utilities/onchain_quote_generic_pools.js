require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { Connection } = require("@solana/web3.js");
const { PairGraph } = require("../src/graph.js");
const {
  buildGraphFromEnrichedPools,
  loadEnrichedPools
} = require("../src/enrichedPoolAdapter.js");
const { quoteEdge } = require("../src/projection.js");
const { MathAdapter } = require("../math/mathAdapter.js");
const { createPoolRefresher } = require("./refreshPoolState.js");

const WSOL = "So11111111111111111111111111111111111111112";
const SYMBOL_ALIASES = new Map([
  ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC"],
  ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USDT"],
  ["2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", "PYUSD"],
  ["USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", "USD1"],
  ["USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", "USDS"],
  ["JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD", "JupUSD"],
  ["9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u", "FDUSD"],
  ["Fgd8Bv4SZTvUHSfUHG6Aj12R8T4sjzsCsUsfPmBejLqU", "USDD"],
  ["J8kcD4Wnd1ehne1dpL8WNtgZQR6Jpui2cTZcrmg5ybAa", "J8kcD4"],
  ["D6YyAUMTJipLQfUhYs6psdnwpmMz6KbM4Qs9AtCmPpxR", "D6YyAU"]
]);

async function main() {
  const args = parseArgs();
  const rpcUrl = env("RPC_URL", env("SOLANA_RPC_URL", ""));
  if (!rpcUrl) throw new Error("RPC_URL or SOLANA_RPC_URL is required");

  const connection = new Connection(rpcUrl, "confirmed");
  const currentSlot = await connection.getSlot("confirmed");
  const pools = loadEnrichedPools(args.poolFile);

  const refresher = createPoolRefresher({ endpoints: connection });
  const refreshStartedAt = Date.now();
  await refresher.refreshInPlace(pools);
  const refreshStats = refresher.getStats?.() || {};
  stampRefreshedPools(pools, currentSlot);

  const graph = new PairGraph();
  const { edgeCount, skipped } = buildGraphFromEnrichedPools(graph, pools, {
    now: Date.now(),
    currentSlot,
    mathAdapter: new MathAdapter({ connection })
  });

  const edges = args.allDirected
    ? graph.allEdges()
    : graph.outgoing(args.currentMint);

  const rows = [];
  for (const edge of edges) {
    const startedAt = Date.now();
    const row = {
      status: "pending",
      poolAddress: edge.poolAddress,
      dexType: edge.dexType,
      mathType: edge.mathType,
      feeBps: edge.feeBps,
      inputMint: edge.tokenInMint,
      inputSymbol: symbolFor(pools, edge.tokenInMint),
      inputDecimals: decimalsForMint(pools, edge.tokenInMint),
      outputMint: edge.tokenOutMint,
      outputSymbol: symbolFor(pools, edge.tokenOutMint),
      outputDecimals: decimalsForMint(pools, edge.tokenOutMint),
      inputAmountAtomic: args.amountAtomic.toString(),
      lastUpdatedSlot: edge.lastUpdatedSlot,
      quoteSource: "onchain-refreshed-local-math"
    };

    try {
      const quote = await quoteEdge(edge, args.amountAtomic);
      row.status = "quoted";
      row.outputAmountAtomic = quote.outputAmountAtomic.toString();
      row.feeAtomic = quote.feeAtomic.toString();
      row.quoteModel = quote.metadata?.quoteModel || null;
      row.priceImpactBps = quote.metadata?.priceImpactBps ?? null;
      row.projectedNetBps = quote.metadata?.projectedNetBps ?? null;
      row.adapterQuoteSource = quote.metadata?.raw?.quoteSource || null;
    } catch (error) {
      row.status = "quote_failed";
      row.reason = error?.message || String(error);
    }

    row.elapsedMs = Date.now() - startedAt;
    rows.push(row);
  }

  const grouped = groupRows(rows, args.expectedRates);
  const summary = {
    generatedAt: new Date().toISOString(),
    poolFile: args.poolFile,
    currentSlot,
    refreshElapsedMs: Date.now() - refreshStartedAt,
    refreshStats,
    mode: args.allDirected ? "all-directed" : "current-mint-outgoing",
    currentMint: args.currentMint,
    currentSymbol: symbolFor(pools, args.currentMint),
    amountAtomic: args.amountAtomic.toString(),
    expectedRates: Object.fromEntries(args.expectedRates),
    verbose: args.verbose,
    topN: args.topN,
    pools: pools.length,
    directedEdges: edgeCount,
    skippedEdges: skipped.length,
    quoted: rows.filter((row) => row.status === "quoted").length,
    failed: rows.filter((row) => row.status !== "quoted").length,
    groups: grouped,
    rows
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(args.logOut, buildLog(summary));

  console.log(`Wrote ${args.out}`);
  console.log(`Wrote ${args.logOut}`);
  console.log({
    mode: summary.mode,
    pools: summary.pools,
    directedEdges: summary.directedEdges,
    quoted: summary.quoted,
    failed: summary.failed,
    top: summary.groups.slice(0, args.topN).map((group) => ({
      pair: group.pair,
      quoted: group.quoted,
      failed: group.failed,
      bestRate: group.bestRate,
      vsOneBps: group.vsOneBps,
      feeBps: group.best?.feeBps,
      bestOut: group.best?.outputAmountAtomic,
      bestPool: group.best?.poolAddress
    }))
  });
}

function parseArgs() {
  const args = {
    poolFile: process.env.POOL_FILE || "pools/03_ROUTED.json",
    currentMint: process.env.CURRENT_MINT || process.env.START_MINT || WSOL,
    amountAtomic: BigInt(process.env.CURRENT_AMOUNT_ATOMIC || process.env.CYCLE_AMOUNT_ATOMIC || "10000000"),
    allDirected: envBool("ALL_DIRECTED", false),
    out: "reports/onchain_generic_quotes.json",
    logOut: "reports/onchain_generic_quotes.simple.log",
    expectedRates: parseExpectedRates(process.env.EXPECTED_RATES || ""),
    verbose: envBool("QUOTE_VERBOSE", false),
    topN: envNumber("QUOTE_TOP_N", envNumber("TOP_N", 30))
  };

  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    const next = process.argv[i + 1];
    if ((arg === "--in" || arg === "--pool-file") && next) { args.poolFile = next; i += 1; }
    else if ((arg === "--current-mint" || arg === "--start-mint") && next) { args.currentMint = next; i += 1; }
    else if ((arg === "--amount" || arg === "--amount-atomic") && next) { args.amountAtomic = BigInt(next); i += 1; }
    else if (arg === "--all-directed") { args.allDirected = true; }
    else if ((arg === "--out" || arg === "--output") && next) { args.out = next; i += 1; }
    else if (arg === "--log-out" && next) { args.logOut = next; i += 1; }
    else if (arg === "--expected-rates" && next) { args.expectedRates = parseExpectedRates(next); i += 1; }
    else if ((arg === "--top-n" || arg === "--topn") && next) { args.topN = Math.max(1, Number(next) || args.topN); i += 1; }
    else if (arg === "--verbose") { args.verbose = true; }
  }

  return args;
}

function stampRefreshedPools(pools, currentSlot) {
  for (const pool of pools) {
    const poolAddress = pool.poolAddress || pool.address || pool.id;
    if (!poolAddress) continue;
    const stateSequence = pool.stateSequence ?? pool.version ?? 1;
    pool.lastUpdatedSlot = pool.hydratedSlot ?? pool.slot ?? currentSlot;
    pool.lastHydratedAt = Date.now();
    pool.stateVersion = `${poolAddress}:${pool.lastUpdatedSlot}:${stateSequence}`;
  }
}

function groupRows(rows, expectedRates = new Map()) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.inputMint}->${row.outputMint}`;
    const group = groups.get(key) || {
      pair: `${row.inputSymbol}->${row.outputSymbol}`,
      inputMint: row.inputMint,
      inputSymbol: row.inputSymbol,
      outputMint: row.outputMint,
      outputSymbol: row.outputSymbol,
      quoted: 0,
      failed: 0,
      best: null,
      rows: []
    };

    if (row.status === "quoted") {
      group.quoted += 1;
      if (
        !group.best ||
        BigInt(row.outputAmountAtomic) > BigInt(group.best.outputAmountAtomic)
      ) {
        group.best = row;
      }
    } else {
      group.failed += 1;
    }

      group.rows.push(row);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    group.inputSymbolDisplay = displaySymbol(group.inputSymbol);
    group.outputSymbolDisplay = displaySymbol(group.outputSymbol);
    group.market = `${group.outputSymbolDisplay}/${group.inputSymbolDisplay}`;
    group.direction = `${group.inputSymbolDisplay}->${group.outputSymbolDisplay}`;
    group.bestRate = group.best
      ? quoteRate({
        inputAmountAtomic: group.best.inputAmountAtomic,
        outputAmountAtomic: group.best.outputAmountAtomic,
        inputDecimals: decimalsFor(rows, group.inputMint),
        outputDecimals: decimalsFor(rows, group.outputMint)
      })
      : null;

    const expected = expectedRateFor(group, expectedRates);
    group.expectedRate = expected?.rate ?? null;
    group.expectedRateKey = expected?.key ?? null;
    group.deltaFromExpectedBps =
      group.bestRate !== null && group.expectedRate !== null
        ? bpsNumber(group.bestRate, group.expectedRate)
        : null;
    group.vsOneBps =
      group.bestRate !== null && isStableGroup(group)
        ? (group.bestRate - 1) * 10_000
        : null;
  }

  return [...groups.values()].sort((a, b) => {
    if (!a.best && !b.best) return a.pair.localeCompare(b.pair);
    if (!a.best) return 1;
    if (!b.best) return -1;
    const aStable = isStableGroup(a);
    const bStable = isStableGroup(b);
    if (aStable !== bStable) return aStable ? -1 : 1;
    const aRank = a.vsOneBps ?? Number.NEGATIVE_INFINITY;
    const bRank = b.vsOneBps ?? Number.NEGATIVE_INFINITY;
    if (aRank !== bRank) return bRank - aRank;
    return a.pair.localeCompare(b.pair);
  });
}

function buildLog(summary) {
  const lines = [
    `generatedAt=${summary.generatedAt}`,
    `poolFile=${summary.poolFile}`,
    `mode=${summary.mode}`,
    `slot=${summary.currentSlot}`,
    `amountAtomic=${summary.amountAtomic}`,
    `pools=${summary.pools} directedEdges=${summary.directedEdges} quoted=${summary.quoted} failed=${summary.failed}`,
    `refreshElapsedMs=${summary.refreshElapsedMs}`,
    "",
    "Best on-chain-refreshed quote by market:"
  ];

  for (const group of summary.groups) {
    const best = group.best;
    const rate = group.bestRate === null ? "n/a" : formatNumber(group.bestRate, 9);
    const expected = group.expectedRate === null ? "n/a" : formatNumber(group.expectedRate, 9);
    const delta = group.deltaFromExpectedBps === null ? "n/a" : `${formatSigned(group.deltaFromExpectedBps, 4)} bps`;
    const oneDelta =
      group.vsOneBps === null
        ? "n/a"
        : `${formatSigned(group.vsOneBps, 3)} bps`;
    lines.push("");
    lines.push(
      `${group.market} | bestRate=${rate} vs1=${oneDelta} expected=${expected} delta=${delta} | quoted=${group.quoted} failed=${group.failed}`
    );
    if (best) {
      lines.push(
        `  bestOutAtomic=${best.outputAmountAtomic} | ${best.dexType}/${best.mathType} fee=${best.feeBps ?? "?"}bps | pool=${best.poolAddress}`
      );
    }
    if (summary.verbose) {
      for (const row of group.rows.sort(compareRows)) {
        if (row.status === "quoted") {
          const rowRate = quoteRate({
            inputAmountAtomic: row.inputAmountAtomic,
            outputAmountAtomic: row.outputAmountAtomic,
            inputDecimals: decimalsFor(summary.rows, row.inputMint),
            outputDecimals: decimalsFor(summary.rows, row.outputMint)
          });
          lines.push(
            `  ${formatNumber(rowRate, 9).padStart(14)} rate | ${String(row.outputAmountAtomic).padStart(18)} out | ${row.dexType}/${row.mathType} fee=${row.feeBps ?? "?"}bps | model=${row.quoteModel || "?"} src=${row.adapterQuoteSource || row.quoteSource} | pool=${row.poolAddress}`
          );
        } else {
          lines.push(
            `  QUOTE_FAILED | ${row.dexType}/${row.mathType} fee=${row.feeBps ?? "?"}bps | pool=${row.poolAddress} | ${row.reason}`
          );
        }
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function parseExpectedRates(value) {
  const rates = new Map();
  for (const item of String(value || "").split(",")) {
    const [rawKey, rawRate] = item.split("=");
    if (!rawKey || rawRate === undefined) continue;
    const rate = Number(rawRate);
    if (!Number.isFinite(rate)) continue;
    rates.set(normalizePairKey(rawKey), rate);
  }
  return rates;
}

function expectedRateFor(group, expectedRates) {
  if (!expectedRates || expectedRates.size === 0) return null;
  const keys = [
    `${group.outputSymbolDisplay}/${group.inputSymbolDisplay}`,
    `${group.inputSymbolDisplay}->${group.outputSymbolDisplay}`,
    `${group.outputSymbol}/${group.inputSymbol}`,
    `${group.inputSymbol}->${group.outputSymbol}`
  ];
  for (const key of keys) {
    const normalized = normalizePairKey(key);
    if (expectedRates.has(normalized)) {
      return { key, rate: expectedRates.get(normalized) };
    }
  }
  return null;
}

function normalizePairKey(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replaceAll("WSOL", "SOL")
    .replace(/\s+/g, "");
}

function displaySymbol(symbol) {
  return String(symbol || "").trim().toUpperCase() === "WSOL" ? "SOL" : String(symbol || "").trim();
}

function isStableGroup(group) {
  return isStableSymbol(group.inputSymbolDisplay) && isStableSymbol(group.outputSymbolDisplay);
}

function isStableSymbol(symbol) {
  return new Set([
    "USDC",
    "USDT",
    "PYUSD",
    "USDD",
    "USDS",
    "USD1",
    "JUPUSD",
    "FDUSD",
    "USDV"
  ]).has(String(symbol || "").trim().toUpperCase());
}

function quoteRate({ inputAmountAtomic, outputAmountAtomic, inputDecimals, outputDecimals }) {
  const input = Number(inputAmountAtomic) / 10 ** inputDecimals;
  const output = Number(outputAmountAtomic) / 10 ** outputDecimals;
  return input > 0 ? output / input : null;
}

function decimalsFor(rows, mint) {
  const row = rows.find((candidate) => candidate.inputMint === mint);
  if (row?.inputDecimals !== undefined) return row.inputDecimals;
  const outputRow = rows.find((candidate) => candidate.outputMint === mint);
  if (outputRow?.outputDecimals !== undefined) return outputRow.outputDecimals;
  if (mint === WSOL) return 9;
  return 6;
}

function decimalsForMint(pools, mint) {
  if (mint === WSOL) return 9;
  for (const pool of pools) {
    if ((pool.tokenXMint || pool.baseMint || pool.mintA) === mint) {
      return Number(pool.tokenXDecimals ?? pool.baseDecimals ?? pool.decimalsX ?? pool.mintADecimals ?? 6);
    }
    if ((pool.tokenYMint || pool.quoteMint || pool.mintB) === mint) {
      return Number(pool.tokenYDecimals ?? pool.quoteDecimals ?? pool.decimalsY ?? pool.mintBDecimals ?? 6);
    }
  }
  return 6;
}

function bpsNumber(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0) return null;
  return ((value - baseline) / baseline) * 10_000;
}

function formatSigned(value, decimals = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "n/a";
  return `${number >= 0 ? "+" : ""}${number.toFixed(decimals)}`;
}

function formatNumber(value, decimals = 9) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "n/a";
  return number.toFixed(decimals).replace(/\.?0+$/, "");
}

function compareRows(a, b) {
  if (a.status !== b.status) return a.status === "quoted" ? -1 : 1;
  const ao = BigInt(a.outputAmountAtomic || "0");
  const bo = BigInt(b.outputAmountAtomic || "0");
  return ao === bo ? String(a.poolAddress).localeCompare(String(b.poolAddress)) : ao > bo ? -1 : 1;
}

function symbolFor(pools, mint) {
  if (mint === WSOL) return "WSOL";
  if (SYMBOL_ALIASES.has(mint)) return SYMBOL_ALIASES.get(mint);
  for (const pool of pools) {
    if ((pool.tokenXMint || pool.baseMint || pool.mintA) === mint) {
      return String(pool.tokenXSymbol || pool.baseSymbol || mint.slice(0, 6)).trim();
    }
    if ((pool.tokenYMint || pool.quoteMint || pool.mintB) === mint) {
      return String(pool.tokenYSymbol || pool.quoteSymbol || mint.slice(0, 6)).trim();
    }
  }
  return String(mint).slice(0, 6);
}

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || String(value).trim() === "" ? fallback : value;
}

function envBool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function envNumber(name, fallback) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
