#!/usr/bin/env node
'use strict';

/**
 * Diagnose pool composition and per-math-type readiness.
 *
 * Usage:
 *   node utilities/_diagnose_pools2.js 00_RAWout.json --out 00_RAWready.json
 *   node utilities/_diagnose_pools.js pools/00_POOLFETCH.json --minLiquidity 10000
 *   node utilities/_diagnose_pools.js pools/00_POOLFETCH.json --out pools/diagnose_pools.json
 */

const fs = require('fs');
const path = require('path');
const { getSymbolFromMint } = require('./symbolDisplay');

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeTextList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim()) return value.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

const POOL_TYPES = [
  'clmm',
  'cpmm',
  'dlmm',
  'whirlpool',
  'damm_v2',
  'pancakeswap',
  'pumpswap',
  'unknown',
];

function short(value) {
  const text = String(value || '');
  return text.length > 14 ? `${text.slice(0, 6)}...${text.slice(-4)}` : (text || '?');
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toPositiveBigInt(value) {
  try {
    const text = String(value ?? '0').trim();
    const whole = text.includes('.') ? text.split('.')[0] : text;
    return BigInt(whole || '0') > 0n;
  } catch (_) {
    return false;
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function cleanSymbol(value) {
  const text = String(value || '').trim();
  return text && text !== 'null' && text !== 'undefined' ? text : null;
}

function mintValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return String(
      value.mint
      || value.address
      || value.pubkey
      || value.id
      || value.tokenMint
      || '',
    ).trim();
  }
  return String(value || '').trim();
}

function arrayLength(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value.length;
  }
  return 0;
}

function poolAddress(pool = {}) {
  return String(pool.poolAddress || pool.address || pool.pubkey || pool.id || '').trim();
}

function baseMint(pool = {}) {
  return mintValue(pool.baseMint || pool.tokenXMint || pool.mintA || pool.tokenAMint || pool.tokenA);
}

function quoteMint(pool = {}) {
  return mintValue(pool.quoteMint || pool.tokenYMint || pool.mintB || pool.tokenBMint || pool.tokenB);
}

function baseSymbol(pool = {}) {
  return cleanSymbol(firstDefined(
    pool.baseSymbol,
    pool.tokenXSymbol,
    pool.tokenASymbol,
    pool.tokenA?.symbol,
    pool.mintA?.symbol,
    getSymbolFromMint(baseMint(pool)),
  ));
}

function quoteSymbol(pool = {}) {
  return cleanSymbol(firstDefined(
    pool.quoteSymbol,
    pool.tokenYSymbol,
    pool.tokenBSymbol,
    pool.tokenB?.symbol,
    pool.mintB?.symbol,
    getSymbolFromMint(quoteMint(pool)),
  ));
}

function pairSymbol(pool = {}) {
  const base = baseSymbol(pool) || short(baseMint(pool));
  const quote = quoteSymbol(pool) || short(quoteMint(pool));
  return `${base}/${quote}`;
}

function tvlUsd(pool = {}) {
  return toNumber(pool.tvlUsd ?? pool.tvl ?? pool.liquidityUsd ?? pool.liquidity ?? pool.totalLiquidityUsd, 0);
}

function hasSol(pool = {}) {
  return baseMint(pool) === SOL || quoteMint(pool) === SOL;
}

function hasUsdc(pool = {}) {
  return baseMint(pool) === USDC || quoteMint(pool) === USDC;
}

function isSolUsdc(pool = {}) {
  const a = baseMint(pool);
  const b = quoteMint(pool);
  return (a === SOL && b === USDC) || (a === USDC && b === SOL);
}

function hasPositiveReserves(pool = {}) {
  const x = firstDefined(
    pool.xReserve,
    pool.reserveX,
    pool.baseReserve,
    pool.reserve0,
    pool.reserves?.x,
    pool.reserve_x_amount,
    pool.tokenAAmount,
  );
  const y = firstDefined(
    pool.yReserve,
    pool.reserveY,
    pool.quoteReserve,
    pool.reserve1,
    pool.reserves?.y,
    pool.reserve_y_amount,
    pool.tokenBAmount,
  );
  return toPositiveBigInt(x) && toPositiveBigInt(y);
}

