import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const wallet = require("../../src/walletBalanceProvider.js");

export const WalletBalanceProvider = wallet.WalletBalanceProvider;
