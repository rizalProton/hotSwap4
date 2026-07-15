'use strict';

/**
 * wsCache.js — Helius Enhanced WebSocket cache layer
 *
 * Maintains a persistent WebSocket connection to stream:
 *   - Slot progression (slotSubscribe) — eliminates missing ticks
 *   - Account data (accountSubscribe) — eliminates RPC fetches for hot accounts
 *   - Blockhash pre-cache (RPC timer) — eliminates blocking getLatestBlockhash
 *
 * Usage:
 *   const cache = require('./utilities/wsCache');
 *   await cache.start();                          // connect + subscribe
 *   cache.subscribeAccount('149c9a...');           // add account to watch
 *   const slot  = cache.getSlot();                // instant, no RPC
 *   const bh    = cache.getCachedBlockhash();     // instant, pre-fetched
 *   const data  = cache.getAccountData('149c9a...');  // from WS stream
 *   cache.stop();                                 // cleanup
 */

const WebSocket = require('ws');
const { Connection } = require('@solana/web3.js');
const dotenv = require('dotenv');
dotenv.config();

// ── Config ──────────────────────────────────────────────────────────────

const WSS_URL = process.env.HELIUS_WSS2
  || process.env.HELIUS_WSS1
  || process.env.HELIUS_WSS
  || (() => {
    const key = process.env.HELIUS_API_KEY2 || process.env.HELIUS_API_KEY1 || '';
    return key ? `wss://mainnet.helius-rpc.com/?api-key=${key}` : '';
  })();

const BLOCKHASH_RPC = process.env.HELIUS_ENDPOINT2
  || process.env.HELIUS_ENDPOINT1
  || process.env.RPC_URL
  || process.env.RPC
  || '';

const PING_INTERVAL_MS = 30_000;
const BLOCKHASH_REFRESH_MS = Number(process.env.WS_BLOCKHASH_REFRESH_MS || 2_000);
const MAX_RECONNECT_DELAY_MS = 30_000;

// ── State ───────────────────────────────────────────────────────────────

let ws = null;
let connected = false;
let reconnectDelay = 1_000;
let pingTimer = null;
let blockhashTimer = null;
let stopping = false;
let startPromiseResolve = null;
let msgIdCounter = 100;

// Slot state
let latestSlot = 0;
let slotUpdatedAt = 0;
let slotSubId = null;

// Blockhash state
let cachedBlockhash = null;
let cachedLastValidBlockHeight = 0;
let blockhashFetchedAt = 0;
let blockhashConnection = null;

// Account subscriptions: pubkey → { subId, data, slot, updatedAt, encoding }
const accountSubs = new Map();
// Pending subscribe requests: msgId → pubkey
const pendingAccountSubs = new Map();
// Pending slot subscribe: msgId
let pendingSlotSubMsgId = null;

// ── Public API ──────────────────────────────────────────────────────────

function getSlot() {
  return latestSlot;
}

function getSlotAge() {
  return slotUpdatedAt ? Date.now() - slotUpdatedAt : Infinity;
}

function getCachedBlockhash() {
  if (!cachedBlockhash) return null;
  return {
    blockhash: cachedBlockhash,
    lastValidBlockHeight: cachedLastValidBlockHeight,
    ageMs: Date.now() - blockhashFetchedAt,
  };
}

function getAccountData(pubkey) {
  const entry = accountSubs.get(pubkey);
  if (!entry || !entry.data) return null;
  return {
    data: entry.data,
    slot: entry.slot,
    updatedAt: entry.updatedAt,
    ageMs: Date.now() - entry.updatedAt,
    lamports: entry.lamports,
    owner: entry.owner,
    encoding: entry.encoding,
  };
}

function getAccountBuffer(pubkey) {
  const entry = accountSubs.get(pubkey);
  if (!entry || !entry.data) return null;
  if (Buffer.isBuffer(entry.data)) return entry.data;
  if (Array.isArray(entry.data) && entry.data[1] === 'base64') {
    return Buffer.from(entry.data[0], 'base64');
  }
  return null;
}

function isAccountSubscribed(pubkey) {
  return accountSubs.has(pubkey);
}

function listSubscribedAccounts() {
  const out = [];
  for (const [pubkey, entry] of accountSubs) {
    out.push({
      pubkey,
      hasData: !!entry.data,
      slot: entry.slot,
      updatedAt: entry.updatedAt,
    });
  }
  return out;
}

function stats() {
  return {
    connected,
    slot: latestSlot,
    slotAge: getSlotAge(),
    blockhashAge: blockhashFetchedAt ? Date.now() - blockhashFetchedAt : null,
    accountSubs: accountSubs.size,
    accountsWithData: Array.from(accountSubs.values()).filter((e) => !!e.data).length,
  };
}

// ── Account subscribe/unsubscribe ───────────────────────────────────────

function subscribeAccount(pubkey, options = {}) {
  if (!pubkey) return;
  const key = String(pubkey);

  if (!accountSubs.has(key)) {
    accountSubs.set(key, {
      subId: null,
      data: null,
      slot: 0,
      updatedAt: 0,
      lamports: 0,
      owner: null,
      encoding: options.encoding || 'base64',
    });
  }

  if (connected && ws && ws.readyState === WebSocket.OPEN) {
    _sendAccountSubscribe(key, options);
  }
}

function subscribeAccounts(pubkeys, options = {}) {
  for (const pk of pubkeys || []) {
    subscribeAccount(pk, options);
  }
}

