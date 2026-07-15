/* ============================================================================
 *  TICK ARRAY SHAPE RECONCILER  —  the fix for "who hydrates what, and in
 *  which SHAPE" (your correct diagnosis)
 * ============================================================================
 *
 *  THE ROOT CAUSE (found via the grep + Q_WHIRLPOOL sim contract)
 *  -------------------------------------------------------------
 *  pool.tickArrays is written by THREE producers in THREE shapes:
 *
 *    A) fetch_pools_batch.with_pool_selector.js:1205
 *         tickArrays = deriveTickArrays(...)      -> ADDRESSES / PDAs only
 *    B) onchainTickHydration.js:140,148
 *         treats tickArrays as ADDRESSES to fetch -> expects shape (A) as input
 *    C) tickArrayHydration.js:151 (my earlier file)
 *         tickArrays = [{startTickIndex, address, data(base64)}]
 *
 *  But the SIMULATOR (Q_WHIRLPOOL.js normalizeWhirlpoolTickArrays, line 375-390)
 *  REQUIRES each tickArray to be:
 *         { startTickIndex, ticks: [ { tick, liquidityNet, ... }, ... ] }
 *  i.e. DECODED tick liquidity, read from pool.tickArrays OR
 *  pool.aux.whirlpool.tickArrays.
 *
 *  So a pool can have tickArrays = [addresses] (shape A) and the sim sees no
 *  .ticks[] -> "Whirlpool math state missing (need ... tickArrays)". The mid
 *  works (needs only sqrtPrice); the SIM fails (needs decoded tick liquidity).
 *  Which shape a pool ends up in depends on WHICH of the 7 hydrateTickState
 *  callers touched it last -> your non-deterministic, side-by-side conflict.
 *
 *  THIS FILE
 *  ---------
 *  1) classifyTickArrayShape(pool) — tells you which shape a pool currently has
 *     (addresses | decoded | base64 | none). Use it to SEE the conflict per pool.
 *  2) needsDecode(pool) — true if tickArrays are addresses/base64 (sim can't use).
 *  3) A single canonical CONTRACT documented below that every hydrator must meet.
 *
 *  It does NOT fetch (no RPC here) — it diagnoses and reconciles shape. The
 *  actual decode must happen in ONE hydrator (see CONSOLIDATION PLAN below).
 * ========================================================================== */

'use strict';

function asArray(v) { return Array.isArray(v) ? v : []; }

function hasDecodedTickArrayEntry(entry) {
  return Boolean(
    entry
    && typeof entry === 'object'
    && (Array.isArray(entry.ticks) || Array.isArray(entry.data?.ticks))
  );
}

function getTickArrays(pool = {}) {
  const candidates = [
    pool.tickArrayData,
    pool?.aux?.clmm?.tickArrayData,
    pool?.aux?.whirlpool?.tickArrayData,
    pool?.aux?.whirlpool?.tickArrays,
    pool.tickArrays,
  ];
  const decoded = candidates.find((value) => asArray(value).some(hasDecodedTickArrayEntry));
  if (decoded) return decoded;
  return candidates.find((value) => asArray(value).length) || [];
}

/**
 * classifyTickArrayShape — which of the conflicting shapes is this pool in?
 *   'none'      : no tickArrays at all
 *   'addresses' : array of strings/pubkeys (shape A) — SIM CANNOT USE
 *   'base64'    : entries have .data as base64 string (shape C) — SIM CANNOT USE (needs decode)
 *   'decoded'   : entries have .ticks[] with liquidityNet (SIM shape) — GOOD
 *   'mixed'     : inconsistent
 */
function classifyTickArrayShape(pool = {}) {
  const arr = getTickArrays(pool);
  if (!arr.length) return 'none';

  let decoded = 0, base64 = 0, addresses = 0, other = 0;
  for (const e of arr) {
    if (typeof e === 'string') { addresses++; continue; }
    if (e && Array.isArray(e.ticks)) { decoded++; continue; }
    if (e && e.data && Array.isArray(e.data.ticks)) { decoded++; continue; }
    if (e && typeof e.data === 'string') { base64++; continue; }
    if (e && (e.address || e.pubkey) && !e.ticks && !e.data) { addresses++; continue; }
    other++;
  }
  if (decoded && !base64 && !addresses && !other) return 'decoded';
  if (addresses && !decoded && !base64) return 'addresses';
  if (base64 && !decoded && !addresses) return 'base64';
  return 'mixed';
}

