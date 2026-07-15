/**
 * TRADE RESULTS REPORT GENERATOR
 *
 * Generates CSV and HTML-report-compatible JSON from myEngine simulation output.
 * Aligned with normalization pipeline (normalizer.js / poolContract.js).
 *
 * Integration in myEngine.js (end of main()):
 *   const { generateTradeReports } = require('../utilities/tradeReportGenerator');
 *   await generateTradeReports(result, options.output, {
 *     csvPath: '05_COMPARE.csv',
 *     htmlJsonPath: '06_RESULT_DATA.json',
 *     htmlPath: '07_RESULTS_REPORT.html',
 *   });
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_RUNTIME_OUTPUT = '04_RUNTIME_RESULTS.json';
const DEFAULT_CSV_OUTPUT = '05_COMPARE.csv';
const DEFAULT_JSON_OUTPUT = '06_RESULT_DATA.json';
const DEFAULT_HTML_OUTPUT = '07_RESULTS_REPORT.html';
const DEFAULT_REPORT_RANK_BY = 'profitBpsVerified';
const IMPACT_SUSPECT_BPS_THRESHOLD = 10;
const CONCENTRATED_IMPACT_SUSPECT_BPS_THRESHOLD = 5;
const MISSING_QUOTE_BPS = -999999;
const KNOWN_TOKEN_DECIMALS = {
  So11111111111111111111111111111111111111112: 9,
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6,
  '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4': 6,
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 8,
  'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij': 8,
};

/* -------------------------------------------------------------------------- */
/*                              DEX Type Mapping                              */
/* -------------------------------------------------------------------------- */

const CSV_DEX_ABBREV = {
  ORCA_WHIRLPOOL: 'WHIR',
  RAYDIUM_CLMM: 'CLMM',
  RAYDIUM_CPMM: 'CPMM',
  METEORA_DLMM: 'DLMM',
  METEORA_DAMM_V2: 'DAMM2',
  PANCAKESWAP_AMM: 'PCK',
  PANCAKESWAP_AMMV3: 'PCK',
  PUMPSWAP_AMM: 'PUMP',
  PUMPSWAP: 'PUMP',
};

const HTML_DEX_ABBREV = {
  ORCA_WHIRLPOOL: 'WHI',
  RAYDIUM_CLMM: 'CLM',
  RAYDIUM_CPMM: 'CPM',
  METEORA_DLMM: 'DLM',
  METEORA_DAMM_V2: 'DAM',
  PANCAKESWAP_AMM: 'PCK',
  PANCAKESWAP_AMMV3: 'PCK',
  PUMPSWAP_AMM: 'PUM',
  PUMPSWAP: 'PUM',
};

function getCsvDexAbbrev(dexType) {
  const s = normalizeDexType(dexType);
  return CSV_DEX_ABBREV[s] || s.slice(0, 6) || 'UNK';
}

function getHtmlDexAbbrev(dexType) {
  const s = normalizeDexType(dexType);
  return HTML_DEX_ABBREV[s] || s.slice(0, 3) || 'UNK';
}

function getDexLegName(dexType) {
  const s = normalizeDexType(dexType);
  if (s.includes('WHIRLPOOL')) return 'WHIRLPOOL';
  if (s.includes('CLMM')) return 'CLMM';
  if (s.includes('PANCAKE')) return 'PANCAKESWAP';
  if (s.includes('PUMP')) return 'PUMPSWAP';
  if (s.includes('CPMM')) return 'CPMM';
  if (s.includes('DLMM')) return 'DLMM';
  if (s.includes('DAMM_V2')) return 'DAMM_V2';
  if (s.includes('AMM_V3')) return 'PANCAKESWAP';
  return 'UNKNOWN';
}

/* -------------------------------------------------------------------------- */
/*                           Aggregate Computations                           */
/* -------------------------------------------------------------------------- */

function toFiniteNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundTo(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(toFiniteNumber(value, 0) * factor) / factor;
}

function tokenDecimalsFor(mint, fallback = 9) {
  const dec = KNOWN_TOKEN_DECIMALS[String(mint || '')];
  return Number.isFinite(dec) ? dec : fallback;
}

/**
 * profitBpsVerified — profit recomputed straight from raw lamports, independent of
 * any impact/price display field. Uses the FIRST leg's raw input and the LAST leg's
 * raw output (falling back to route.startAmount / route.finalAmount). This is the
 * number to rank on: impact fields can be wrong, but in/out lamports are ground truth.
 */
function bigIntOrNull(value) {
  try {
    if (value === null || value === undefined || value === '') return null;
    const s = String(value).trim().replace(/n$/i, '');
    if (!/^[-+]?\d+$/.test(s)) return null;
    return BigInt(s);
  } catch (_e) {
    return null;
  }
}

function computeProfitBpsVerified(route = {}) {
  const legs = route.legs || [];
  const firstLeg = legs[0] || {};
  const lastLeg = legs[legs.length - 1] || {};

  const inRaw = bigIntOrNull(firstLeg.inAmountRaw)
    ?? bigIntOrNull(firstLeg.inputAmount)
    ?? bigIntOrNull(route.startAmount);
  const outRaw = bigIntOrNull(lastLeg.outAmountRaw)
    ?? bigIntOrNull(lastLeg.expectedOutputAmount)
    ?? bigIntOrNull(route.finalAmount);

  if (inRaw === null || outRaw === null || inRaw <= 0n) return null;
  // (out - in) / in in bps, computed in integer space then scaled.
  const diff = outRaw - inRaw;
  const bps = Number((diff * 1000000n) / inRaw) / 100; // 4dp bps
  return Number(bps.toFixed(4));
}

function getLegImpactBps(leg = {}) {
  const impactBps = toFiniteNumber(leg.impactBps, NaN);
  if (Number.isFinite(impactBps) && impactBps > 0) return impactBps;
  const impactBpsRaw = toFiniteNumber(leg.impactBpsRaw, NaN);
  if (Number.isFinite(impactBpsRaw) && impactBpsRaw > 0) return impactBpsRaw;

  const impactPct = toFiniteNumber(leg.impactPct, NaN);
  if (Number.isFinite(impactPct) && impactPct > 0) return impactPct * 100;

  const priceImpact = toFiniteNumber(leg.priceImpact, NaN);
  if (Number.isFinite(priceImpact) && priceImpact > 0) return priceImpact * 10000;

  return 0;
}

