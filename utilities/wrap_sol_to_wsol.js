require("dotenv").config();

const { readFile } = require("node:fs/promises");
const {
  Connection,
  Keypair,
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

const LAMPORTS_PER_SOL_ATOMIC = 1_000_000_000n;
const DEFAULT_AMOUNT_SOL = "0.14";
const DEFAULT_KEYPAIR_PATH = "keyPair/solflare_keypair.json";

async function main() {
  const args = new Set(process.argv.slice(2));
  const send = args.has("--send");
  const amountSol = valueAfter("--amount") || process.env.WRAP_SOL_AMOUNT || DEFAULT_AMOUNT_SOL;
  const keypairPath = valueAfter("--keypair") || process.env.KEYPAIR_PATH || DEFAULT_KEYPAIR_PATH;
  const rpcUrl = process.env.RPC_URL || process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL;

  if (!rpcUrl) {
    throw new Error("RPC_URL is required");
  }

  const lamports = decimalToAtomic(amountSol, 9);
  if (lamports <= 0n) throw new Error("wrap amount must be positive");

  const wallet = await loadKeypair(keypairPath);
  const connection = new Connection(rpcUrl, "confirmed");
  const owner = wallet.publicKey;
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    owner,
    false,
    TOKEN_PROGRAM_ID
  );

  const nativeBalance = BigInt(await connection.getBalance(owner, "confirmed"));
  const minimumReserve = 10_000n;
  if (nativeBalance < lamports + minimumReserve) {
    throw new Error(
      `insufficient native SOL: have ${nativeBalance}, need at least ${lamports + minimumReserve}`
    );
  }

  const transaction = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      wsolAta,
      owner,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID
    ),
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: wsolAta,
      lamports
    }),
    createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID)
  );

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = owner;
  transaction.recentBlockhash = blockhash;
  transaction.sign(wallet);

  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    throw new Error(`simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }

  console.log({
    mode: send ? "send" : "simulate_only",
    owner: owner.toBase58(),
    wsolAta: wsolAta.toBase58(),
    amountSol,
    lamports: lamports.toString(),
    simulationLogs: simulation.value.logs || []
  });

  if (!send) {
    console.log("Simulation passed. Re-run with --send to wrap SOL into WSOL.");
    return;
  }

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    maxRetries: 2,
    skipPreflight: false
  });

  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  if (confirmation.value.err) {
    throw new Error(`transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  const tokenBalance = await connection.getTokenAccountBalance(wsolAta, "confirmed");
  console.log({
    signature,
    confirmed: true,
    wsolAtaBalanceAtomic: tokenBalance.value.amount
  });
}

async function loadKeypair(path) {
  const contents = await readFile(path, "utf8");
  const bytes = Uint8Array.from(JSON.parse(contents));
  return Keypair.fromSecretKey(bytes);
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function decimalToAtomic(value, decimals) {
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`invalid decimal amount: ${value}`);
  }
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    throw new Error(`amount has more than ${decimals} decimals: ${value}`);
  }
  const atomicText = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+/, "") || "0";
  return BigInt(atomicText);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  decimalToAtomic,
  LAMPORTS_PER_SOL_ATOMIC
};
