/* ============================================================================
 *  TURNOVER RANKER  —  pool activity selector for the divergence scanner
 * ============================================================================
 *
 *  WHAT IT FIXES
 *  -------------
 *  TVL is a STOCK (how deep), not a FLOW (how active). A deep pool can be
 *  dormant; a smaller pool churning many multiples of its TVL per day is where
 *  dislocations actually appear. This ranks pools by TURNOVER:
 *
 *        turnover = volume24h / tvl
 *
 *  High turnover = "favourite for swaps" = volatility producer = where arb edge
 *  lives. This replaces a TVL-sorted pick (which can't tell active from dead)
 *  with an activity-sorted one.
 *
 *  DEPENDENCY (the gate)
 *  ---------------------
 *  Needs volume24h + tvl POPULATED on the pools. As of now your enriched pools
 *  carry volume24h=null, tvl="" — so until the fetcher fills them, this ranker
 *  will (correctly) report everything as unranked/zero-turnover. It is staged so
 *  it works the instant those fields go live. It reads the SAME fields the
 *  scanner already reads: p.tvl ?? p.tvlUsd ?? p.liquidityUsd, and
 *  p.volume24h ?? p.volume24hUsd ?? p.volumeUsd24h.
 *
 *  WHAT IT OUTPUTS
 *  ---------------
 *    rankPoolsByTurnover(pools, opts) -> {
 *        ranked: [{ address, pair, symbols, dex, feeBps, tvl, volume24h,
 *                   turnover, dlmmHot, roundTripCapable }],   // sorted desc by turnover
 *        byPair: Map<pairKey, pools[]>,                       // grouping
 *        roundTripPairs: [pairKey...],                        // >=2 venues
 *        summary: {...},
 *    }
 *    printTurnoverTable(result)  -> human-readable, SYMBOL-labeled table
 *
 *  SIGNALS IT SURFACES (the things you said you couldn't see)
 *  ---------------------------------------------------------
 *    - SYMBOLS, not mints: "SOL/USDC" not "EPjFWdd5...". Reads pairBaseSymbol /
 *      pairQuoteSymbol / tokenXSymbol / baseSymbol with mint fallback.
 *    - dlmmHot: a Meteora DLMM whose live feeBps is >= dlmmHotFeeBps (default 15)
 *      while its base is low — the variable-fee spike IS a live volatility flag.
 *    - roundTripCapable: pair has >= 2 venues (can 2-leg round-trip).
 *    - turnover rank: the activity signal itself.
 *
 *  ── APPLY (optional wiring; works standalone too) ───────────────────────────
 *  require it in the scanner and call after annotatePairDivergence(pools):
 *      const { rankPoolsByTurnover, printTurnoverTable } = require('./utilities/turnoverRanker');
 *      if (process.env.RANK_TURNOVER === 'true' || args.rankTurnover) {
 *          printTurnoverTable(rankPoolsByTurnover(pools, {
 *              minTurnover: Number(process.env.MIN_TURNOVER ?? 0),
 *              minVolume24h: Number(process.env.MIN_VOLUME24H ?? 0),
 *          }));
 *      }
 *  To use it to FILTER the universe (not just report), take result.ranked and
 *  keep addresses above your turnover floor before route-building.
 * ========================================================================== */

'use strict';

