const { readFileSync } = require("node:fs");
const { asBigInt } = require("./amount.js");
const { MathAdapter } = require("../math/mathAdapter.js");
const { createRequire } = require("node:module");

//const require = createRequire(import.meta.url);
//const adapter = require("../../src/enrichedPoolAdapter.js");
const { normalizePoolsArray } = require("../utilities/normalizer.cjs");
const { mergeCanonicalPool, validatePoolContract } = require("../math/poolContract.js");

function normalizePoolSet(pools = []) {
  const normalized = normalizePoolsArray(Array.isArray(pools) ? pools : []);
  return normalized.map(normalizePool).filter(Boolean);
}

function normalizePool(pool) {
  const merged = mergeCanonicalPool(pool);
  const validation = validatePoolContract(merged);
  if (!validation.valid) {
    return {
      ...merged,
      executionReady: false,
      stale: true,
      staleFlags: [
        ...(Array.isArray(merged.staleFlags) ? merged.staleFlags : []),
        `contract_missing:${validation.missing.join(",")}`
      ]
    };
  }
  return merged;
}


function loadEnrichedPools(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.pools)) return parsed.pools;
  if (Array.isArray(parsed?.data)) return parsed.data;
  throw new TypeError(`pool file ${path} must contain an array or { pools: [] }`);
}

function buildGraphFromEnrichedPools(
  graph,
  pools,
  { now = Date.now(), currentSlot = 0, mathAdapter = new MathAdapter() } = {}
) {
  const allowedTokens = new Set();
  const skipped = [];
  let edgeCount = 0;

  for (const pool of pools) {
    const tokenXMint = pool.tokenXMint || pool.baseMint || pool.mintA;
    const tokenYMint = pool.tokenYMint || pool.quoteMint || pool.mintB;
    const poolAddress = pool.poolAddress || pool.address || pool.id;

    if (!poolAddress || !tokenXMint || !tokenYMint || tokenXMint === tokenYMint) {
      skipped.push({ poolAddress: poolAddress || null, reason: "missing_pool_address_or_mints" });
      continue;
    }

    allowedTokens.add(tokenXMint);
    allowedTokens.add(tokenYMint);

    for (const [inputMint, outputMint] of [
      [tokenXMint, tokenYMint],
      [tokenYMint, tokenXMint]
    ]) {
      try {
        graph.addEdge(toDirectedEdge(pool, inputMint, outputMint, {
          now,
          currentSlot,
          mathAdapter
        }));
        edgeCount += 1;
      } catch (error) {
        skipped.push({
          poolAddress,
          inputMint,
          outputMint,
          reason: error?.message ?? String(error)
        });
      }
    }
  }

  return { allowedTokens, edgeCount, skipped };
}

function collectTokenUniverse(pools = []) {
  const tokens = new Set();
  for (const pool of pools) {
    const tokenXMint = pool.tokenXMint || pool.baseMint || pool.mintA;
    const tokenYMint = pool.tokenYMint || pool.quoteMint || pool.mintB;
    if (tokenXMint) tokens.add(tokenXMint);
    if (tokenYMint) tokens.add(tokenYMint);
  }
  return tokens;
}

function buildGraphFromPools(pools, options = {}) {
  const { PairGraph } = require("./graph.js");
  const graph = new PairGraph();
  const result = buildGraphFromEnrichedPools(graph, pools, options);
  return { graph, ...result };
}

