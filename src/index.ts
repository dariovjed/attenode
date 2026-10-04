import {
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaClient,
} from "gill";

import { readFile } from "node:fs/promises";

const WALLET_PATH = ".local/wallet.json";

async function main() {
  console.log("Attenode");
  console.log("Loading Attenode identity...");

  const walletFile = await readFile(WALLET_PATH, "utf8");
  const privateKey = new Uint8Array(JSON.parse(walletFile));

  const identity =
    await createKeyPairSignerFromPrivateKeyBytes(privateKey);

  console.log(`Address: ${identity.address}`);

  console.log("\nConnecting to Solana Devnet...");

  const client = createSolanaClient({
    urlOrMoniker: "devnet",
  });

  const [slot, balance] = await Promise.all([
    client.rpc.getSlot().send(),
    client.rpc.getBalance(identity.address).send(),
  ]);

  console.log("Connected to Solana Devnet");
  console.log(`Current slot: ${slot}`);
  console.log(`Balance: ${balance.value} lamports`);
}

main().catch((error) => {
  console.error("Attenode failed:");
  console.error(error);
  process.exit(1);
});
