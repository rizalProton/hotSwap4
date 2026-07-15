const { createRequire } = require("node:module");
const { toDirectedEdge } = require("./enrichedPoolAdapter.js");

const require = createRequire(import.meta.url);
const { createPoolRefresher } = require("../utilities/refreshPoolState.js");

class LivePoolStateProvider {
  constructor({
    connection,
    poolsByAddress,
    graph,
    mathAdapter,
    currentSlotCommitment = "confirmed"
  }) {
    if (!connection) throw new TypeError("connection is required");
    if (!poolsByAddress) throw new TypeError("poolsByAddress is required");
    this.connection = connection;
    this.poolsByAddress = poolsByAddress;
    this.graph = graph;
    this.mathAdapter = mathAdapter;
    this.currentSlotCommitment = currentSlotCommitment;
    this.refresher = createPoolRefresher({ endpoints: connection.__rpcManager || connection });
  }

  async getCurrentSlot() {
    return this.connection.getSlot(this.currentSlotCommitment);
  }

  async refreshEdge(edge) {
    const pool = this.poolsByAddress.get(edge.poolAddress);
    if (!pool) throw new Error(`unknown pool: ${edge.poolAddress}`);

    await this.refresher.refreshInPlace([pool]);
    const refreshedSlot = setStableStateVersion(pool, edge.poolAddress, edge.lastUpdatedSlot);

    this.poolsByAddress.set(edge.poolAddress, pool);
    return toDirectedEdge(pool, edge.tokenInMint, edge.tokenOutMint, {
      now: Date.now(),
      currentSlot: refreshedSlot,
      mathAdapter: this.mathAdapter
    });
  }

  async refreshAll({ currentSlot } = {}) {
    const pools = [...this.poolsByAddress.values()];
    await this.refresher.refreshInPlace(pools);

    let refreshed = 0;
    let skipped = 0;
    for (const pool of pools) {
      const poolAddress = pool.poolAddress || pool.address || pool.id;
      const tokenXMint = pool.tokenXMint || pool.baseMint || pool.mintA;
      const tokenYMint = pool.tokenYMint || pool.quoteMint || pool.mintB;
      if (!poolAddress || !tokenXMint || !tokenYMint || tokenXMint === tokenYMint) {
        skipped += 1;
        continue;
      }

      const fallbackSlot = currentSlot ?? existingGraphSlot(this.graph, poolAddress) ?? pool.lastUpdatedSlot;
      const refreshedSlot = setStableStateVersion(pool, poolAddress, fallbackSlot);
      this.poolsByAddress.set(poolAddress, pool);
      this.graph?.replaceEdge(toDirectedEdge(pool, tokenXMint, tokenYMint, {
        now: Date.now(),
        currentSlot: refreshedSlot,
        mathAdapter: this.mathAdapter
      }));
      this.graph?.replaceEdge(toDirectedEdge(pool, tokenYMint, tokenXMint, {
        now: Date.now(),
        currentSlot: refreshedSlot,
        mathAdapter: this.mathAdapter
      }));
      refreshed += 1;
    }

    return { refreshed, skipped };
  }
}

function setStableStateVersion(pool, poolAddress, fallbackSlot = 0) {
  const refreshedSlot = pool.hydratedSlot ?? pool.slot ?? pool.lastUpdatedSlot ?? fallbackSlot ?? 0;
  const stateSequence = pool.stateSequence ?? pool.version ?? 1;
  pool.lastUpdatedSlot = refreshedSlot;
  pool.stateVersion = [
    poolAddress,
    refreshedSlot,
    stateSequence
  ].join(":");
  return refreshedSlot;
}

function existingGraphSlot(graph, poolAddress) {
  if (typeof graph?.allEdges !== "function") return null;
  const edge = graph.allEdges().find((candidate) => candidate.poolAddress === poolAddress);
  return edge?.lastUpdatedSlot ?? null;
}
module.exports = LivePoolStateProvider;