function hasPriceSignal(pool = {}) {
  return toNumber(firstDefined(pool.currentPrice, pool.price, pool.midPrice), 0) > 0
    || toNumber(firstDefined(pool.sqrtPriceX64, pool.sqrtPrice), 0) > 0;
}

const hasPriceState = hasPriceSignal;

function hasTick(pool = {}) {
  return firstDefined(
    pool.tickCurrent,
    pool.currentTick,
    pool.currentTickIndex,
    pool.tickCurrentIndex,
    pool.tick,
    pool?.state?.tickCurrent,
  ) !== undefined;
}

function tickArrayCount(pool = {}) {
  return arrayLength(
    pool.tickArrays,
    pool.tickArrayData,
    pool.remainingAccounts,
    pool?.aux?.clmm?.tickArrayData,
    pool?.aux?.whirlpool?.tickArrays,
  );
}

function decodedTickArrayCount(pool = {}) {
  const candidates = [
    pool.tickArrayData,
    pool?.aux?.clmm?.tickArrayData,
    pool?.aux?.whirlpool?.tickArrayData,
    pool?.aux?.whirlpool?.tickArrays,
    pool.tickArrays,
  ];
  for (const value of candidates) {
    if (!Array.isArray(value)) continue;
    const count = value.filter((entry) => (
      entry
      && typeof entry === 'object'
      && (Array.isArray(entry.ticks) || Array.isArray(entry.data?.ticks))
    )).length;
    if (count > 0) return count;
  }
  return 0;
}

function binArrayCount(pool = {}) {
  return arrayLength(pool.binArrays, pool.binArrayData, pool?.aux?.dlmm?.binArrays);
}

function binCount(pool = {}) {
  return arrayLength(pool.bins, pool?.aux?.dlmm?.bins);
}

function hasBinStep(pool = {}) {
  return toNumber(firstDefined(pool.binStep, pool.bin_step, pool?.aux?.dlmm?.binStep), 0) > 0;
}
function tokenLabel(mint, pool) {
  if (mint === pool.tokenXMint) return pool.baseSymbol || pool.tokenXSymbol || mint;
  if (mint === pool.tokenYMint) return pool.quoteSymbol || pool.tokenYSymbol || mint;
  return mint;
}

function getPoolAddress(pool = {}) {
  return String(pool.poolAddress || pool.address || pool.id || '').trim();
}

/**
 * Single source of truth for display/protocol/math labels.
 *
 * Keep adapter-facing math type in `type` for legacy adapters.
 * Use `mathType` for reports.
 * Use `protocol`/`dexType` for display.
 */
