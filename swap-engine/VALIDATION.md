# Validation

Validated on Node v22.16.0.

## Commands

```bash
npm test
npm run demo
```

## Result

- 9 tests passed
- 0 tests failed
- Demo completed `SOL -> TokenB -> TokenC -> SOL`
- Starting amount: `1,000,000,000`
- Final amount: `1,020,000,000`
- Realized result: `200 bps`

The tests cover:

- closure within remaining hop budget
- current-mint-only frontier emission
- stale and disconnected edge filtering
- signal deduplication and bounded queue replacement
- complete stateful cycle
- incompatible input-mint rejection
- pool state-version rejection
- timeout-driven safe unwind
- post-trade wallet balance-delta accounting
