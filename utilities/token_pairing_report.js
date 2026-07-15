const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { dirname } = require("node:path");

const KNOWN_SYMBOLS = {
  So11111111111111111111111111111111111111112: "WSOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": "PYUSD",
  USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: "USD1",
  USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA: "USDS",
  Fgd8Bv4SZTvUHSfUHG6Aj12R8T4sjzsCsUsfPmBejLqU: "USDD",
  "9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u": "FDUSD",
  JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD: "JupUSD",
  jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v: "JupSOL"
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.in || "pools/raw_quality_candidates.json";
  const output = args.out || "reports/token_pairing_report.json";
  const minFeeBps = numberOr(args.maxFeeBps, Number.POSITIVE_INFINITY);
  const minTvl = numberOr(args.minTvl, 0);
  const topN = numberOr(args.top, 80);

  const pools = loadPools(input);
  const tokens = new Map();
  const pairs = new Map();

  for (const pool of pools) {
    const feeBps = Number(pool.feeBps ?? pool.feeBpsCanonical ?? pool.feeRateBps ?? 0);
    const tvl = Number(pool.tvl ?? pool.liquidity ?? pool.tvlUsd ?? 0);
    if (feeBps > minFeeBps || tvl < minTvl) continue;

    const x = pool.tokenXMint || pool.baseMint || pool.mintA;
    const y = pool.tokenYMint || pool.quoteMint || pool.mintB;
    if (!x || !y || x === y) continue;

    addToken(tokens, x, symbolFor(pool, "x", x), pool, y);
    addToken(tokens, y, symbolFor(pool, "y", y), pool, x);

    const pairKey = [x, y].sort().join("|");
    const pair = pairs.get(pairKey) || {
      pairKey,
      mints: [x, y].sort(),
      symbols: [labelFor(tokens, x), labelFor(tokens, y)].sort(),
      poolCount: 0,
      dexTypes: new Set(),
      minFeeBps: Number.POSITIVE_INFINITY,
      maxTvl: 0,
      totalTvl: 0,
      pools: []
    };
    pair.poolCount += 1;
    pair.dexTypes.add(pool.dexType || pool.dex || pool.type || "unknown");
    pair.minFeeBps = Math.min(pair.minFeeBps, feeBps);
    pair.maxTvl = Math.max(pair.maxTvl, tvl);
    pair.totalTvl += tvl;
    pair.pools.push({
      poolAddress: pool.poolAddress || pool.address || pool.id,
      dexType: pool.dexType || pool.dex || pool.type || "unknown",
      feeBps,
      tvl
    });
    pairs.set(pairKey, pair);
  }

  const tokenRows = [...tokens.entries()]
    .map(([mint, row]) => ({
      mint,
      symbol: row.symbol || shortMint(mint),
      pairCount: row.pairs.size,
      poolCount: row.poolCount,
      dexCount: row.dexTypes.size,
      lowFeePoolCount: row.lowFeePoolCount,
      maxTvl: row.maxTvl,
      totalTvl: row.totalTvl,
      commonPairs: [...row.pairs].slice(0, 20).map((pairMint) => ({
        mint: pairMint,
        symbol: labelFor(tokens, pairMint)
      }))
    }))
    .sort((a, b) =>
      b.pairCount - a.pairCount ||
      b.poolCount - a.poolCount ||
      b.maxTvl - a.maxTvl
    );

  const pairRows = [...pairs.values()]
    .map((pair) => ({
      ...pair,
      dexTypes: [...pair.dexTypes],
      minFeeBps: Number.isFinite(pair.minFeeBps) ? pair.minFeeBps : null
    }))
    .sort((a, b) =>
      b.poolCount - a.poolCount ||
      b.maxTvl - a.maxTvl ||
      a.minFeeBps - b.minFeeBps
    );

  const report = {
    input,
    filters: { maxFeeBps: minFeeBps, minTvl },
    tokenCount: tokenRows.length,
    pairCount: pairRows.length,
    topTokens: tokenRows.slice(0, topN),
    topPairs: pairRows.slice(0, topN)
  };

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`wrote ${output}`);
  for (const row of report.topTokens.slice(0, 30)) {
    console.log(
      `${row.symbol.padEnd(10)} pairs=${String(row.pairCount).padStart(3)} pools=${String(row.poolCount).padStart(3)} dex=${String(row.dexCount).padStart(2)} maxTVL=${Math.round(row.maxTvl)} ${shortMint(row.mint)}`
    );
  }
}

function addToken(tokens, mint, symbol, pool, pairMint) {
  const feeBps = Number(pool.feeBps ?? pool.feeBpsCanonical ?? pool.feeRateBps ?? 0);
  const tvl = Number(pool.tvl ?? pool.liquidity ?? pool.tvlUsd ?? 0);
  const row = tokens.get(mint) || {
    symbol: KNOWN_SYMBOLS[mint] || symbol || null,
    pairs: new Set(),
    dexTypes: new Set(),
    poolCount: 0,
    lowFeePoolCount: 0,
    maxTvl: 0,
    totalTvl: 0
  };
  if (!row.symbol && symbol) row.symbol = symbol;
  row.pairs.add(pairMint);
  row.dexTypes.add(pool.dexType || pool.dex || pool.type || "unknown");
  row.poolCount += 1;
  if (feeBps <= 5) row.lowFeePoolCount += 1;
  row.maxTvl = Math.max(row.maxTvl, tvl);
  row.totalTvl += tvl;
  tokens.set(mint, row);
}

function symbolFor(pool, side, mint) {
  if (KNOWN_SYMBOLS[mint]) return KNOWN_SYMBOLS[mint];
  if (side === "x") {
    return pool.tokenXSymbol || pool.baseSymbol || pool.tokenASymbol || pool.baseToken?.symbol || null;
  }
  return pool.tokenYSymbol || pool.quoteSymbol || pool.tokenBSymbol || pool.quoteToken?.symbol || null;
}

function labelFor(tokens, mint) {
  return tokens.get(mint)?.symbol || KNOWN_SYMBOLS[mint] || shortMint(mint);
}

function loadPools(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.pools)) return parsed.pools;
  if (Array.isArray(parsed.data)) return parsed.data;
  throw new Error(`cannot read pool array from ${path}`);
}

function shortMint(mint) {
  const text = String(mint || "");
  return text.length > 12 ? `${text.slice(0, 6)}..${text.slice(-4)}` : text;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--in") out.in = argv[++i];
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--max-fee-bps") out.maxFeeBps = argv[++i];
    else if (arg === "--min-tvl") out.minTvl = argv[++i];
    else if (arg === "--top") out.top = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

if (require.main === module) {
  main();
}