function classifyPool(pool = {}) {
  const raw = [
    pool?.mathType,
    pool?.type,
    pool?.poolType,
    pool?.dexType,
    pool?.dex,
    pool?.protocol,
    pool?.source,
    pool?.quoteSource,
    pool?.programId,
    pool?.label,
    pool?.name,
    pool?._raw?.mathType,
    pool?._raw?.type,
    pool?._raw?.poolType,
    pool?._raw?.dexType,
    pool?._raw?.dex,
    pool?._raw?.protocol,
    pool?.normalized?.mathType,
    pool?.normalized?.type,
    pool?.normalized?.poolType,
    pool?.normalized?.dexType,
  ].map((value) => String(value || '').toLowerCase()).join('|');

  let mathType = String(pool?.mathType || pool?.type || pool?.poolType || '').toLowerCase();
  if (mathType === 'unknown' || mathType === 'unk') mathType = '';

  if (
    raw.includes('pancakeswap')
    || raw.includes('pancake')
    || raw.includes('pancakeswap_amm')
    || raw.includes('pancakeswap-amm')
  ) {
    mathType = 'pancakeswap';
  } else if (
    raw.includes('pumpswap')
    || raw.includes('pump_swap')
    || raw.includes('pumpswap_cpmm')
    || raw.includes('pumpswap-cpmm')
  ) {
    mathType = 'pumpswap';
  }

  if (!mathType) {
    if (raw.includes('dlmm') || raw.includes('meteora_dlmm')) mathType = 'dlmm';
    else if (
      raw.includes('damm_v2')
      || raw.includes('damm-v2')
      || raw.includes('dammv2')
      || raw.includes('meteora_damm_v2')
      || raw.includes('meteora-damm-v2')
      || raw.includes('meteora_damm')
      || raw.includes('dynamic_amm_v2')
      || raw.includes('dynamic-amm-v2')
    ) mathType = 'damm_v2';
    else if (raw.includes('whirlpool') || raw.includes('orca_whirlpool')) mathType = 'whirlpool';
    else if (raw.includes('clmm')) mathType = 'clmm';
    else if (
      raw.includes('cpmm')
      || raw.includes('amm')
    ) mathType = 'cpmm';
    else mathType = String(pool?.type || pool?.poolType || '').toLowerCase() || 'unknown';
  }

  const dexType = String(
    pool?.dexType
    || (mathType === 'pancakeswap' ? 'PANCAKESWAP_AMM' : null)
    || (mathType === 'pumpswap' ? 'PUMPSWAP_CPMM' : null)
    || (mathType === 'damm_v2' ? 'METEORA_DAMM_V2' : null)
    || pool?.protocol
    || pool?.dex
    || pool?.source
    || 'UNKNOWN'
  ).toUpperCase();
  const protocol = String(
    pool?.protocol
    || (mathType === 'pancakeswap' ? 'PANCAKESWAP_AMM' : null)
    || (mathType === 'pumpswap' ? 'PUMPSWAP_CPMM' : null)
    || (mathType === 'damm_v2' ? 'METEORA_DAMM_V2' : null)
    || pool?.dexType
    || pool?.dex
    || pool?.source
    || 'unknown'
  );

  return {
    mathType,
    type: mathType, // legacy field expected by existing adapters/validators
    dexType,
    protocol,
    dex: pool?.dex || protocol.toLowerCase(),
  };
}

function getPoolAddress(pool = {}) {
  return String(pool.poolAddress || pool.address || pool.id || '').trim();
}

function getPoolType(pool = {}) {
  return classifyPool(pool).mathType;
}

function getPoolDexType(pool = {}) {
  return classifyPool(pool).dexType;
}

function getPoolDex(pool = {}) {
  return classifyPool(pool).dex;
}

function getPoolMints(pool = {}) {
  const tokenXMint = String(
    pool.tokenXMint
    || pool.baseMint
    || pool.mintA
    || pool.tokenMintA
    || pool.tokenA?.mint
    || pool.tokenA
    || ''
  );

  const tokenYMint = String(
    pool.tokenYMint
    || pool.quoteMint
    || pool.mintB
    || pool.tokenMintB
    || pool.tokenB?.mint
    || pool.tokenB
    || ''
  );

  return { tokenXMint, tokenYMint };
}

function getPoolDecimals(pool = {}) {
  return {
    tokenXDecimals: toFiniteNumber(
      pool.tokenXDecimals
      ?? pool.baseDecimals
      ?? pool.decimalsA
      ?? pool.tokenA?.decimals,
      0,
    ),
    tokenYDecimals: toFiniteNumber(
      pool.tokenYDecimals
      ?? pool.quoteDecimals
      ?? pool.decimalsB
      ?? pool.tokenB?.decimals,
      0,
    ),
  };
}

function getPoolSymbols(pool = {}) {
  return {
    tokenXSymbol: pool.tokenXSymbol || pool.baseSymbol || pool.tokenA?.symbol || null,
    tokenYSymbol: pool.tokenYSymbol || pool.quoteSymbol || pool.tokenB?.symbol || null,
  };
}

function toBigIntSafe(value, fallback = 0n) {
  try {
    if (typeof value === 'bigint') return value;
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return fallback;
      return BigInt(Math.trunc(value));
    }
    const text = String(value).trim();
    if (!text) return fallback;
    if (text.includes('.') || text.includes('e') || text.includes('E')) {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) return fallback;
      return BigInt(Math.trunc(parsed));
    }
    return BigInt(text);
  } catch (_error) {
    return fallback;
  }
}



