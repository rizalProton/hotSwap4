require("dotenv").config();

const { readFile } = require("node:fs/promises");
const { Connection, Keypair } = require("@solana/web3.js");
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
  PYUSD: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
  FDUSD: "9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u"
};

const DECIMALS = {
  WSOL: 9,
  USDC: 6,
  USDT: 6,
  USD1: 6,
  PYUSD: 6,
  FDUSD: 6
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputSymbol = String(args.input || "USD1").toUpperCase();
  const outputSymbol = String(args.output || "USDC").toUpperCase();
  const amount = args.amount || "3";
  const send = args.send === true;
  const slippageBps = Number(args.slippageBps || process.env.SLIPPAGE_BPS || "4");
  const keypairPath = args.keypair || process.env.KEYPAIR_PATH || "keyPair/solflare_keypair.json";
  const poolFiles = String(
    args.poolFiles ||
    process.env.POOL_FILE ||
    "pools/03_ROUTED.with_pyusd_jlp_peers.json"
  ).split(",").map((item) => item.trim()).filter(Boolean);
  const rpcUrl = process.env.RPC_URL || process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL;

  if (!MINTS[inputSymbol]) throw new Error(`unknown input symbol: ${inputSymbol}`);
  if (!MINTS[outputSymbol]) throw new Error(`unknown output symbol: ${outputSymbol}`);
  if (!rpcUrl) throw new Error("RPC_URL, HELIUS_RPC_URL, or SOLANA_RPC_URL is required");

  const inputMint = MINTS[inputSymbol];
  const outputMint = MINTS[outputSymbol];
  const inputAmountAtomic = decimalToAtomic(amount, DECIMALS[inputSymbol]);

  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = await loadKeypair(keypairPath);
  const currentSlot = await connection.getSlot("confirmed");
  const graph = new PairGraph();
  let pools = 0;
  let directedEdges = 0;

  for (const poolFile of poolFiles) {
    const loaded = loadEnrichedPools(poolFile);
    pools += loaded.length;
    const result = buildGraphFromEnrichedPools(graph, loaded, {
      now: Date.now(),
      currentSlot
    });
    directedEdges += result.edgeCount;
  }

  const balances = new WalletBalanceProvider({ connection, owner: wallet.publicKey });
  const inputBalance = await balances.getBalance(inputMint);
  if (inputBalance < inputAmountAtomic) {
    throw new Error(
      `insufficient ${inputSymbol}: have ${inputBalance}, need ${inputAmountAtomic}`
    );
  }

  const candidates = [];
  for (const edge of graph.outgoing(inputMint)) {
    if (edge.tokenOutMint !== outputMint) continue;
    if (!edge.executionReady || edge.stale || edge.outlier || edge.quarantined) continue;
    if (edge.maxInputAtomic !== undefined && inputAmountAtomic > BigInt(edge.maxInputAtomic)) continue;
    try {
      const quote = await quoteEdge(edge, inputAmountAtomic);
      candidates.push({ edge, quote });
    } catch (error) {
      console.log(JSON.stringify({
        step: "quote_failed",
        poolAddress: edge.poolAddress,
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
    throw new Error(`no executable direct pool quoted for ${inputSymbol}->${outputSymbol}`);
  }

  const executor = new LiveExecutor({
    connection,
    wallet,
    dryRun: !send,
    computeUnitLimit: Number(process.env.COMPUTE_UNIT_LIMIT || 400000),
    computeUnitPriceMicroLamports: Number(process.env.COMPUTE_UNIT_PRICE_MICRO_LAMPORTS || 0)
  });

  for (const { edge, quote } of candidates) {
    const minOutputAtomic = subtractBps(quote.outputAmountAtomic, slippageBps);
    console.log(JSON.stringify({
      mode: send ? "send" : "simulate_only",
      wallet: wallet.publicKey.toBase58(),
      pools,
      directedEdges,
      input: inputSymbol,
      output: outputSymbol,
      inputAmountAtomic: inputAmountAtomic.toString(),
      selectedPool: edge.poolAddress,
      dexType: edge.dexType,
      mathType: edge.mathType,
      feeBps: edge.feeBps,
      quotedOutputAtomic: quote.outputAmountAtomic.toString(),
      minOutputAtomic: minOutputAtomic.toString(),
      slippageBps
    }));

    const preOutput = await balances.getBalance(outputMint);
    try {
      const result = await executor.execute({
        edge,
        inputAmountAtomic,
        minOutputAtomic
      });
      const confirmed = await executor.confirm(result);
      if (!confirmed) throw new Error("transaction not confirmed");

      const postOutput = await balances.getBalance(outputMint);
      const observedOutputAtomic = postOutput - preOutput;

      console.log(JSON.stringify({
        step: send ? "swap_sent" : "simulation_ok",
        txSignature: result.txSignature,
        confirmed: true,
        dryRun: result.dryRun,
        observedOutputAtomic: observedOutputAtomic.toString(),
        quotedOutputAtomic: quote.outputAmountAtomic.toString()
      }));
      return;
    } catch (error) {
      console.log(JSON.stringify({
        step: "pool_failed",
        poolAddress: edge.poolAddress,
        reason: error?.message || String(error)
      }));
    }
  }

  throw new Error(`all direct pools failed for ${inputSymbol}->${outputSymbol}`);
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
    else if (arg === "--input") out.input = argv[++i];
    else if (arg === "--output") out.output = argv[++i];
    else if (arg === "--amount") out.amount = argv[++i];
    else if (arg === "--keypair") out.keypair = argv[++i];
    else if (arg === "--pool-files") out.poolFiles = argv[++i];
    else if (arg === "--slippage-bps") out.slippageBps = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