function normalizeDexType(dexType) {
  return String(dexType || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function classifyLegImpact(leg = {}, legIndex = 0) {
  const raw = getLegImpactBps(leg);
  const dex = normalizeDexType(leg.dexType || leg.dex || '');
  const quoteSource = String(leg.quoteSource || '').toLowerCase();
  const tickStrategy = String(leg.tickStrategy || '').toLowerCase();
  const concentrated = dex.includes('CLMM') || dex.includes('DLMM') || dex.includes('WHIRLPOOL');
  const suspectByFallback = concentrated
    && (quoteSource.includes('repaired') || quoteSource.includes('recovered') || quoteSource.includes('canonical-pool-price-field'));
  const suspectByApprox = quoteSource.includes('adapter-approximation') || tickStrategy.includes('adapter-approximation');
  const suspectByMagnitude = Math.abs(raw) >= IMPACT_SUSPECT_BPS_THRESHOLD;
  const suspectByConcentratedMagnitude = concentrated && Math.abs(raw) >= CONCENTRATED_IMPACT_SUSPECT_BPS_THRESHOLD;
  const suspect = suspectByFallback || suspectByApprox || suspectByMagnitude || suspectByConcentratedMagnitude;
  const reasons = [];
  if (suspectByFallback) reasons.push(`concentratedFallback=${leg.quoteSource}`);
  if (suspectByApprox) reasons.push(`quoteSource=${leg.quoteSource || ''}${leg.tickStrategy ? ` tickStrategy=${leg.tickStrategy}` : ''}`.trim());
  if (suspectByMagnitude) reasons.push(`magnitude=${raw.toFixed(2)}bps`);
  else if (suspectByConcentratedMagnitude) reasons.push(`concentratedMagnitude=${raw.toFixed(2)}bps`);
  return {
    legIndex: leg.legIndex || legIndex + 1,
    raw,
    suspect,
    reason: reasons.join(', ') || null,
  };
}

function getLegTvl(leg = {}) {
  const value = leg.tvl ?? leg.tvlUsd ?? leg.liquidityUsd ?? leg.liquidity?.liquidityUsd ?? null;
  const tvl = toFiniteNumber(value, NaN);
  return Number.isFinite(tvl) && tvl > 0 ? tvl : null;
}

function getLegVolume24h(leg = {}) {
  const value = leg.volume24h
    ?? leg.volume24hUsd
    ?? leg.volumeUsd24h
    ?? leg.volumeUsd
    ?? leg.volume?.day
    ?? leg.volume
    ?? null;
  const volume = toFiniteNumber(value, NaN);
  return Number.isFinite(volume) && volume > 0 ? volume : null;
}

function computeRouteAggregates(route) {
  const legs = route.legs || [];

  const sumFeeBps = legs.reduce((sum, leg) => sum + toFiniteNumber(leg.feeBps, 0), 0);
  const legImpacts = legs.map((leg, index) => classifyLegImpact(leg, index));
  const sumImpactBpsRaw = legImpacts.reduce((sum, impact) => sum + impact.raw, 0);
  const impactSuspect = legImpacts.some((impact) => impact.suspect);
  const routeTvl = legs
    .map(getLegTvl)
    .filter((tvl) => tvl !== null)
    .reduce((min, tvl) => Math.min(min, tvl), Infinity);
  const routeVolume24h = legs
    .map(getLegVolume24h)
    .filter((volume) => volume !== null)
    .reduce((min, volume) => Math.min(min, volume), Infinity);

  const sumTradeRatioPct = legs.reduce(
    (sum, leg) => sum + toFiniteNumber(leg.tradeRatioPct, 0), 0
  );

  const profitBps = toFiniteNumber(route.profitBps, 0);
  const grossEdgeBps = profitBps + sumFeeBps;
  const edgeMinusFeesBps = grossEdgeBps - sumFeeBps;

  return {
    sumFeeBps: roundTo(sumFeeBps, 2),
    sumImpactBps: impactSuspect ? null : roundTo(sumImpactBpsRaw, 4),
    sumImpactBpsRaw: roundTo(sumImpactBpsRaw, 4),
    sumTradeRatioPct: roundTo(sumTradeRatioPct, 4),
    tvl: routeTvl === Infinity ? '' : roundTo(routeTvl, 2),
    volume24h: routeVolume24h === Infinity ? '' : roundTo(routeVolume24h, 2),
    grossEdgeBps: roundTo(grossEdgeBps, 2),
    edgeMinusFeesBps: roundTo(edgeMinusFeesBps, 2),
    grossSpreadBps: roundTo(grossEdgeBps, 2),
    impactSuspect,
    impactSuspectLegs: legImpacts.filter((impact) => impact.suspect).map((impact) => impact.legIndex),
    impactSuspectReasons: legImpacts.filter((impact) => impact.suspect).map((impact) => `L${impact.legIndex}: ${impact.reason}`),
  };
}

/* -------------------------------------------------------------------------- */
/*                            CSV Row Builders                                */
/* -------------------------------------------------------------------------- */

function buildRouteCsvRow(route, aggregates) {
  const legs = route.legs || [];
  const dexCombo = legs.map(l => getCsvDexAbbrev(l.dexType)).join('|');

  const inAmountSol = toFiniteNumber(route.startAmount, 0) / 1e9;
  const outAmountSol = toFiniteNumber(route.finalAmount, 0) / 1e9;

  return {
    level: 'ROUTE',
    routeId: route.routeId || '',
    leg: '',
    quoteStatus: route.quoteStatus || '',
    quoteReason: route.quoteReason || '',
    path: route.routePathSymbols || route.routePath || '',
    dexType: dexCombo,
    inAmount_SOL: inAmountSol.toFixed(1),
    outAmount_SOL: outAmountSol.toFixed(9),
    profitLamports: route.profitLamports || '',
    profitBps: route.profitBps ?? '',
    sumFeeBps: aggregates.sumFeeBps,
    sumImpactBps: aggregates.sumImpactBps,
    sumTradeRatioPct: aggregates.sumTradeRatioPct,
    tvl: aggregates.tvl,
    volume24h: aggregates.volume24h,
    grossEdgeBps: aggregates.grossEdgeBps,
    edgeMinusFeesBps: aggregates.edgeMinusFeesBps,
    feeBps: '',
    impactBps: '',
    tradeRatioPct: '',
    grossImpactPct: '',
    inSym: '',
    outSym: '',
    inAmount: '',
    outAmount: '',
    quoteSource: '',
  };
}

function buildLegCsvRow(leg, routeId) {
  const inAmount = toFiniteNumber(leg.inAmountRaw || leg.inputAmount, 0);
  const outAmount = toFiniteNumber(leg.outAmountRaw || leg.expectedOutputAmount, 0);
  const impact = classifyLegImpact(leg, 0);
  const tvl = getLegTvl(leg.tvl);
  const volume24h = getLegVolume24h(leg);

  return {
    level: '  leg',
    routeId: routeId,
    leg: leg.legIndex || '',
    quoteStatus: '',
    quoteReason: '',
    path: '',
    dexType: getDexLegName(leg.dexType),
    inAmount_SOL: '',
    outAmount_SOL: '',
    profitLamports: '',
    profitBps: '',
    sumFeeBps: '',
    sumImpactBps: '',
    sumTradeRatioPct: '',
    tvl: leg.tvl || '',//tvl === null ? '' : roundTo(tvl, 2),
    volume24h: volume24h === null ? '' : roundTo(volume24h, 2),
    grossEdgeBps: '',
    edgeMinusFeesBps: '',
    feeBps: leg.feeBps ?? '',
    impactBps: impact.suspect ? '' : Math.round(impact.raw * 10000) / 10000,
    tradeRatioPct: leg.tradeRatioPct ?? '',
    grossImpactPct: leg.grossImpactPct ?? '',
    inSym: leg.inputSymbol || (leg.tokenInMint ? leg.tokenInMint.slice(0, 6) : ''),
    outSym: leg.outputSymbol || (leg.tokenOutMint ? leg.tokenOutMint.slice(0, 6) : ''),
    inAmount: inAmount,
    outAmount: outAmount,
    quoteSource: leg.quoteSource || '',
  };
}

/* -------------------------------------------------------------------------- */
/*                          HTML Report JSON Builder                          */
/* -------------------------------------------------------------------------- */

function buildHtmlReportRoute(route, aggregates) {
  const legs = route.legs || [];
  const dexCombo = legs.map(l => getHtmlDexAbbrev(l.dexType)).join('\u00b7');
  // Note: route-level TVL comes from aggregates.tvl below \u2014 the old 'leg' param was dead code
  // that caused a TypeError crash ("Cannot read properties of undefined (reading 'tvl')").

  return {
    routeId: route.routeId || '',
    quoteStatus: route.quoteStatus || '',
    quoteReason: route.quoteReason || '',
    path: route.routePathSymbols || route.routePath || '',
    dexCombo,
    profitBps: toFiniteNumber(route.profitBps, 0),
    profitBpsVerified: computeProfitBpsVerified(route),
    feeBps: aggregates.sumFeeBps,
    impactBps: aggregates.sumImpactBps,
    impactBpsRaw: aggregates.sumImpactBpsRaw,
    tradeRatioPct: aggregates.sumTradeRatioPct,
    tvl: aggregates.tvl === '' ? null : aggregates.tvl,
    volume24h: aggregates.volume24h === '' ? null : aggregates.volume24h,
    grossEdgeBps: aggregates.grossEdgeBps,
    edgeMinusFeesBps: aggregates.edgeMinusFeesBps,
    grossSpreadBps: aggregates.grossSpreadBps,
    sumImpactBpsRaw: aggregates.sumImpactBpsRaw,
    impactSuspect: aggregates.impactSuspect,
    impactSuspectLegs: aggregates.impactSuspectLegs,
    impactSuspectReasons: aggregates.impactSuspectReasons,
    inLamports: String(route.startAmount || '0'),
    outLamports: String(route.finalAmount || '0'),
    requiredRepay: route.requiredRepay == null ? undefined : String(route.requiredRepay),
    repayAmountLamports: route.repayAmountLamports == null ? undefined : String(route.repayAmountLamports),
    flashLoanRepayAmountLamports: route.flashLoanRepayAmountLamports == null ? undefined : String(route.flashLoanRepayAmountLamports),
    flashFeeBps: route.flashFeeBps,
    executionEligible: route.executionEligible,
    executionQuality: route.executionQuality,
    gateReasons: route.execution?.gateReasons || route.gateReasons || undefined,
    profitLamports: String(route.profitLamports || '0'),
    quoteTiming: route.quoteTiming || undefined,
    legs: legs.map(leg => {
      const impact = classifyLegImpact(leg, 0);
      const tvl = getLegTvl(leg);
      const volume24h = getLegVolume24h(leg);
      const inputMint = leg.tokenInMint || leg.inputMint || '';
      const outputMint = leg.tokenOutMint || leg.outputMint || '';
      const inDecimals = toFiniteNumber(
        leg.inputDecimals ?? leg.inDecimals ?? leg.tokenInDecimals,
        tokenDecimalsFor(inputMint, 9)
      );
      const outDecimals = toFiniteNumber(
        leg.outputDecimals ?? leg.outDecimals ?? leg.tokenOutDecimals,
        tokenDecimalsFor(outputMint, 9)
      );
      const minOutputAmount = String(
        leg.minOutputAmount
        || leg.minOutAmountRaw
        || leg.minOutputAmountRaw
        || leg.minOutAtomic
        || ''
      );

      return {
        legIndex: leg.legIndex || 0,
        dex: getDexLegName(leg.dexType),
        dexType: leg.dexType || '',
        mathType: leg.mathType || leg.type || '',
        tokenInMint: inputMint,
        tokenOutMint: outputMint,
        inputMint,
        outputMint,
        inDecimals,
        outDecimals,
        inSym: leg.inputSymbol || (leg.tokenInMint ? leg.tokenInMint.slice(0, 6) : '?'),
        outSym: leg.outputSymbol || (leg.tokenOutMint ? leg.tokenOutMint.slice(0, 6) : '?'),
        inAmount: String(leg.inAmountRaw || leg.inputAmount || '0'),
        outAmount: String(leg.outAmountRaw || leg.expectedOutputAmount || '0'),
        inAmountRaw: String(leg.inAmountRaw || leg.inputAmount || '0'),
        outAmountRaw: String(leg.outAmountRaw || leg.expectedOutputAmount || '0'),
        inputAmount: String(leg.inputAmount || leg.inAmountRaw || '0'),
        expectedOutputAmount: String(leg.expectedOutputAmount || leg.outAmountRaw || '0'),
        minOutputAmount,
        minOutAmountRaw: minOutputAmount,
        minOutputAmountRaw: minOutputAmount,
        feeBps: toFiniteNumber(leg.feeBps, 0),
        impactBps: impact.suspect ? null : Math.round(impact.raw * 10000) / 10000,
        impactBpsRaw: Math.round(impact.raw * 10000) / 10000,
        impactSuspect: impact.suspect,
        impactSuspectReason: impact.reason,
        tradeRatioPct: toFiniteNumber(leg.tradeRatioPct, 0),
        tvl: leg.tvl || '', //tvl === null ? null : roundTo(tvl, 2),
        volume24h: volume24h === null ? null : roundTo(volume24h, 2),
        grossImpactPct: toFiniteNumber(leg.grossImpactPct, 0),
        feePct: toFiniteNumber(leg.feePct, 0),
        pool: leg.poolAddress || '',
        quoteSource: leg.quoteSource || '',
        quoteTiming: leg.quoteTiming || undefined,
        tickStrategy: leg.tickStrategy || null,
        slippageBps: leg.slippageBps ?? null,
        marketDepthImpactBps: leg.marketDepthImpactBps ?? null,
        marketDepthSlippageBps: leg.marketDepthSlippageBps ?? null,
      };
    }),
  };
}

/* -------------------------------------------------------------------------- */
/*                            Main Export Functions                           */
/* -------------------------------------------------------------------------- */

function normalizeTopN(value) {
  if (value === null || value === undefined || value === '' || String(value).toLowerCase() === 'all') {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function getRouteRankValue(route = {}, aggregates = {}, rankBy = DEFAULT_REPORT_RANK_BY) {
  const key = String(rankBy || DEFAULT_REPORT_RANK_BY);
  if (key === 'profitBpsVerified') {
    const verified = computeProfitBpsVerified(route);
    return verified === null
      ? toFiniteNumber(route.profitBps, Number.NEGATIVE_INFINITY)
      : verified;
  }
  if (key === 'profitLamports') return toFiniteNumber(route.profitLamports, Number.NEGATIVE_INFINITY);
  if (key === 'profitBps') return toFiniteNumber(route.profitBps, Number.NEGATIVE_INFINITY);
  if (key === 'grossEdgeBps') return toFiniteNumber(aggregates.grossEdgeBps, Number.NEGATIVE_INFINITY);
  if (key === 'edgeMinusFeesBps') return toFiniteNumber(aggregates.edgeMinusFeesBps, Number.NEGATIVE_INFINITY);
  if (key === 'tradeSizeObjective') return toFiniteNumber(route.tradeSizeObjective, Number.NEGATIVE_INFINITY);
  if (key === 'selectedSizeSol') return toFiniteNumber(route.selectedSizeSol, Number.NEGATIVE_INFINITY);
  return toFiniteNumber(route[key] ?? aggregates[key], Number.NEGATIVE_INFINITY);
}

function rankAndLimitRoutes(routes = [], options = {}) {
  const rankBy = options.rankBy || options.reportRankBy || DEFAULT_REPORT_RANK_BY;
  const topN = normalizeTopN(options.topN ?? options.reportTopN ?? options.topn4N);
  const preserveInputOrder = ['sourceOrder', 'submissionOrder', 'inputOrder', 'none', ''].includes(String(rankBy || '').toLowerCase());

  if (preserveInputOrder) {
    const selected = topN ? (routes || []).slice(0, topN) : [...(routes || [])];
    return {
      routes: selected,
      rankBy: 'sourceOrder',
      topN: topN || null,
      inputCount: routes.length,
      outputCount: selected.length,
    };
  }

  const ranked = (routes || [])
    .map((route, index) => {
      const aggregates = computeRouteAggregates(route);
      return {
        route,
        index,
        aggregates,
        rankValue: getRouteRankValue(route, aggregates, rankBy),
      };
    })
    .sort((a, b) => {
      if (b.rankValue !== a.rankValue) return b.rankValue - a.rankValue;
      return a.index - b.index;
    });

  const selected = topN ? ranked.slice(0, topN) : ranked;
  return {
    routes: selected.map((entry) => entry.route),
    rankBy,
    topN: topN || null,
    inputCount: routes.length,
    outputCount: selected.length,
  };
}

function auditQuoteToRoute(quote = {}) {
  const legs = Array.isArray(quote.legs) ? quote.legs : [];
  const startAmount = legs[0]?.inAmountRaw || quote.startAmount || '0';
  const finalAmount = quote.finalAmountRaw || legs[legs.length - 1]?.outAmountRaw || '0';
  const profitBps = quote.netProfitBps == null
    ? MISSING_QUOTE_BPS
    : toFiniteNumber(quote.netProfitBps, MISSING_QUOTE_BPS);
  return {
    routeId: quote.routeId || `quote-${quote.i ?? ''}`,
    routePath: quote.path || '',
    routePathSymbols: quote.path || '',
    quoteStatus: quote.status || '',
    quoteReason: quote.reason || '',
    profitBps,
    netProfitBps: profitBps,
    grossProfitBps: quote.grossProfitBps == null ? undefined : quote.grossProfitBps,
    profitLamports: quote.profitLamportsRaw || '',
    startAmount: String(startAmount || '0'),
    finalAmount: String(finalAmount || '0'),
    requiredRepay: quote.requiredRepayRaw || undefined,
    executionEligible: quote.executionEligible,
    executionQuality: quote.executionQuality || quote.status || '',
    gateReasons: quote.gateReasons || (quote.reason ? [{ reason: quote.reason }] : undefined),
    legs: legs.map((leg, index) => ({
      legIndex: leg.i || index + 1,
      dexType: leg.dex || '',
      mathType: leg.dex || '',
      poolAddress: leg.pool || '',
      tokenInMint: leg.tokenInMint || '',
      tokenOutMint: leg.tokenOutMint || '',
      inputMint: leg.tokenInMint || '',
      outputMint: leg.tokenOutMint || '',
      inputSymbol: leg.in || '',
      outputSymbol: leg.out || '',
      inAmountRaw: String(leg.inAmountRaw || '0'),
      outAmountRaw: String(leg.outAmountRaw || '0'),
      inputAmount: String(leg.inAmountRaw || '0'),
      expectedOutputAmount: String(leg.outAmountRaw || '0'),
      minOutputAmount: String(leg.minOutAmountRaw || ''),
      feeBps: leg.feeBps ?? 0,
      impactBps: leg.impactBps ?? leg.marketDepthImpactBps ?? 0,
      marketDepthImpactBps: leg.marketDepthImpactBps ?? null,
      slippageBps: leg.slippageBps ?? null,
      quoteSource: leg.quoteSource || '',
      tickStrategy: leg.tickStrategy || null,
    })),
  };
}

function collectQuoteAuditRoutes(engineResult = {}) {
  const quotes = engineResult?.quoteAudit?.quotes;
  if (!Array.isArray(quotes) || quotes.length === 0) return [];
  return quotes.map(auditQuoteToRoute);
}

function routeIdentity(route = {}, index = 0) {
  const legKey = Array.isArray(route.legs)
    ? route.legs.map((leg) => leg.poolAddress || leg.address || '').join('|')
    : '';
  return [
    route.routeId || '',
    route.routePathSymbols || route.routePath || route.path || '',
    legKey,
  ].join('::') || `route-${index}`;
}

function collectReportRoutes(engineResult = {}, options = {}) {
  if (options.preferSubmissionCandidates !== true
    && Array.isArray(engineResult.submissionCandidates)
    && engineResult.submissionCandidates.length > 0) {
    return engineResult.submissionCandidates;
  }

  const routeBuckets = [
    collectQuoteAuditRoutes(engineResult),
    engineResult.executionEligibleTopRoutes,
    engineResult.topRoutes,
    engineResult.topGatedRoutes,
    engineResult.diagnosticTopRoutes,
    engineResult.scannerPositiveTopRoutes,
    engineResult.submissionCandidates,
  ];
  const seen = new Set();
  const routes = [];
  for (const bucket of routeBuckets) {
    if (!Array.isArray(bucket)) continue;
    for (const route of bucket) {
      const key = routeIdentity(route, routes.length);
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push(route);
    }
  }
  return routes;
}

function generateCsvFromRoutes(routes, outputPath) {
  const headers = [
    'level', 'routeId', 'leg', 'quoteStatus', 'quoteReason', 'path', 'dexType', 'inAmount_SOL', 'outAmount_SOL',
    'profitLamports', 'profitBps', 'sumFeeBps', 'sumImpactBps', 'sumTradeRatioPct',
    'tvl', 'volume24h', 'grossEdgeBps', 'edgeMinusFeesBps', 'feeBps', 'impactBps', 'tradeRatioPct',
    'grossImpactPct', 'inSym', 'outSym', 'inAmount', 'outAmount', 'quoteSource'
  ];

  if (!Array.isArray(routes) || routes.length === 0) {
    console.warn('[tradeReportGenerator] No routes to export to CSV');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, headers.join(',') + '\n', 'utf8');
    return outputPath;
  }

  const csvRows = [];
  for (const route of routes) {
    const aggregates = computeRouteAggregates(route);
    csvRows.push(buildRouteCsvRow(route, aggregates));
    for (const leg of (route.legs || [])) {
      csvRows.push(buildLegCsvRow(leg, route.routeId));
    }
  }

  let csv = headers.join(',') + '\n';
  for (const row of csvRows) {
    const values = headers.map(h => {
      const v = row[h];
      if (v === null || v === undefined || v === '') return '';
      const s = String(v);
      if (/[,"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    });
    csv += values.join(',') + '\n';
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, csv, 'utf8');
  console.log(`[tradeReportGenerator] CSV saved: ${outputPath} (${csvRows.length} rows)`);
  return outputPath;
}

function buildReportMeta(selection = {}) {
  const inputCount = Number(selection.inputCount || 0);
  const outputCount = Number(selection.outputCount || 0);
  return {
    selectedRoutes: outputCount,
    totalRoutes: inputCount,
    selectedPct: inputCount > 0 ? Number(((outputCount / inputCount) * 100).toFixed(2)) : 0,
    rankBy: selection.rankBy || DEFAULT_REPORT_RANK_BY,
    topN: selection.topN || 'all',
    sourceRouteSet: selection.sourceRouteSet || 'unknown',
  };
}

function generateHtmlReportJson(routes, outputPath, meta = null) {
  if (!Array.isArray(routes) || routes.length === 0) {
    console.warn('[tradeReportGenerator] No routes to export to HTML JSON');
    const emptyMeta = meta || buildReportMeta({ inputCount: 0, outputCount: 0 });
    const payload = {
      ROUTES: [],
      META: {
        ...emptyMeta,
        empty: true,
        generatedAt: new Date().toISOString(),
      },
      routes: [],
      topRoutes: [],
      submissionCandidates: [],
      executionEligibleTopRoutes: [],
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');
    return outputPath;
  }

  const reportRoutes = routes.map(route => {
    const aggregates = computeRouteAggregates(route);
    return buildHtmlReportRoute(route, aggregates);
  });

  const payload = meta ? { ROUTES: reportRoutes, META: meta } : { ROUTES: reportRoutes };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`[tradeReportGenerator] HTML report JSON saved: ${outputPath} (${reportRoutes.length} routes)`);
  return outputPath;
}

/* -------------------------------------------------------------------------- */
/*                          Embedded HTML Template                            */
/* -------------------------------------------------------------------------- */
/* Same Bloomberg-terminal layout, no external file required. The placeholder
 * line `const ROUTES = [];` is replaced at generation time. If a user provides
 * an external template at templates/tradeResults_report_template.html, that
 * one wins (the file-based path is preserved for customization).
 */

const EMBEDDED_TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Triangle Arb · Run Forensics</title>
<style>:root{--bg:#0a0d10;--panel:#0f1418;--line:#1c252c;--line2:#243038;--text:#d6dde3;--dim:#7c8a93;--faint:#4f5b62;--green:#5fd28a;--red:#ff6660;--amber:#f5c95e;--cyan:#58c6e0;--gross:#bb8fff;--gridline:#172026}*{box-sizing:border-box}html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font:13px/1.5 "JetBrains Mono","SF Mono","Menlo",ui-monospace,monospace}header{padding:22px 28px 16px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:6px;background:linear-gradient(180deg,#0d1216,#0a0d10)}h1{margin:0;font:600 14px/1.2 monospace;letter-spacing:.18em;text-transform:uppercase}h1 span{color:var(--cyan)}.sub{color:var(--dim);font-size:11px;letter-spacing:.12em;text-transform:uppercase}.kpis{padding:18px 28px;border-bottom:1px solid var(--line);display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--line)}.kpi{background:var(--panel);padding:12px 14px}.kpi .v{font-size:18px;font-weight:600}.kpi .l{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.14em;margin-top:2px}.kpi.ok .v{color:var(--green)}.kpi.warn .v{color:var(--amber)}.kpi.bad .v{color:var(--red)}main{padding:18px 28px}table{width:100%;border-collapse:collapse;font-size:12px}thead th{position:sticky;top:0;z-index:2;background:#0d1418;color:var(--dim);font:600 10px/1.2 monospace;letter-spacing:.12em;text-transform:uppercase;text-align:right;padding:10px 8px;border-bottom:1px solid var(--line2);cursor:pointer;user-select:none;white-space:nowrap}thead th:first-child{text-align:left}thead th:hover{color:var(--text)}thead th.sorted{color:var(--cyan)}thead th.sorted::after{content:" ▾";font-size:9px}thead th.sorted.asc::after{content:" ▴"}tbody tr{border-bottom:1px solid var(--gridline)}tbody tr:hover{background:#101820}td{padding:8px 8px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}td.l{text-align:left}td.dim{color:var(--dim)}td.id{color:var(--faint);font-size:11px}.bar{display:inline-block;height:6px;border-radius:1px;vertical-align:middle;margin-left:6px}.cell-bar{display:flex;justify-content:flex-end;align-items:center;gap:6px}.tag{display:inline-block;padding:2px 6px;font-size:10px;font-weight:600;letter-spacing:.06em;border-radius:2px;background:#16202a;color:var(--dim);border:1px solid var(--line2)}.tag.WHI,.tag.WHIRLPOOL{color:#ff9a4d;border-color:#3d2818}.tag.CLM,.tag.CLMM{color:#58c6e0;border-color:#163842}.tag.CPM,.tag.CPMM{color:#f5c95e;border-color:#3d3315}.tag.DLM,.tag.DLMM{color:#bb8fff;border-color:#2c1f3d}.profit-pos{color:var(--green);font-weight:600}.profit-neg{color:var(--red);font-weight:600}.profit-zero{color:var(--dim)}.gross-pos{color:var(--gross);font-weight:600}.expand-btn{background:none;border:1px solid var(--line2);color:var(--dim);cursor:pointer;font:11px monospace;padding:1px 6px;border-radius:2px}.expand-btn:hover{color:var(--cyan);border-color:var(--cyan)}tr.legs{display:none}tr.legs.open{display:table-row}tr.legs td{padding:0;background:#080b0e}.legs-wrap{padding:8px 30px 14px;border-bottom:1px solid var(--line)}.legs-wrap table{width:100%}.legs-wrap td,.legs-wrap th{padding:5px 8px;font-size:11px;border:none}.legs-wrap th{color:var(--faint);text-transform:uppercase;letter-spacing:.1em;font-size:9px;text-align:right;border-bottom:1px solid var(--line)}.legs-wrap th:first-child{text-align:left}.legs-wrap td.l{text-align:left}.legs-wrap .pool-addr{color:var(--faint);font-size:10px}.controls{display:flex;gap:10px;margin-bottom:14px;align-items:center;flex-wrap:wrap}.controls input{background:var(--panel);border:1px solid var(--line2);color:var(--text);padding:6px 10px;font:12px monospace;border-radius:2px;min-width:200px}.controls label{color:var(--dim);font-size:11px;letter-spacing:.08em;text-transform:uppercase}.legend{display:flex;gap:18px;margin-top:6px;font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.1em}.empty{padding:30px 20px;text-align:center;color:var(--dim);font-size:12px;background:var(--panel);border:1px solid var(--line);margin-top:18px}</style></head><body>
<header><h1>TRIANGLE ARB · <span>RUN FORENSICS</span></h1><div class="sub" id="subline">— routes simulated · click ▸ to expand legs · click headers to sort</div></header>
<section class="kpis" id="kpis"></section>
<main>
<div class="controls"><input id="filter" placeholder="filter routes (path / dex / id)…"><label>min gross bps</label><input id="minGross" type="number" placeholder="any" style="min-width:80px"></div>
<table id="routes"><thead><tr><th data-sort="routeId">Route</th><th data-sort="quoteStatus">Status</th><th data-sort="quoteReason">Reason</th><th data-sort="path">Path</th><th data-sort="dexCombo">DEX</th><th data-sort="profitBps" class="sorted">Net&nbsp;bps</th><th data-sort="feeBps">Fee&nbsp;bps</th><th data-sort="impactBps">Impact&nbsp;bps</th><th data-sort="tradeRatioPct">Size/TVL&nbsp;%</th><th data-sort="tvl">TVL</th><th data-sort="volume24h">Vol&nbsp;24h</th><th data-sort="grossEdgeBps">Gross&nbsp;bps</th><th data-sort="edgeMinusFeesBps">Edge−Fee</th><th></th></tr></thead><tbody></tbody></table>
<div id="emptyState" class="empty" style="display:none">No routes returned by the engine for this run.</div>
</main>
<script>
const ROUTES = [];
const REPORT_META = {};
const tbody=document.querySelector('#routes tbody');
const fmtBps=n=>(n>0?'+':'')+(Number.isInteger(Number(n))?n:Number(n).toFixed(2));
const cls=n=>n>0?'profit-pos':(n<0?'profit-neg':'profit-zero');
const fmtPct=n=>Number(n).toFixed(4);
const fmtTvl=n=>n==null||n===''?'':Number(n).toLocaleString(undefined,{maximumFractionDigits:2});
const impactValue=r=>Number(r.impactBpsRaw??r.sumImpactBpsRaw??r.impactBps??0);
const impactCell=r=>{const v=impactValue(r);return (r.impactSuspect?'⚠ ':'')+(Number.isFinite(v)?v.toFixed(4):'')};
const fmtAmount=(amount,decimals=9)=>{const d=Number.isFinite(Number(decimals))?Number(decimals):9;return (Number(amount)/Math.pow(10,d)).toFixed(Math.min(9,Math.max(2,d)))};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let sortKey='profitBps',sortAsc=false,filterText='',minGross=null;
function maxAbs(a,k){return Math.max(1,...a.map(r=>Math.abs(Number(r[k])||0)))}
function renderKpis(){const k=document.getElementById('kpis');if(!ROUTES.length){k.innerHTML='';return}const p=ROUTES.filter(r=>r.profitBps>0).length;const bn=ROUTES.reduce((m,r)=>Math.max(m,r.profitBps),-Infinity);const mg=ROUTES.reduce((m,r)=>Math.max(m,r.grossEdgeBps),-Infinity);const mi=ROUTES.reduce((m,r)=>Math.max(m,impactValue(r)),0);const mf=ROUTES.reduce((m,r)=>Math.min(m,r.feeBps),Infinity);k.innerHTML=\`<div class="kpi \${p>0?'ok':''}"><div class="v">\${ROUTES.length}</div><div class="l">Routes</div></div><div class="kpi \${p>0?'ok':'bad'}"><div class="v">\${p}</div><div class="l">Profitable</div></div><div class="kpi \${bn>0?'ok':'warn'}"><div class="v">\${fmtBps(bn)} bps</div><div class="l">Best Net</div></div><div class="kpi"><div class="v">\${fmtBps(mg)} bps</div><div class="l">Max Gross Edge</div></div><div class="kpi \${mi>100?'bad':''}"><div class="v">\${mi.toFixed(0)} bps</div><div class="l">Max Impact</div></div><div class="kpi"><div class="v">\${mf} bps</div><div class="l">Min Fee</div></div>\`;document.getElementById('subline').textContent=\`\${ROUTES.length} routes · \${p} profitable · click ▸ to expand legs · click headers to sort\`}
function render(){if(!ROUTES.length){document.getElementById('emptyState').style.display='block';document.querySelector('#routes').style.display='none';return}let rows=ROUTES.filter(r=>{if(filterText){const b=(r.routeId+(r.quoteStatus||'')+(r.quoteReason||'')+r.path+r.dexCombo).toLowerCase();if(!b.includes(filterText.toLowerCase()))return false}if(minGross!==null&&r.grossEdgeBps<minGross)return false;return true});rows.sort((a,b)=>{const A=sortKey==='impactBps'?impactValue(a):a[sortKey],B=sortKey==='impactBps'?impactValue(b):b[sortKey];if(typeof A==='string')return sortAsc?A.localeCompare(B):B.localeCompare(A);return sortAsc?(A-B):(B-A)});const mxG=maxAbs(rows,'grossEdgeBps'),mxF=maxAbs(rows,'feeBps');tbody.innerHTML='';for(const r of rows){const tr=document.createElement('tr');const gW=Math.max(2,Math.abs(r.grossEdgeBps)/mxG*60),fW=Math.max(2,r.feeBps/mxF*40);tr.innerHTML=\`<td class="l id">\${esc(r.routeId)}</td><td class="l \${r.quoteStatus==='accepted'?'profit-pos':(r.quoteStatus?'profit-neg':'dim')}">\${esc(r.quoteStatus||'')}</td><td class="l dim">\${esc(r.quoteReason||'')}</td><td class="l">\${esc(r.path)}</td><td class="l">\${r.dexCombo.split('\\u00b7').map(d=>'<span class="tag '+esc(d)+'">'+esc(d)+'</span>').join(' ')}</td><td class="\${cls(r.profitBps)}">\${fmtBps(r.profitBps)}</td><td><div class="cell-bar"><span>\${r.feeBps}</span><span class="bar" style="width:\${fW}px;background:var(--amber)"></span></div></td><td class="dim">\${impactCell(r)}</td><td class="dim">\${fmtPct(r.tradeRatioPct)}</td><td class="dim">\${fmtTvl(r.tvl)}</td><td class="dim">\${fmtTvl(r.volume24h)}</td><td><div class="cell-bar"><span class="\${r.grossEdgeBps>0?'gross-pos':'profit-neg'}">\${fmtBps(r.grossEdgeBps)}</span><span class="bar" style="width:\${gW}px;background:var(--gross);opacity:\${r.grossEdgeBps>0?1:.3}"></span></div></td><td class="\${cls(r.edgeMinusFeesBps)}">\${fmtBps(r.edgeMinusFeesBps)}</td><td><button class="expand-btn">▸</button></td>\`;tbody.appendChild(tr);const tr2=document.createElement('tr');tr2.className='legs';tr2.innerHTML=\`<td colspan="14"><div class="legs-wrap"><table><thead><tr><th>Leg</th><th>DEX</th><th>From → To</th><th>In</th><th>Out</th><th>Fee bps</th><th>Impact bps</th><th>Size/TVL %</th><th>TVL</th><th>Vol 24h</th><th>Gross Impact %</th><th>Quote</th><th>Pool</th></tr></thead><tbody>\${r.legs.map(l=>'<tr><td>'+l.legIndex+'</td><td><span class="tag '+esc(l.dex.slice(0,3))+'">'+esc(l.dex.slice(0,3))+'</span></td><td class="l">'+esc(l.inSym)+' → '+esc(l.outSym)+'</td><td>'+fmtAmount(l.inAmount,l.inDecimals)+'</td><td>'+fmtAmount(l.outAmount,l.outDecimals)+'</td><td>'+l.feeBps+'</td><td>'+impactCell(l)+'</td><td>'+Number(l.tradeRatioPct).toFixed(4)+'</td><td>'+fmtTvl(l.tvl)+'</td><td>'+fmtTvl(l.volume24h)+'</td><td>'+Number(l.grossImpactPct).toFixed(4)+'</td><td class="dim">'+esc(l.quoteSource||'')+'</td><td class="l pool-addr">'+esc((l.pool||'').slice(0,8))+'…'+esc((l.pool||'').slice(-4))+'</td></tr>').join('')}</tbody></table></div></td>\`;tbody.appendChild(tr2);tr.querySelector('.expand-btn').addEventListener('click',e=>{e.stopPropagation();tr2.classList.toggle('open');e.target.textContent=tr2.classList.contains('open')?'▾':'▸'})}}
document.querySelectorAll('th[data-sort]').forEach(th=>{th.addEventListener('click',()=>{const k=th.dataset.sort;if(sortKey===k)sortAsc=!sortAsc;else{sortKey=k;sortAsc=false}document.querySelectorAll('th').forEach(x=>x.classList.remove('sorted','asc'));th.classList.add('sorted');if(sortAsc)th.classList.add('asc');render()})});
document.getElementById('filter').addEventListener('input',e=>{filterText=e.target.value;render()});
document.getElementById('minGross').addEventListener('input',e=>{minGross=e.target.value===''?null:Number(e.target.value);render()});
renderKpis();render();
</script></body></html>`;

function generateHtmlReport(routes, outputPath, templatePath = null, meta = null) {
  // External template wins if provided and exists.
  let template = (templatePath && fs.existsSync(templatePath))
    ? fs.readFileSync(templatePath, 'utf8')
    : EMBEDDED_TEMPLATE;

  const reportRoutes = routes.map(route => {
    const aggregates = computeRouteAggregates(route);
    return buildHtmlReportRoute(route, aggregates);
  });

  const routesJson = JSON.stringify(reportRoutes, null, 2);
  template = template.replace(
    /const ROUTES\s*=\s*\[.*?\];/s,
    `const ROUTES = ${routesJson};`
  );
  template = template.replace(
    /const REPORT_META\s*=\s*\{.*?\};/s,
    `const REPORT_META = ${JSON.stringify(meta || {}, null, 2)};`
  );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, template, 'utf8');
  console.log(`[tradeReportGenerator] HTML report saved: ${outputPath}`);
  return outputPath;
}

/**
 * Main entry point — call at end of myEngine.runEngine() or in main()
 *
 * @param {Object} engineResult — result object from runEngine()
 * @param {string} baseOutputPath — path from --output flag (default: 04_runtimeResults.json)
 * @param {Object} options
 * @param {string} options.csvPath — explicit CSV destination
 * @param {string} options.htmlPath — explicit HTML destination
 * @param {string} options.htmlJsonPath — explicit HTML JSON destination
 * @param {string} options.jsonPath — alias for options.htmlJsonPath
 * @param {number|string} options.topN — only save top N routes (`all` disables)
 * @param {string} options.rankBy — route field to rank by before saving
 */
async function generateTradeReports(engineResult, baseOutputPath, options = {}) {
  const resolvedBase = path.resolve(baseOutputPath || DEFAULT_RUNTIME_OUTPUT);
  const baseDir = path.dirname(resolvedBase);

  const reportTopN = normalizeTopN(options.topN ?? options.reportTopN ?? options.topn4N);
  const candidateRoutes = collectReportRoutes(engineResult, {
    preferSubmissionCandidates: reportTopN !== null,
  });
  const hasSubmissionCandidates = Array.isArray(engineResult?.submissionCandidates) && engineResult.submissionCandidates.length > 0;
  const effectiveRankBy = options.rankBy || options.reportRankBy || (hasSubmissionCandidates ? 'sourceOrder' : DEFAULT_REPORT_RANK_BY);
  const reportSelection = rankAndLimitRoutes(candidateRoutes, { ...options, rankBy: effectiveRankBy });
  const routes = reportSelection.routes;

  const csvPath = options.csvPath ? path.resolve(options.csvPath) : path.join(baseDir, DEFAULT_CSV_OUTPUT);
  const htmlJsonPath = (options.htmlJsonPath || options.jsonPath)
    ? path.resolve(options.htmlJsonPath || options.jsonPath)
    : path.join(baseDir, DEFAULT_JSON_OUTPUT);
  const htmlPath = options.htmlPath ? path.resolve(options.htmlPath) : path.join(baseDir, DEFAULT_HTML_OUTPUT);
  const templatePath = path.join(__dirname, 'tradeResults_report_template.html');

  if (candidateRoutes.length === 0) {
    console.warn('[tradeReportGenerator] No routes found in engine result');
  }

  console.log(
    `[tradeReportGenerator] Selected ${reportSelection.outputCount}/${reportSelection.inputCount} routes`
    + ` ranked by ${reportSelection.rankBy}`
    + (reportSelection.topN ? ` (topN=${reportSelection.topN})` : ' (topN=all)')
  );

  const reportMeta = buildReportMeta(reportSelection);
  reportMeta.sourceRouteSet = reportTopN === null ? 'routeBuckets' : (hasSubmissionCandidates ? 'submissionCandidates' : 'routeBuckets');
  generateCsvFromRoutes(routes, csvPath);
  generateHtmlReportJson(routes, htmlJsonPath, reportMeta);
  generateHtmlReport(routes, htmlPath, fs.existsSync(templatePath) ? templatePath : null, reportMeta);

  return {
    csv: csvPath,
    html: htmlPath,
    htmlJson: htmlJsonPath,
    routeCount: reportSelection.outputCount,
    totalRouteCount: reportSelection.inputCount,
    rankBy: reportSelection.rankBy,
    topN: reportSelection.topN,
  };
}

module.exports = {
  generateTradeReports,
  generateCsvFromRoutes,
  generateHtmlReportJson,
  generateHtmlReport,
  computeRouteAggregates,
  rankAndLimitRoutes,
  DEFAULT_RUNTIME_OUTPUT,
  DEFAULT_CSV_OUTPUT,
  DEFAULT_JSON_OUTPUT,
  DEFAULT_HTML_OUTPUT,
  DEFAULT_REPORT_RANK_BY,
};
/*

//  node utilities/tradeReportGenerator.js

await generateTradeReports(result, options.output, {
     csvPath: '05_COMPARE.csv',
      htmlJsonPath: '06_RESULT_DATA.json',
      htmlPath: '07_RESULTS_REPORT.html',
    });
  
 * */
