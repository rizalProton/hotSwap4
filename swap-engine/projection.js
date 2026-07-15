const { asBigInt } = require("./amount.js");

function isEdgeUsable(
  edge,
  {
    allowedTokens,
    currentSlot,
    maxPoolSlotLag = Number.POSITIVE_INFINITY,
    now = Date.now(),
    maxPoolAgeMs = Number.POSITIVE_INFINITY,
    amountAtomic,
    excludedPools = new Set()
  } = {}
) {
  if (!edge.executionReady || edge.stale || edge.outlier || edge.quarantined) return false;
  if (excludedPools.has(edge.poolAddress)) return false;
  if (allowedTokens && !allowedTokens.has(edge.tokenOutMint)) return false;

  if (
    Number.isFinite(currentSlot) &&
    Number.isFinite(edge.lastUpdatedSlot) &&
    currentSlot - edge.lastUpdatedSlot > maxPoolSlotLag
  ) {
    return false;
  }

  const hydratedAt =
    typeof edge.lastHydratedAt === "string"
      ? Date.parse(edge.lastHydratedAt)
      : Number(edge.lastHydratedAt);
  if (
    Number.isFinite(maxPoolAgeMs) &&
    Number.isFinite(hydratedAt) &&
    hydratedAt > 0 &&
    now - hydratedAt > maxPoolAgeMs
  ) {
    return false;
  }

  if (amountAtomic !== undefined && edge.maxInputAtomic !== undefined) {
    if (asBigInt(amountAtomic) > asBigInt(edge.maxInputAtomic, "edge.maxInputAtomic")) {
      return false;
    }
  }

  return true;
}

async function quoteEdge(edge, amountAtomic) {
  const inputAmount = asBigInt(amountAtomic, "amountAtomic");
  if (inputAmount <= 0n) throw new RangeError("amountAtomic must be positive");

  const raw = await edge.quoteExactIn(inputAmount);
  const outputAmount = asBigInt(
    raw && typeof raw === "object" && "outputAmountAtomic" in raw
      ? raw.outputAmountAtomic
      : raw,
    "quote output"
  );
  if (outputAmount <= 0n) throw new RangeError("quote output must be positive");

  return {
    inputAmountAtomic: inputAmount,
    outputAmountAtomic: outputAmount,
    feeAtomic:
      raw && typeof raw === "object" && "feeAtomic" in raw
        ? asBigInt(raw.feeAtomic, "feeAtomic")
        : 0n,
    metadata: raw && typeof raw === "object" ? raw.metadata ?? null : null
  };
}

function canCloseToTarget({
  graph,
  fromMint,
  targetMint,
  remainingHops,
  allowedTokens,
  edgeFilter = () => true
}) {
  if (fromMint === targetMint) return true;
  if (!Number.isInteger(remainingHops) || remainingHops < 1) return false;

  const queue = [{ mint: fromMint, depth: 0 }];
  const bestDepth = new Map([[fromMint, 0]]);

  while (queue.length > 0) {
    const { mint, depth } = queue.shift();
    if (depth >= remainingHops) continue;

    for (const edge of graph.outgoing(mint)) {
      if (allowedTokens && !allowedTokens.has(edge.tokenOutMint)) continue;
      if (!edgeFilter(edge)) continue;

      const nextDepth = depth + 1;
      if (edge.tokenOutMint === targetMint) return true;

      const previousDepth = bestDepth.get(edge.tokenOutMint);
      if (previousDepth !== undefined && previousDepth <= nextDepth) continue;
      bestDepth.set(edge.tokenOutMint, nextDepth);
      queue.push({ mint: edge.tokenOutMint, depth: nextDepth });
    }
  }

  return false;
}

async function bestProjectionToTarget({
  graph,
  fromMint,
  targetMint,
  amountAtomic,
  maxHops,
  allowedTokens,
  edgeFilter = () => true,
  excludedPools = new Set(),
  maxBranchesPerNode = 16,
  maxPrequoteBranches = 64,
  maxVisitedStates = 2_000
}) {
  const startingAmount = asBigInt(amountAtomic, "amountAtomic");
  if (fromMint === targetMint) {
    return { finalAmountAtomic: startingAmount, path: [] };
  }
  if (!Number.isInteger(maxHops) || maxHops < 1) return null;

  let best = null;
  let visitedStates = 0;

  async function visit(mint, amount, hopsLeft, path, visitedMints, usedPools) {
    visitedStates += 1;
    if (visitedStates > maxVisitedStates) return;

    if (mint === targetMint) {
      if (!best || amount > best.finalAmountAtomic) {
        best = { finalAmountAtomic: amount, path: [...path] };
      }
      return;
    }
    if (hopsLeft === 0) return;

    // Do not trust graph insertion order. Preselect liquid/low-fee edges, quote
    // them, then expand the branches with the highest executable output.
    const preselected = graph
      .outgoing(mint)
      .filter((edge) => {
        if (allowedTokens && !allowedTokens.has(edge.tokenOutMint)) return false;
        if (excludedPools.has(edge.poolAddress) || usedPools.has(edge.poolAddress)) return false;
        if (edge.tokenOutMint !== targetMint && visitedMints.has(edge.tokenOutMint)) return false;
        return edgeFilter(edge, amount);
      })
      .sort((a, b) => {
        const liquidityDelta = Number(b.liquidity ?? 0) - Number(a.liquidity ?? 0);
        if (liquidityDelta !== 0) return liquidityDelta;
        return Number(a.feeBps ?? 0) - Number(b.feeBps ?? 0);
      })
      .slice(0, Math.max(maxBranchesPerNode, maxPrequoteBranches));

    const quoted = [];
    for (const edge of preselected) {
      try {
        quoted.push({ edge, quote: await quoteEdge(edge, amount) });
      } catch {
        // A failed quote is not an executable branch.
      }
    }
    quoted.sort((a, b) =>
      a.quote.outputAmountAtomic === b.quote.outputAmountAtomic
        ? Number(a.edge.feeBps ?? 0) - Number(b.edge.feeBps ?? 0)
        : a.quote.outputAmountAtomic > b.quote.outputAmountAtomic ? -1 : 1
    );

    for (const { edge, quote } of quoted.slice(0, maxBranchesPerNode)) {
      const nextVisited = new Set(visitedMints);
      nextVisited.add(edge.tokenOutMint);
      const nextPools = new Set(usedPools);
      nextPools.add(edge.poolAddress);

      await visit(
        edge.tokenOutMint,
        quote.outputAmountAtomic,
        hopsLeft - 1,
        [...path, { edge, quote }],
        nextVisited,
        nextPools
      );
    }
  }

  await visit(
    fromMint,
    startingAmount,
    maxHops,
    [],
    new Set([fromMint]),
    new Set()
  );
  return best;
}
module.exports = {
  isEdgeUsable,
  quoteEdge,
  canCloseToTarget,
  bestProjectionToTarget
}