function toDirectedEdge(
  pool,
  inputMint,
  outputMint,
  { now = Date.now(), currentSlot = 0, mathAdapter = new MathAdapter() } = {}
) {
  const tokenXMint = pool.tokenXMint || pool.baseMint || pool.mintA;
  const tokenYMint = pool.tokenYMint || pool.quoteMint || pool.mintB;
  const inputIsX = inputMint === tokenXMint;
  const inputIsY = inputMint === tokenYMint;

  if (!inputIsX && !inputIsY) {
    throw new Error(`input mint is not part of pool ${pool.poolAddress || pool.address || pool.id}`);
  }
  if (outputMint !== (inputIsX ? tokenYMint : tokenXMint)) {
    throw new Error("output mint does not match directed pool side");
  }

  const dexType = pool.dexType || pool.dex || "UNKNOWN";
  const mathType = pool.mathType || pool.type || dexType;
  const lastUpdatedSlot = Number(pool.lastUpdatedSlot ?? pool.slot ?? currentSlot ?? 0);
  const stateSequence = pool.stateSequence ?? pool.version ?? 1;

  return {
    poolAddress: pool.poolAddress || pool.address || pool.id,
    poolShape: pool,
    dexType,
    mathType,
    tokenInMint: inputMint,
    tokenOutMint: outputMint,
    tokenInDecimals: Number(inputIsX ? pool.tokenXDecimals : pool.tokenYDecimals),
    tokenOutDecimals: Number(inputIsX ? pool.tokenYDecimals : pool.tokenXDecimals),
    feeBps: Number(pool.feeBps ?? pool.feeRateBps ?? 0),
    liquidity: Number(pool.liquidity ?? pool.tvl ?? pool.tvlUsd ?? 0),
    executionReady: pool.executionReady !== false,
    stale: pool.stale === true,
    outlier: pool.outlier === true,
    quarantined: pool.quarantined === true,
    lastUpdatedSlot,
    lastHydratedAt: pool.lastHydratedAt ?? pool.hydratedAt ?? now,
    stateVersion:
      pool.stateVersion ||
      `${pool.poolAddress || pool.address || pool.id}:${lastUpdatedSlot}:${stateSequence}`,
    maxInputAtomic: inputIsX
      ? pool.maxSafeInputXAtomic ?? pool.maxInputXAtomic
      : pool.maxSafeInputYAtomic ?? pool.maxInputYAtomic,
    async quoteExactIn(amountAtomic) {
      const quote = await mathAdapter.quote({
        poolShape: pool,
        amountInAtomic: amountAtomic,
        inputMint,
        outputMint,
        slippageBps: Number(pool.slippageBps ?? process.env.SLIPPAGE_BPS ?? 4),
        swapForY: inputIsX
      });
      if (!quote.success) {
        throw new Error(`quote_failed:${quote.error || "unknown"}`);
      }
      return {
        outputAmountAtomic: asBigInt(quote.outAmountRaw, "quote output"),
        feeAtomic: 0n,
        metadata: {
          quoteModel: "mathAdapter",
          minOutAmountRaw: quote.minOutAmountRaw,
          feeBps: quote.feeBps,
          priceImpactBps: quote.priceImpactBps,
          projectedNetBps: quote.projectedNetBps,
          raw: quote.raw ?? null
        }
      };
    }
  };
}

function isCpmmLike(pool, mathType, dexType) {
  const values = [pool.mathType, pool.type, pool.dexType, dexType, mathType]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  return values.some(
    (value) =>
      value.includes("cpmm") ||
      value.includes("constant_product") ||
      value.includes("constant-product")
  );
}

function reserveOf(pool, side) {
  const reserves = pool.reserves || {};
  const raw = side === "x" ? pool.xReserve ?? reserves.x : pool.yReserve ?? reserves.y;
  return asBigInt(String(raw ?? "0").split(".")[0] || "0", `${side}Reserve`);
}

function quoteReserveExactIn({ amountAtomic, reserveIn, reserveOut, feeBps = 0 }) {
  const amount = asBigInt(amountAtomic, "amountAtomic");
  if (amount <= 0n) throw new RangeError("amountAtomic must be positive");
  if (reserveIn <= 0n || reserveOut <= 0n) throw new RangeError("reserves must be positive");
  if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps >= 10_000) {
    throw new RangeError("feeBps must be in [0, 10000)");
  }

  const feeScale = 100_000_000n;
  const scaledFeeBps = BigInt(Math.ceil(feeBps * 10_000));
  const feeAtomic = (amount * scaledFeeBps) / feeScale;
  const amountAfterFee = amount - feeAtomic;
  if (amountAfterFee <= 0n) throw new RangeError("amount after fee must be positive");

  const outputAmountAtomic = (reserveOut * amountAfterFee) / (reserveIn + amountAfterFee);
  if (outputAmountAtomic <= 0n || outputAmountAtomic >= reserveOut) {
    throw new RangeError("insufficient liquidity");
  }

  return {
    outputAmountAtomic,
    feeAtomic,
    metadata: {
      quoteModel: "reserve_cpmm"
    }
  };
}

module.exports = {
  buildGraphFromEnrichedPools,
  buildGraphFromPools,
  collectTokenUniverse,
  loadEnrichedPools,
  quoteReserveExactIn,
  isCpmmLike,
  toDirectedEdge,
  loadEnrichedPools,
  normalizePoolSet
};
