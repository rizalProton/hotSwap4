import { asBigInt, subtractBps } from "./amount.js";
import { bestProjectionToTarget, isEdgeUsable } from "./projection.js";

export async function markPortfolioToTarget({
  graph,
  balancesByMint,
  targetMint,
  maxHops = 3,
  allowedTokens,
  currentSlot,
  maxPoolSlotLag = 2,
  maxPoolAgeMs = 2_000,
  now = Date.now(),
  haircutsBpsByMint = new Map()
}) {
  if (!graph) throw new TypeError("graph is required");
  if (!(balancesByMint instanceof Map)) {
    throw new TypeError("balancesByMint must be a Map");
  }
  if (!targetMint) throw new TypeError("targetMint is required");

  const valuesByMint = new Map();
  const marks = new Map();
  const unpricedMints = new Set();

  const edgeFilter = (edge, amountAtomic) =>
    isEdgeUsable(edge, {
      allowedTokens,
      currentSlot,
      maxPoolSlotLag,
      maxPoolAgeMs,
      now,
      amountAtomic
    });

  for (const [mint, rawBalance] of balancesByMint) {
    const balanceAtomic = asBigInt(rawBalance);
    if (balanceAtomic <= 0n) {
      valuesByMint.set(mint, 0n);
      marks.set(mint, {
        mint,
        balanceAtomic,
        valueAtomic: 0n,
        path: [],
        haircutBps: Number(haircutsBpsByMint.get(mint) ?? 0)
      });
      continue;
    }

    let projection;
    if (mint === targetMint) {
      projection = {
        finalAmountAtomic: balanceAtomic,
        path: []
      };
    } else {
      projection = await bestProjectionToTarget({
        graph,
        fromMint: mint,
        targetMint,
        amountAtomic: balanceAtomic,
        maxHops,
        allowedTokens,
        edgeFilter
      });
    }

    if (!projection) {
      unpricedMints.add(mint);
      continue;
    }

    const haircutBps = Number(haircutsBpsByMint.get(mint) ?? 0);
    const valueAtomic = haircutBps > 0
      ? subtractBps(projection.finalAmountAtomic, haircutBps)
      : projection.finalAmountAtomic;
    valuesByMint.set(mint, valueAtomic);
    marks.set(mint, {
      mint,
      balanceAtomic,
      valueAtomic,
      rawValueAtomic: projection.finalAmountAtomic,
      haircutBps,
      path: projection.path.map(({ edge }) => ({
        poolAddress: edge.poolAddress,
        inputMint: edge.tokenInMint,
        outputMint: edge.tokenOutMint
      }))
    });
  }

  const totalValueAtomic = [...valuesByMint.values()]
    .reduce((sum, value) => sum + value, 0n);

  return {
    targetMint,
    totalValueAtomic,
    valuesByMint,
    marks,
    unpricedMints
  };
}