function getPoolTypeCharacteristics() {
  return {
    'AMM V4': {
      type: 'Constant Product',
      formula: 'x * y = k',
      slippage: 'Linear with trade size',
      bestFor: 'Large trades, high liquidity pairs',
      feeTiers: ['0.25%']
    },
    'CLMM': {
      type: 'Concentrated Liquidity',
      formula: 'Uniswap V3 style',
      slippage: 'Low in active range, high outside',
      bestFor: 'Stable pairs, range-bound trading',
      feeTiers: ['0.01%', '0.04%', '0.25%', '1%']
    },
    'CPMM': {
      type: 'Constant Product (New)',
      formula: 'x * y = k',
      slippage: 'Linear with trade size',
      bestFor: 'Token-2022 assets, new pairs',
      feeTiers: ['Variable']
    },
    'StableSwap': {
      type: 'Curve-style Stable',
      formula: 'Stable invariant',
      slippage: 'Very low for pegged assets',
      bestFor: 'Stablecoin swaps, pegged assets',
      feeTiers: ['0.01%', '0.04%']
    },
    'DLMM': {
      type: 'Dynamic Liquidity (Bins)',
      formula: 'Bin-based pricing',
      slippage: 'Zero within bins, stepped',
      bestFor: 'Volatile pairs, dynamic fees',
      feeTiers: ['Dynamic (0.01% - 1%+)']
    },
    'DAMM': {
      type: 'Multi-token Dynamic',
      formula: 'Weighted invariant',
      slippage: 'Variable by weight',
      bestFor: 'Multi-asset pools, baskets',
      feeTiers: ['Variable']
    }
  };
}


function normalizeType(pool = {}) {
  const dex = String(pool.dex || pool.source || pool.protocol || '').toLowerCase();
  const dexType = String(pool.dexType || pool.poolType || '').toLowerCase();
  const type = String(pool.type || pool.mathType || '').toLowerCase();
  const combined = `${dex} ${dexType} ${type}`;

  if (combined.includes('pancake')) return 'pancakeswap';
  if (combined.includes('pump')) return 'pumpswap';
  if (combined.includes('damm_v2') || combined.includes('dammv2') || combined.includes('damm v2')) return 'dammv2';
  if (combined.includes('dlmm')) return 'dlmm';
  if (combined.includes('whirlpool') || combined.includes('orca')) return 'whirlpool';
  if (combined.includes('clmm') || combined.includes('concentrated')) return 'clmm';
  if (combined.includes('cpmm') || combined.includes('amm') || dex.includes('raydium')) return 'cpmm';
  return 'unknown';
}

function readinessForPool(pool = {}) {
  const type = normalizeType(pool);
  const missing = [];
  const warnings = [];

  if (!poolAddress(pool)) missing.push('poolAddress');
  if (!baseMint(pool)) missing.push('baseMint/tokenXMint');
  if (!quoteMint(pool)) missing.push('quoteMint/tokenYMint');

  if (type === 'dlmm') {
    if (!hasBinStep(pool)) missing.push('binStep');
    if (binCount(pool) === 0 && binArrayCount(pool) === 0) missing.push('bins/binArrays');
    if (firstDefined(pool.activeBinId, pool.activeId, pool.active_bin_id) === undefined) warnings.push('missing activeBinId');
  } else if (type === 'clmm') {
    if (!hasTick(pool)) missing.push('tick/currentTick');
    if (decodedTickArrayCount(pool) === 0) missing.push('decoded tickArrays/tickArrayData');
    if (!hasPriceSignal(pool)) warnings.push('missing sqrtPriceX64/currentPrice');
  } else if (type === 'whirlpool') {
    if (!hasTick(pool)) missing.push('tick/currentTick');
    if (decodedTickArrayCount(pool) === 0) missing.push('decoded tickArrays/tickArrayData');
    if (!hasPriceSignal(pool)) warnings.push('missing sqrtPriceX64/currentPrice');
  } else if (type === 'cpmm' || type === 'pancakeswap' || type === 'pumpswap') {
    if (!hasPositiveReserves(pool)) missing.push('xReserve/yReserve');
    if (!hasPriceSignal(pool)) warnings.push('missing price signal; reserve math can still quote');
  } else if (type === 'damm_v2') {
    if (!hasPositiveReserves(pool) && !hasPriceSignal(pool)) missing.push('reserves or sqrt/currentPrice');
    if (hasPositiveReserves(pool) && !hasPriceSignal(pool)) warnings.push('reserve-only DAMM v2 quote is diagnostic');
  } else {
    if (!hasPositiveReserves(pool) && !hasPriceSignal(pool)) missing.push('reserves or price signal');
  }

  return {
    type,
    mathReady: missing.length === 0,
    missing,
    warnings,
    facts: {
      tvlUsd: tvlUsd(pool),
      hasReserves: hasPositiveReserves(pool),
      hasTick: hasTick(pool),
      tickArrayCount: tickArrayCount(pool),
      hasBinStep: hasBinStep(pool),
      binCount: binCount(pool),
      binArrayCount: binArrayCount(pool),
      hasPriceSignal: hasPriceSignal(pool),
    },
  };
}


