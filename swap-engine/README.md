# Solana Stateful Swap Engine Core

This is a runnable, dependency-free Node.js MVP for the **one-hop-at-a-time**
state machine described in `SPEC-1-Solana-Stateful-Swap-Engine.md`.

The scanner does one simple thing:

> Read the wallet's current mint, score only outgoing executable edges, and emit
> the best one-hop signal only when the resulting token can still return to the
> target mint inside the remaining hop budget.

It does **not** try to submit an atomic multi-leg transaction.

## Included

- Directed pool graph and current-mint frontier scan
- Bounded closure check to the target mint
- Conservative suffix projection
- Profit threshold plus safety margin
- Bounded, deduplicated signal queue
- Immediate fresh-state revalidation
- Pool-version, slot-age, time-age, quote-drift, balance, and compatibility gates
- Stateful inventory transitions
- Dry-run executor
- Timeout/manual safe unwind that ignores profit but keeps freshness/risk gates
- JSONL event store and atomic JSON state store adapters
- Structured logs
- Unit tests and a working three-swap dry-run demo

## Run

```bash
npm test
npm run demo
```

No package installation is required.

## Core contract

A graph edge must provide:

```js
{
  poolAddress,
  dexType,
  mathType,
  tokenInMint,
  tokenOutMint,
  executionReady,
  stale,
  outlier,
  quarantined,
  lastUpdatedSlot,
  lastHydratedAt,
  stateVersion,
  quoteExactIn(amountAtomic) => bigint | {
    outputAmountAtomic: bigint,
    feeAtomic?: bigint
  }
}
```

The production integration point is deliberately narrow:

1. Adapt hydrated Whirlpool, Raydium CLMM, Meteora DLMM, and CPMM pools into
   directed edges with deterministic `quoteExactIn`.
2. Implement `poolStateProvider.refreshEdge(edge)` from the live account cache.
3. Replace `DryRunExecutor` with an executor that constructs, signs, submits,
   confirms, and balance-checks one swap.
4. Use `JsonFileStateStore` and `JsonlEventStore`, or replace them with
   SQLite/PostgreSQL adapters.

## Example wiring

```js
const engine = new SwapEngine({
  graph,
  executor: productionExecutor,
  poolStateProvider: liveAccountCache,
  balanceProvider: walletBalanceProvider,
  stateStore: new JsonFileStateStore("./data/engine-state.json"),
  eventStore: new JsonlEventStore("./data/audit.jsonl"),
  config: {
    startMint: SOL,
    targetMint: SOL,
    maxHops: 4,
    minProfitBps: 3,
    safetyBufferBps: 1.5,
    maxSignalAgeMs: 750,
    maxPoolSlotLag: 2,
    maxIntermediateHoldMs: 30_000,
    allowedTokens
  }
});
```

## Why the transaction adapter is not fabricated

The uploaded material describes `_enrichment.js` and
`_divergenceScannerTop.js`, but those source files, wallet/signing flow,
program instruction builders, and pool account decoders were not included.
The core therefore exposes exact integration interfaces instead of pretending
that generic code can safely execute every supported DEX.

## Existing scanner bug noted by the specification

In your existing `_divergenceScannerTop.js`, change:

```js
enableTwoLeg: process.env.ENABLE_TWO_LEG === "true" || args.twoLeg === true,
```

to:

```js
enableTwoLeg: process.env.ENABLE_TWO_LEG === "true",
```

and parse the CLI flag after the defaults object is created.