function unsubscribeAccount(pubkey) {
  const key = String(pubkey);
  const entry = accountSubs.get(key);
  if (!entry) return;

  if (entry.subId != null && connected && ws && ws.readyState === WebSocket.OPEN) {
    const id = ++msgIdCounter;
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'accountUnsubscribe',
      params: [entry.subId],
    }));
  }

  accountSubs.delete(key);
}

// ── Start / Stop ────────────────────────────────────────────────────────

function start(options = {}) {
  if (connected || ws) return Promise.resolve();
  stopping = false;

  const wssUrl = options.wssUrl || WSS_URL;
  if (!wssUrl) {
    console.warn('[wsCache] No WebSocket URL configured. Set HELIUS_WSS2 or HELIUS_API_KEY2 in .env');
    return Promise.resolve();
  }

  const rpcUrl = options.blockhashRpc || BLOCKHASH_RPC;
  if (rpcUrl) {
    blockhashConnection = new Connection(rpcUrl, 'confirmed');
  }

  return new Promise((resolve) => {
    startPromiseResolve = resolve;
    _connect(wssUrl);
  });
}

function stop() {
  stopping = true;
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (blockhashTimer) { clearInterval(blockhashTimer); blockhashTimer = null; }
  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
  }
  connected = false;
  slotSubId = null;
  for (const entry of accountSubs.values()) {
    entry.subId = null;
  }
}

// ── WebSocket internals ─────────────────────────────────────────────────

function _connect(wssUrl) {
  if (stopping) return;

  ws = new WebSocket(wssUrl);

  ws.on('open', () => {
    connected = true;
    reconnectDelay = 1_000;

    _sendSlotSubscribe();

    for (const [pubkey, entry] of accountSubs) {
      if (entry.subId == null) {
        _sendAccountSubscribe(pubkey, { encoding: entry.encoding });
      }
    }

    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.ping();
    }, PING_INTERVAL_MS);

    _startBlockhashRefresh();

    if (startPromiseResolve) {
      startPromiseResolve();
      startPromiseResolve = null;
    }

    const masked = wssUrl.replace(/api-key=[^&]+/, 'api-key=***');
    console.log(`[wsCache] Connected to ${masked}`);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    // Subscription confirmations (result is the subscription ID)
    if (msg.id != null && msg.result !== undefined) {
      _handleSubscriptionConfirmation(msg.id, msg.result);
      return;
    }

    // Notifications
    if (msg.method === 'slotNotification') {
      _handleSlotNotification(msg.params);
    } else if (msg.method === 'accountNotification') {
      _handleAccountNotification(msg.params);
    }
  });

  ws.on('close', () => {
    connected = false;
    slotSubId = null;
    for (const entry of accountSubs.values()) {
      entry.subId = null;
    }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }

    if (!stopping) {
      console.log(`[wsCache] Disconnected. Reconnecting in ${reconnectDelay}ms...`);
      setTimeout(() => _connect(wssUrl), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    }
  });

  ws.on('error', (err) => {
    console.warn(`[wsCache] WebSocket error: ${err.message || err}`);
  });
}

function _sendSlotSubscribe() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const id = ++msgIdCounter;
  pendingSlotSubMsgId = id;
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'slotSubscribe',
    params: [],
  }));
}

function _sendAccountSubscribe(pubkey, options = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const id = ++msgIdCounter;
  pendingAccountSubs.set(id, pubkey);
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'accountSubscribe',
    params: [
      pubkey,
      {
        encoding: options.encoding || 'base64',
        commitment: options.commitment || 'confirmed',
      },
    ],
  }));
}

function _handleSubscriptionConfirmation(msgId, subId) {
  if (msgId === pendingSlotSubMsgId) {
    slotSubId = subId;
    pendingSlotSubMsgId = null;
    return;
  }

  const pubkey = pendingAccountSubs.get(msgId);
  if (pubkey) {
    pendingAccountSubs.delete(msgId);
    const entry = accountSubs.get(pubkey);
    if (entry) entry.subId = subId;
  }
}

function _handleSlotNotification(params) {
  const result = params?.result;
  if (!result) return;
  const slot = result.slot ?? result.root ?? 0;
  if (slot > latestSlot) {
    latestSlot = slot;
    slotUpdatedAt = Date.now();
  }
}

function _handleAccountNotification(params) {
  const subId = params?.subscription;
  const result = params?.result;
  if (subId == null || !result) return;

  for (const [pubkey, entry] of accountSubs) {
    if (entry.subId === subId) {
      const value = result.value;
      if (value) {
        entry.data = value.data;
        entry.lamports = value.lamports ?? 0;
        entry.owner = value.owner ?? null;
        entry.slot = result.context?.slot ?? latestSlot;
        entry.updatedAt = Date.now();
      }
      break;
    }
  }
}

// ── Blockhash pre-cache ─────────────────────────────────────────────────

function _startBlockhashRefresh() {
  if (blockhashTimer) clearInterval(blockhashTimer);
  if (!blockhashConnection) return;

  const refresh = async () => {
    try {
      const { blockhash, lastValidBlockHeight } = await blockhashConnection.getLatestBlockhash('confirmed');
      cachedBlockhash = blockhash;
      cachedLastValidBlockHeight = lastValidBlockHeight;
      blockhashFetchedAt = Date.now();
    } catch (err) {
      // Don't clear cache on transient failure — stale is better than absent
    }
  };

  refresh();
  blockhashTimer = setInterval(refresh, BLOCKHASH_REFRESH_MS);
}

// ── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  start,
  stop,
  getSlot,
  getSlotAge,
  getCachedBlockhash,
  getAccountData,
  getAccountBuffer,
  subscribeAccount,
  subscribeAccounts,
  unsubscribeAccount,
  isAccountSubscribed,
  listSubscribedAccounts,
  stats,
};