function samePathMaybe(left, right) {
  if (!left || !right) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function loadPools(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.pools)) return raw.pools;
  if (Array.isArray(raw.data)) return raw.data;
  if (raw.routePrep && Array.isArray(raw.routePrep.pools)) return raw.routePrep.pools;
  if (raw.runtime && Array.isArray(raw.runtime.pools)) return raw.runtime.pools;
  if (Array.isArray(raw.filteredPools)) return raw.filteredPools;
  if (Array.isArray(raw.exportPools)) return raw.exportPools;
  return [];
}


function checkHydrationCompleteness(quote = {}, mathType = '') {
  const type = mathType || classifyPool(quote).mathType || '';
  const missing = [];

  if (type === 'dlmm') {
    if (normalizeTextList(quote.binArrays).length === 0 && !(Array.isArray(quote.bins) && quote.bins.length > 0)) missing.push('binArrays');
  } else if (type === 'clmm' || type === 'whirlpool') {
    if (decodedTickArrayCount(quote) === 0) missing.push('decoded tickArrays/tickArrayData');
    if (!hasPriceSignal(quote)) missing.push('sqrtPriceX64/currentPrice');
  } else if (type === 'cpmm' || type === 'pancakeswap' || type === 'pumpswap') {
    if (!hasPositiveReserves(quote)) missing.push('xReserve/yReserve');
  } else if (type === 'damm_v2') {
    if (!hasPositiveReserves(quote) && !hasPriceSignal(quote)) missing.push('reserves or sqrtPrice');
  }

  return { complete: missing.length === 0, missing };
}