/** Sim can only use the 'decoded' shape. */
function isSimReady(pool = {}) {
  return classifyTickArrayShape(pool) === 'decoded';
}
function needsDecode(pool = {}) {
  const s = classifyTickArrayShape(pool);
  return s === 'addresses' || s === 'base64' || s === 'mixed';
}

/**
 * diagnoseTickArrays — run over a pool set, return a per-shape tally + the list
 * of pools that will FAIL the sim (so you can see the conflict at a glance).
 */
function diagnoseTickArrays(pools = []) {
  const tally = { none: 0, addresses: 0, base64: 0, decoded: 0, mixed: 0 };
  const willFailSim = [];
  if (!Array.isArray(pools)) {
    return {
      tally,
      willFailSim,
      error: `diagnoseTickArrays expected an array, got ${pools === null ? 'null' : typeof pools}`,
      keys: pools && typeof pools === 'object' ? Object.keys(pools) : [],
    };
  }
  for (const p of pools) {
    const type = String(p.type || p.dexType || p.dex || '').toLowerCase();
    if (!type.includes('whirl') && !type.includes('clmm')) continue;
    const shape = classifyTickArrayShape(p);
    tally[shape] = (tally[shape] || 0) + 1;
    if (shape !== 'decoded') {
      willFailSim.push({ pool: String(p.poolAddress || p.address || '').slice(0, 8), shape });
    }
  }
  return { tally, willFailSim };
}

module.exports = {
  classifyTickArrayShape,
  isSimReady,
  needsDecode,
  diagnoseTickArrays,
  getTickArrays,
};

/* ============================================================================
 *  CONSOLIDATION PLAN  (the real fix — end the multi-hydrator conflict)
 *  -------------------------------------------------------------------
 *  You have 7 callers of hydrateTickState and 3 producers of pool.tickArrays in
 *  3 shapes. Patch-by-patch will keep colliding. The durable fix:
 *
 *  1) ONE CONTRACT. Declare the canonical pool tick shape = the SIM shape:
 *        pool.tickArrays = [ { startTickIndex, ticks:[{tick, liquidityNet,
 *                              liquidityGross, initialized}] } ]
 *     Everything downstream reads THIS. Nothing reads addresses/base64.
 *
 *  2) ONE HYDRATOR does fetch+decode to that shape. Candidate: onchainTickHydration
 *     .hydrateTickState — it already fetches tick accounts. Make it DECODE the
 *     account data into ticks[] with liquidityNet (not just fetch raw), and write
 *     the decoded shape. deriveTickArrays (in fetch_pools_batch) should ONLY
 *     produce the address list that hydrateTickState consumes internally — its
 *     output must NOT be left on pool.tickArrays as the final value.
 *
 *  3) ORDER: fetch/derive addresses -> hydrateTickState(decode) -> stampFreshness
 *     -> write file. The scanner and arbBot BOTH read the same written file, so
 *     both get the decoded shape. No side-by-side re-hydration in different shapes.
 *
 *  4) RETIRE DUPLICATES so nothing competes:
 *        - fetch_pools_batch.js  vs  .runtime_fixed.js  vs  .with_pool_selector.js
 *          -> keep ONE (the selector version looks current). Archive the others.
 *        - rpcConnectionManager copy.js, rpcRateLimiter copy.js, batchProcess copy.js
 *          -> delete the "copy" files; they're landmines.
 *        - tickArrayHydration.js (mine, base64 shape) — only keep if you make it
 *          emit the DECODED shape; otherwise retire it in favor of hydrateTickState.
 *
 *  5) VERIFY with diagnoseTickArrays(pools) right before the sim: if tally.decoded
 *     == number of whirlpool/clmm pools and willFailSim is empty, the conflict is
 *     gone. If any show 'addresses'/'base64', that hydrator didn't decode.
 *
 *  Add this ONE line before arbBot simulates (and in the scanner after hydrate):
 *      const { diagnoseTickArrays } = require('./tickArrayShapeReconciler');
 *      console.log('[tickshape]', JSON.stringify(diagnoseTickArrays(pools).tally));
 *  That single log line, on your live run, tells you exactly which shape your
 *  pools are in and whether the consolidation worked — no guessing.
 * ========================================================================== */
