import { buildNextHopCandidates } from "./frontier.js";
import { createSignal } from "./signal.js";
import { NullEventStore } from "./persistence.js";
import { SilentLogger } from "./logger.js";

export class StatefulFrontierScanner {
  constructor({
    graph,
    queue,
    config = {},
    signalStore = new NullEventStore(),
    logger = new SilentLogger()
  }) {
    this.graph = graph;
    this.queue = queue;
    this.signalStore = signalStore;
    this.logger = logger;
    this.config = {
      minProfitBps: 3,
      safetyBufferBps: 1.5,
      slippageBufferBps: 0,
      priorityFeeBps: 0,
      staleStateBufferBps: 0,
      maxSignalAgeMs: 750,
      maxPoolSlotLag: 2,
      maxPoolAgeMs: 2_000,
      maxCandidates: 20,
      quoteTopN: 30,
      cycleMode: "target_projection",
      valueBaselineMode: "starting_value",
      ...config
    };
  }

  async scan(engineState, { currentSlot, now = Date.now() } = {}) {
    if (!engineState?.cycleId) return [];

    const candidates = await buildNextHopCandidates({
      graph: this.graph,
      currentMint: engineState.currentMint,
      currentAmountAtomic: engineState.currentAmountAtomic,
      startingTargetValueAtomic: engineState.startingValueAtomic,
      targetMint: engineState.targetMint,
      legIndex: engineState.legIndex,
      maxHops: engineState.maxHops,
      allowedTokens: this.config.allowedTokens,
      currentSlot,
      now,
      minProfitBps: this.config.minProfitBps,
      safetyBufferBps: this.config.safetyBufferBps,
      slippageBufferBps: this.config.slippageBufferBps,
      priorityFeeBps: this.config.priorityFeeBps,
      staleStateBufferBps: this.config.staleStateBufferBps,
      maxPoolSlotLag: this.config.maxPoolSlotLag,
      maxPoolAgeMs: this.config.maxPoolAgeMs,
      maxCandidates: this.config.maxCandidates,
      diagnosticsTopN: this.config.quoteTopN,
      cycleMode: this.config.cycleMode,
      valueBaselineMode: this.config.valueBaselineMode,
      opportunityComparableMints: this.config.opportunityComparableMints
    });

    this.logger.log("scanner_decision", {
      cycleId: engineState.cycleId,
      legIndex: engineState.legIndex,
      currentMint: engineState.currentMint,
      candidateCount: candidates.length,
      diagnostics: candidates.diagnostics
    });

    const emitted = [];
    for (const candidate of candidates) {
      const signalNow = Date.now();
      const signal = createSignal({
        candidate,
        cycleId: engineState.cycleId,
        legIndex: engineState.legIndex,
        maxHops: engineState.maxHops,
        maxSignalAgeMs: this.config.maxSignalAgeMs,
        now: signalNow
      });
      const result = this.queue.push(signal, signalNow);
      await this.signalStore.append({
        type: result.accepted ? "scanner_signal_pushed" : "scanner_signal_rejected",
        signal,
        queueResult: result,
        timestamp: new Date(signalNow).toISOString()
      });
      this.logger.log(
        result.accepted ? "scanner_signal_pushed" : "scanner_signal_rejected",
        {
          signalId: signal.signalId,
          cycleId: signal.cycleId,
          legIndex: signal.legIndex,
          inputMint: signal.inputMint,
          outputMint: signal.outputMint,
          poolAddress: signal.poolAddress,
          projectedNetBps: signal.projectedNetBps,
          estimatedOutputAtomic: signal.estimatedOutputAtomic,
          projectedFinalTargetAtomic: signal.projectedFinalTargetAtomic,
          feeBps: signal.reason?.feeBps,
          scoreMode: signal.reason?.scoreMode,
          immediateHoldBps: signal.reason?.immediateHoldBps,
          queueReason: result.reason
        }
      );
      if (result.accepted) emitted.push(signal);
    }

    return emitted;
  }
}