function classifyQuoteExecutionQuality(quote = {}) {
  const { mathType, dexType } = classifyPool(quote);
  const quoteSource = String(quote.quoteSource || '').toLowerCase();
  const tickStrategy = String(quote.tickStrategy || '').toLowerCase();
  const tickArrays = normalizeTextList(quote.tickArrays);
  const decodedTickArrays = decodedTickArrayCount(quote);
  const binArrays = normalizeTextList(quote.binArrays);
  const bins = Array.isArray(quote.bins) ? quote.bins : [];
  const reserveBacked = hasPositiveReserves(quote);
  const priceBacked = hasPriceState(quote);
  const liquidity = toBigIntSafe(quote.liquidity ?? 0);
  const currentPrice = toFiniteNumber(quote.currentPrice ?? quote._raw?.current_price ?? quote._raw?.price, 0);

  let executable = false;
  let reason = 'Unsupported quote source';

  if (mathType === 'cpmm' || mathType === 'pancakeswap' || mathType === 'pumpswap') {
    // Chain-accurate sources only. 'native-reserves' (raw vault) is NOT accurate
    // for Raydium AMM v4: true reserve is vault + openOrders − needTakePnl, so a
    // raw-vault quote sets an unreachable minOut and execution reverts with
    // Custom:30. Demote it (and the bare reserve/price-backed estimates) to
    // diagnostic-only; require a live/SDK curve quote to execute.
    const allowNativeReservesExec = ['1', 'true', 'yes'].includes(
      String(process.env.ALLOW_NATIVE_RESERVES_EXEC || '').toLowerCase()
    );
    executable = (
      quoteSource === 'sdk'
      || quoteSource === 'custom-provider'
      || quoteSource === 'rpc-live'
      || (allowNativeReservesExec && (
        quoteSource === 'native-reserves'
        || quoteSource.includes('reserves')
        || reserveBacked
        || priceBacked
      ))
    );
    reason = executable
      ? `${dexType || mathType.toUpperCase()} quote accepted`
      : `${dexType || mathType.toUpperCase()} quote not execution-grade: needs live/SDK curve quote (native-reserves raw-vault is not chain-accurate for AMM v4 → Custom:30; set ALLOW_NATIVE_RESERVES_EXEC=true only for diagnostics)`;
  } else if (mathType === 'clmm') {
    executable = (
      quoteSource === 'sdk'
      || quoteSource === 'custom-provider'
      || (
        quoteSource === 'rpc-live'
        && tickStrategy !== 'adapter-approximation'
        && decodedTickArrays > 0
        && (reserveBacked || liquidity > 0n || priceBacked)
      )
    );
    reason = executable
      ? 'CLMM quote accepted'
      : 'CLMM quote missing executable tick state';
  } else if (mathType === 'whirlpool') {
    executable = (
      quoteSource === 'sdk'
      || quoteSource === 'custom-provider'
      || (
        quoteSource === 'rpc-live'
        && tickStrategy !== 'adapter-approximation'
        && decodedTickArrays > 0
        && (reserveBacked || liquidity > 0n || priceBacked)
      )
    );
    reason = executable
      ? 'Whirlpool quote accepted'
      : 'Whirlpool quote missing executable tick state';
  } else if (mathType === 'dlmm') {
    executable = (
      quoteSource === 'sdk'
      || quoteSource === 'sdk-fast'
      || quoteSource === 'custom-provider'
      || quoteSource === 'rpc-live'
      || quoteSource.includes('dlmm')
      || quoteSource.includes('local-bins')
    ) && (binArrays.length > 0 || bins.length > 0 || currentPrice > 0 || priceBacked);
    reason = executable
      ? 'DLMM quote accepted'
      : 'DLMM quote missing bin-aware executable state';
  } else if (mathType === 'damm_v2') {
    const allowStatePriceDammV2 = ['1', 'true', 'yes'].includes(String(process.env.DAMMV2_ALLOW_STATE_PRICE_EXEC || '').toLowerCase());
    executable = (
      quoteSource === 'custom-provider'
      || quoteSource === 'sdk'
      || quoteSource === 'rpc-live'
      || quoteSource.includes('sdk')
      || quoteSource.includes('dammv2')
      || quoteSource.includes('damm_v2')
      || (allowStatePriceDammV2 && quoteSource === 'state-price')
    ) && (
      priceBacked
      || currentPrice > 0
      || quoteSource === 'custom-provider'
      || quoteSource === 'sdk'
      || quoteSource.includes('sdk')
      || quoteSource.includes('dammv2')
      || quoteSource.includes('damm_v2')
    );
    reason = executable
      ? 'DAMM v2 quote accepted'
      : 'DAMM v2 quote requires SDK/custom-provider curve quote; state-price/native-reserves are diagnostic-only';
  } else {
    executable = false;
    reason = `Unsupported pool math type: ${mathType || 'unknown'}`;
  }

  // Hydration gate: a leg that passed the math check is still NOT execution-grade if
  // the on-chain accounts / canonical scalars were dropped. Demote (never promote) and
  // emit a precise reason so the discrepancy report stops saying "gate_rejection: other".
  const hydration = checkHydrationCompleteness(quote, mathType);
  if (executable && !hydration.complete) {
    executable = false;
    reason = `${dexType || mathType.toUpperCase()} not execution-ready: missing ${hydration.missing.join(',')}`;
  }

  // Cached depth-probe verdict (out-of-band). depthStale means realized price diverged
  // from the canonical mid beyond threshold at the reference size — demote it too.
  if (executable && quote.depthStale === true) {
    executable = false;
    reason = `${dexType || mathType.toUpperCase()} depth-stale: probe gap ${toFiniteNumber(quote.depthGapBps, 0).toFixed(1)}bps`;
  }

  return {
    executable,
    qualityTier: executable ? 'execution-grade' : 'diagnostic-only',
    gateReason: reason,
    quoteSource: quoteSource || null,
    tickStrategy: tickStrategy || null,
    reserveBacked,
    priceBacked,
    tickArrayCount: tickArrays.length,
    decodedTickArrayCount: decodedTickArrays,
    binArrayCount: binArrays.length,
    binCount: bins.length,
    hydrationComplete: hydration.complete,
    hydrationMissing: hydration.missing,
  };
}

