# Integration Guide

The core is complete, but the uploaded material did not include the actual
`_enrichment.js`, `_divergenceScannerTop.js`, wallet signer, or DEX instruction
builders. This guide shows the exact seams to connect.

## 1. Convert each hydrated pool into two directed edges

Do this after your existing enrichment pass:

```js
graph.addEdge({
  poolAddress: pool.address,
  dexType: pool.dexType,
  mathType: pool.mathType,
  tokenInMint: pool.tokenXMint,
  tokenOutMint: pool.tokenYMint,
  feeBps: pool.feeBps,
  liquidity: pool.liquidity,
  executionReady: pool.executionReady,
  stale: pool.stale,
  outlier: pool.outlier,
  quarantined: pool.quarantined,
  lastUpdatedSlot: pool.lastUpdatedSlot,
  lastHydratedAt: pool.lastHydratedAt,
  stateVersion: pool.stateVersion,
  maxInputAtomic: pool.maxSafeInputXAtomic,
  quoteExactIn: (amountAtomic) =>
    quoteHydratedPoolExactIn(pool, pool.tokenXMint, amountAtomic)
});
```

Add the reverse edge with the mints and reserve/tick/bin direction reversed.

`quoteExactIn` must return a deterministic net amount using the current hydrated
state. It must not call a public quote API.

## 2. Refresh only the touched pool before execution

Implement:

```js
const poolStateProvider = {
  async getCurrentSlot() {
    return accountCache.currentSlot;
  },

  async refreshEdge(edge) {
    const pool = poolsByAddress.get(edge.poolAddress);
    const dependencies = getPoolAccountDependencies(pool);
    await accountCache.ensureFresh(dependencies);
    const refreshedPool = refreshPoolFromAccountCache(pool, accountCache);
    return toDirectedEdge(refreshedPool, edge.tokenInMint, edge.tokenOutMint);
  }
};
```

A changed `stateVersion` rejects the old signal. The scanner will immediately
emit a new one if the refreshed edge remains profitable.

## 3. Feed the scanner only the current engine state

```js
await scanner.scan(engine.snapshot(), {
  currentSlot: accountCache.currentSlot
});

const signal = queue.popBest({
  cycleId: engine.state.cycleId,
  legIndex: engine.state.legIndex,
  inputMint: engine.state.currentMint
});

if (signal) {
  await engine.processSignal(signal, {
    currentSlot: accountCache.currentSlot
  });
}
```

This is the entire “hold and swap for the next leg” loop.

## 4. Production executor contract

```js
const executor = {
  async execute({
    edge,
    inputAmountAtomic,
    minOutputAtomic,
    signal,
    unwind
  }) {
    const transaction = await buildOneSwapTransaction({
      edge,
      inputAmountAtomic,
      minOutputAtomic,
      wallet,
      unwind
    });

    const txSignature = await sendAndConfirm(transaction);

    return {
      txSignature,
      actualOutputAtomic: 0n,
      networkFeeTargetAtomic: await calculateNetworkFeeInTargetUnits(txSignature),
      confirmed: true,
      dryRun: false
    };
  },

  async confirm(result) {
    return result.confirmed;
  }
};
```

For live execution, `SwapEngine` ignores an executor-reported output amount and
uses the observed wallet output-token balance delta. This is enabled by default
through `requirePostTradeBalanceCheck: true`.

## 5. Existing CLI bug

Inside `parseCliArgs`, replace:

```js
enableTwoLeg: process.env.ENABLE_TWO_LEG === "true" || args.twoLeg === true,
```

with:

```js
enableTwoLeg: process.env.ENABLE_TWO_LEG === "true",
```

Then parse `--two-leg` after the defaults object exists.

## 6. Go-live sequence

Run the existing enriched pool math through the graph in dry-run mode first.
Compare every local quote against transaction simulation. Only enable signing
after each supported math type passes quote-drift tests for small notional sizes.

The intended order is:

1. CPMM
2. Whirlpool
3. Raydium CLMM
4. Meteora DLMM

Each adapter should have fixture tests for both directions, fee handling,
boundary liquidity, and stale dependent-account state.
