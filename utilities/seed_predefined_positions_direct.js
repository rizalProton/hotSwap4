require("dotenv").config();

const { readFile } = require("node:fs/promises");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction
} = require("@solana/web3.js");
const {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID
} = require("@solana/spl-token");
const { PairGraph } = require("../src/graph.js");
const {
  buildGraphFromEnrichedPools,
  loadEnrichedPools
} = require("../src/enrichedPoolAdapter.js");
const { LiveExecutor } = require("../src/liveExecutor.js");
const { WalletBalanceProvider } = require("../src/walletBalanceProvider.js");
const { quoteEdge } = require("../src/projection.js");
const { subtractBps } = require("../src/amount.js");

const MINTS = {
  WSOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  USD1: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
  PYUSD: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const send = args.send === true;
  const amountSol = args.amount || process.env.SEED_POSITION_SOL || "0.02";
  const amountAtomic = decimalToAtomic(amountSol, 9);
  const targets = String(args.targets || process.env.SEED_POSITION_TARGETS || "USDC,USDT,WSOL,PYUSD")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  const poolFiles = String(
    args.poolFiles ||
    process.env.SEED_POSITION_POOL_FILES ||
    "pools/03_ROUTED.with_pyusd_jlp_peers.json,pools/sol_pyusd_missing_fetch.ready.json"
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const slippageBps = Number(args.slippageBps || process.env.SEED_POSITION_SLIPPAGE_BPS || 4);
  const keypairPath = args.keypair || process.env.KEYPAIR_PATH || "keyPair/solflare_keypair.json";
  const rpcUrl = process.env.RPC_URL || process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL, HELIUS_RPC_URL, or SOLANA_RPC_URL is required");

  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = await loadKeypair(keypairPath);
  const currentSlot = await connection.getSlot("confirmed");
  const graph = new PairGraph();
  const pools = [];
  let edgeCount = 0;
  const skipped = [];

  for (const poolFile of poolFiles) {
    const loaded = loadEnrichedPools(poolFile);
    pools.push(...loaded);
    const result = buildGraphFromEnrichedPools(graph, loaded, {
      now: Date.now(),
      currentSlot
    });
    edgeCount += result.edgeCount;
    skipped.push(...result.skipped.map((item) => ({ ...item, poolFile })));
  }

  const executor = new LiveExecutor({
    connection,
    wallet,
    dryRun: !send,
    computeUnitLimit: Number(args.computeUnitLimit || process.env.COMPUTE_UNIT_LIMIT || 400000),
    computeUnitPriceMicroLamports: Number(
      args.computeUnitPriceMicroLamports ||
      process.env.COMPUTE_UNIT_PRICE_MICRO_LAMPORTS ||
      0
    )
  });
  const balances = new WalletBalanceProvider({
    connection,
    owner: wallet.publicKey
  });

  console.log(JSON.stringify({
    mode: send ? "send" : "simulate_only",
    wallet: wallet.publicKey.toBase58(),
    amountSol,
    amountAtomic: amountAtomic.toString(),
    targets,
    poolFiles,
    pools: pools.length,
    directedEdges: edgeCount,
    skipped: skipped.length,
    slippageBps
  }));

  for (const target of targets) {
    if (!MINTS[target]) throw new Error(`unknown target: ${target}`);
    if (target === "WSOL") {
      await wrapWsol({ connection, wallet, amountAtomic, send });
      continue;
    }

    try {
      await executeBestDirectSwap({
        graph,
        executor,
        balances,
        target,
        inputMint: MINTS.WSOL,
        outputMint: MINTS[target],
        amountAtomic,
        slippageBps,
        send
      });
    } catch (error) {
      const fallbackAllowed =
        ["PYUSD", "USD1"].includes(target) &&
        (
          String(error?.message || "").includes("no direct") ||
          String(error?.message || "").includes("no direct pool simulated successfully")
        );
      if (!fallbackAllowed) {
        throw error;
      }
      console.log(JSON.stringify({
        step: "fallback_route",
        target,
        route: `WSOL->USDC->${target}`,
        reason: error.message
      }));
      const usdcAmount = await executeBestDirectSwap({
        graph,
        executor,
        balances,
        target: `${target}_ENTRY_USDC`,
        inputMint: MINTS.WSOL,
        outputMint: MINTS.USDC,
        amountAtomic,
        slippageBps,
        send
      });
      await executeBestDirectSwap({
        graph,
        executor,
        balances,
        target,
        inputMint: MINTS.USDC,
        outputMint: MINTS[target],
        amountAtomic: usdcAmount,
        slippageBps,
        send,
        quoteOnlyIfDryRun: true
      });
    }
  }
}

async function executeBestDirectSwap({
  graph,
  executor,
  balances,
  target,
  inputMint,
  outputMint,
  amountAtomic,
  slippageBps,
  send,
  quoteOnlyIfDryRun = false
}) {
  const candidates = await quoteDirectEdges({
    graph,
    inputMint,
    outputMint,
    amountAtomic
  });

  for (const candidate of candidates) {
    const { edge, quote } = candidate;
    const minOutputAtomic = subtractBps(quote.outputAmountAtomic, slippageBps);

    console.log(JSON.stringify({
      step: "selected_direct_pool",
      target,
      poolAddress: edge.poolAddress,
      dexType: edge.dexType,
      mathType: edge.mathType,
      feeBps: edge.feeBps,
      inputMint: edge.tokenInMint,
      outputMint: edge.tokenOutMint,
      inputAmountAtomic: amountAtomic.toString(),
      quotedOutputAtomic: quote.outputAmountAtomic.toString(),
      minOutputAtomic: minOutputAtomic.toString()
    }));

    if (!send && quoteOnlyIfDryRun) {
      console.log(JSON.stringify({
        step: "quote_only",
        target,
        poolAddress: edge.poolAddress,
        quotedOutputAtomic: quote.outputAmountAtomic.toString(),
        dryRun: true
      }));
      return quote.outputAmountAtomic;
    }

    const preBalance = await balances.getBalance(edge.tokenOutMint);
    try {
      const result = await executor.execute({
        edge,
        inputAmountAtomic: amountAtomic,
        minOutputAtomic
      });
      const confirmed = await executor.confirm(result);
      if (!confirmed) throw new Error(`transaction not confirmed for ${target}`);

      const postBalance = await balances.getBalance(edge.tokenOutMint);
      const observedOutput = postBalance - preBalance;
      const outputAmount = send ? observedOutput : quote.outputAmountAtomic;
      console.log(JSON.stringify({
        step: send ? "swap_sent" : "simulation_ok",
        target,
        poolAddress: edge.poolAddress,
        txSignature: result.txSignature,
        observedOutputAtomic: observedOutput.toString(),
        quotedOutputAtomic: quote.outputAmountAtomic.toString(),
        dryRun: result.dryRun
      }));
      return outputAmount;
    } catch (error) {
      console.log(JSON.stringify({
        step: "execution_failed",
        target,
        poolAddress: edge.poolAddress,
        reason: error?.message || String(error)
      }));
    }
  }

  throw new Error(`no direct pool simulated successfully for ${target}`);
}

async function quoteDirectEdges({ graph, inputMint, outputMint, amountAtomic }) {
  const candidates = [];
  for (const edge of graph.outgoing(inputMint)) {
    if (edge.tokenOutMint !== outputMint) continue;
    if (!edge.executionReady || edge.stale || edge.outlier || edge.quarantined) continue;
    if (edge.maxInputAtomic !== undefined && amountAtomic > BigInt(edge.maxInputAtomic)) continue;
    try {
      const quote = await quoteEdge(edge, amountAtomic);
      candidates.push({ edge, quote });
    } catch (error) {
      console.log(JSON.stringify({
        step: "quote_failed",
        poolAddress: edge.poolAddress,
        outputMint,
        reason: error?.message || String(error)
      }));
    }
  }
  candidates.sort((a, b) => {
    if (a.quote.outputAmountAtomic === b.quote.outputAmountAtomic) {
      return Number(a.edge.feeBps ?? 0) - Number(b.edge.feeBps ?? 0);
    }
    return a.quote.outputAmountAtomic > b.quote.outputAmountAtomic ? -1 : 1;
  });
  if (!candidates.length) {
    throw new Error(`no direct pool quoted for ${inputMint}->${outputMint}`);
  }
  return candidates;
}

async function wrapWsol({ connection, wallet, amountAtomic, send }) {
  const owner = wallet.publicKey;
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(owner, wsolAta, owner, NATIVE_MINT),
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: wsolAta,
      lamports: amountAtomic
    }),
    createSyncNativeInstruction(wsolAta)
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = owner;
  tx.recentBlockhash = blockhash;
  tx.sign(wallet);

  const simulation = await connection.simulateTransaction(tx);
  if (simulation.value.err) {
    throw new Error(`WSOL wrap simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }

  if (!send) {
    console.log(JSON.stringify({
      step: "simulation_ok",
      target: "WSOL",
      amountAtomic: amountAtomic.toString(),
      dryRun: true
    }));
    return;
  }

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    maxRetries: 2,
    skipPreflight: false
  });
  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight
  }, "confirmed");
  if (confirmation.value.err) {
    throw new Error(`WSOL wrap failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  console.log(JSON.stringify({
    step: "swap_sent",
    target: "WSOL",
    txSignature: signature,
    amountAtomic: amountAtomic.toString(),
    dryRun: false
  }));
}

async function loadKeypair(path) {
  const contents = await readFile(path, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(contents)));
}

function decimalToAtomic(value, decimals) {
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`invalid decimal amount: ${value}`);
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new Error(`amount has more than ${decimals} decimals`);
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+/, "") || "0");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--send") out.send = true;
    else if (arg === "--amount") out.amount = argv[++i];
    else if (arg === "--targets") out.targets = argv[++i];
    else if (arg === "--pool-files") out.poolFiles = argv[++i];
    else if (arg === "--keypair") out.keypair = argv[++i];
    else if (arg === "--slippage-bps") out.slippageBps = argv[++i];
    else if (arg === "--compute-unit-limit") out.computeUnitLimit = argv[++i];
    else if (arg === "--compute-unit-price-micro-lamports") {
      out.computeUnitPriceMicroLamports = argv[++i];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