function toReserveBigInt(...values) {
  for (const value of values) {
    const parsed = toBigIntSafe(value, 0n);
    if (parsed > 0n) return parsed;
  }
  return 0n;
}


function resolveSwapOrientation(pool, inputMint, outputMint = null) {
  const { tokenXMint, tokenYMint } = getPoolMints(pool);
  const { tokenXDecimals, tokenYDecimals } = getPoolDecimals(pool);

  if (!inputMint) {
    throw new Error(`Missing input mint for pool ${getPoolAddress(pool)}`);
  }
  if (!tokenXMint || !tokenYMint) {
    throw new Error(`Pool ${getPoolAddress(pool)} is missing token orientation`);
  }

  if (inputMint === tokenXMint) {
    if (outputMint && outputMint !== tokenYMint) {
      throw new Error(`Pool ${getPoolAddress(pool)} does not support ${short(inputMint)} -> ${short(outputMint)}`);
    }
    return {
      swapForY: true,
      aToB: true,
      swapDirection: 'A_TO_B',
      direction: 'A_TO_B',
      tokenInMint: tokenXMint,
      tokenOutMint: tokenYMint,
      inputMint: tokenXMint,
      outputMint: tokenYMint,
      inputDecimals: tokenXDecimals,
      outputDecimals: tokenYDecimals,
      inDecimals: tokenXDecimals,
      outDecimals: tokenYDecimals,
    };
  }

  if (inputMint === tokenYMint) {
    if (outputMint && outputMint !== tokenXMint) {
      throw new Error(`Pool ${getPoolAddress(pool)} does not support ${short(inputMint)} -> ${short(outputMint)}`);
    }
    return {
      swapForY: false,
      aToB: false,
      swapDirection: 'B_TO_A',
      direction: 'B_TO_A',
      tokenInMint: tokenYMint,
      tokenOutMint: tokenXMint,
      inputMint: tokenYMint,
      outputMint: tokenXMint,
      inputDecimals: tokenYDecimals,
      outputDecimals: tokenXDecimals,
      inDecimals: tokenYDecimals,
      outDecimals: tokenXDecimals,
    };
  }

  throw new Error(`Input mint ${short(inputMint)} is not part of pool ${getPoolAddress(pool)}`);
}

function quoteFromCanonicalReserves(pool = {}, inputAmountAtomic, swapForY = true, slippageBps = DEFAULT_SLIPPAGE_BPS, quoteSource = 'local-reserves') {
  const inAmount = toReserveBigInt(inputAmountAtomic);
  const reserveX = toReserveBigInt(
    pool.xReserve,
    pool.reserveX,
    pool.tokenXReserve,
    pool.reserves?.x,
    pool.reserves?.tokenX,
    pool.baseReserve,
    pool.reserve0,
  );
  const reserveY = toReserveBigInt(
    pool.yReserve,
    pool.reserveY,
    pool.tokenYReserve,
    pool.reserves?.y,
    pool.reserves?.tokenY,
    pool.quoteReserve,
    pool.reserve1,
  );
  const inputReserve = swapForY ? reserveX : reserveY;
  const outputReserve = swapForY ? reserveY : reserveX;
  const feeBps = Math.max(0, Number(pool.feeBps ?? pool.feeRateBps ?? 0) || 0);

  if (inAmount <= 0n || inputReserve <= 0n || outputReserve <= 0n) {
    return {
      success: false,
      inAmountRaw: inAmount.toString(),
      outAmountRaw: '0',
      minOutAmountRaw: '0',
      feeBps,
      priceImpact: 0,
    }
  }
}
module.exports = {
  toBigInt: toBigIntSafe,
  short,
  getPoolAddress,
  getPoolType,
  resolveSwapOrientation,
  quoteFromCanonicalReserves,
  classifyQuoteExecutionQuality,
  classifyPool,
  hasPositiveReserves
}

/*

  node utilities/_diagnose_pools2.js 00_RAWready.json \
  --minLiquidity 2000000 \
  --output pools/_2M.clean.json

*/