function toNum(v, d = 0) {
  if (v == null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function poolAddr(p = {}) {
  return String(p.poolAddress || p.address || p.id || p.pool || '').trim();
}

function poolTvl(p = {}) {
  return toNum(p.tvl ?? p.tvlUsd ?? p.liquidityUsd ?? p.liquidity_usd, 0);
}

function poolVolume24h(p = {}) {
  return toNum(p.volume24h ?? p.volume24hUsd ?? p.volumeUsd24h ?? p.volume_24h ?? p.vol24h, 0);
}

function poolDex(p = {}) {
  return String(p.dexType || p.type || p.dex || '').toLowerCase();
}

function poolFeeBps(p = {}) {
  return toNum(p.feeBps ?? p.feePct != null ? (p.feeBps ?? p.feePct * 100) : 0, 0);
}

function pairKeyOf(p = {}) {
  return p.pairCanonical || p.pairLabel
    || [p.tokenXMint || p.baseMint, p.tokenYMint || p.quoteMint].filter(Boolean).sort().join('/')
    || 'unknown';
}

function pairSymbols(p = {}) {
  const base = p.pairBaseSymbol || p.tokenXSymbol || p.baseSymbol
    || (p.tokenInMint ? String(p.tokenInMint).slice(0, 4) : '?');
  const quote = p.pairQuoteSymbol || p.tokenYSymbol || p.quoteSymbol
    || (p.tokenOutMint ? String(p.tokenOutMint).slice(0, 4) : '?');
  return `${base}/${quote}`;
}

/**
 * rankPoolsByTurnover — sort pools by volume24h/tvl, group by pair, flag
 * round-trip-capable pairs and hot DLMM pools.
 */
function rankPoolsByTurnover(pools = [], options = {}) {
  const minTurnover = toNum(options.minTurnover, 0);
  const minVolume24h = toNum(options.minVolume24h, 0);
  const dlmmHotFeeBps = toNum(options.dlmmHotFeeBps, 15);

  // group first so we can mark round-trip capability
  const byPair = new Map();
  for (const p of pools) {
    const key = pairKeyOf(p);
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(p);
  }
  const venueCount = new Map();
  for (const [key, group] of byPair.entries()) venueCount.set(key, group.length);

  const rows = [];
  for (const p of pools) {
    const tvl = poolTvl(p);
    const volume24h = poolVolume24h(p);
    const turnover = tvl > 0 ? volume24h / tvl : 0;
    const dex = poolDex(p);
    const feeBps = poolFeeBps(p);
    const key = pairKeyOf(p);

    if (volume24h < minVolume24h) continue;
    if (turnover < minTurnover) continue;

    rows.push({
      address: poolAddr(p),
      pair: key,
      symbols: pairSymbols(p),
      dex,
      feeBps,
      tvl,
      volume24h,
      turnover: Number(turnover.toFixed(4)),
      // a DLMM whose live fee is elevated is signalling volatility right now
      dlmmHot: dex.includes('dlmm') && feeBps >= dlmmHotFeeBps,
      roundTripCapable: (venueCount.get(key) || 0) >= 2,
      venues: venueCount.get(key) || 0,
    });
  }

  rows.sort((a, b) =>
    b.turnover - a.turnover
    || b.volume24h - a.volume24h
    || a.feeBps - b.feeBps
  );

  const roundTripPairs = [...venueCount.entries()]
    .filter(([, n]) => n >= 2)
    .map(([k]) => k);

  const haveActivity = rows.some((r) => r.volume24h > 0 || r.tvl > 0);

  return {
    ranked: rows,
    byPair,
    roundTripPairs,
    summary: {
      pools: pools.length,
      ranked: rows.length,
      roundTripPairs: roundTripPairs.length,
      hotDlmm: rows.filter((r) => r.dlmmHot).length,
      activityDataPresent: haveActivity,
    },
  };
}

function _fmtUsd(n) {
  if (!n) return '—';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function printTurnoverTable(result = {}) {
  const { ranked = [], summary = {} } = result;
  console.log('\n══════════════════════════════════════════════════════════════════════════');
  console.log('POOL TURNOVER RANK  (turnover = volume24h / TVL — higher = more active)');
  console.log('══════════════════════════════════════════════════════════════════════════');
  if (!summary.activityDataPresent) {
    console.log('  ⚠  volume24h / tvl are EMPTY on these pools — populate them in the fetcher.');
    console.log('     Ranker is staged and correct; it will rank the moment those fields go live.');
  }
  console.log('  PAIR             DEX        FEE   TVL availability  VOL24h    TURNOVER  FLAGS');
  console.log('  ─────────────────┼──────────┼─────┼─────────────────┼─────────┼─────────┼──────');
  for (const r of ranked.slice(0, 50)) {
    const flags = [
      r.roundTripCapable ? `RT(${r.venues})` : '',
      r.dlmmHot ? 'DLMM-HOT' : '',
    ].filter(Boolean).join(' ');
    console.log(
      `  ${String(r.symbols).padEnd(16)} ${String(r.dex).padEnd(9)} ` +
      `${String(r.feeBps + 'b').padStart(4)}  ${_fmtUsd(r.tvl).padStart(15)}  ` +
      `${_fmtUsd(r.volume24h).padStart(7)}  ${String(r.turnover).padStart(7)}  ${flags}`
    );
  }
  console.log(`\n  pools=${summary.pools}  ranked=${summary.ranked}  ` +
    `round-trip pairs=${summary.roundTripPairs}  hot-DLMM=${summary.hotDlmm}` +
    `${summary.activityDataPresent ? '' : '  [activity data MISSING]'}`);
  console.log('');
}

module.exports = {
  rankPoolsByTurnover,
  printTurnoverTable,
  // exported for testing / reuse
  _internals: { poolTvl, poolVolume24h, pairKeyOf, pairSymbols, poolDex },
};
