import {
  createKeyPairFromPrivateKeyBytes,
  createKeyPairSignerFromBytes,
} from "gill";

import { readFile, writeFile } from "node:fs/promises";

const WALLET_PATH = ".local/wallet.json";
const OUTPUT_PATH = ".local/solana-keypair.json";

async function main() {
  const walletFile = await readFile(WALLET_PATH, "utf8");
  const privateKeyBytes = new Uint8Array(JSON.parse(walletFile));

  if (privateKeyBytes.length !== 32) {
    throw new Error(
      `Expected 32 private-key bytes, got ${privateKeyBytes.length}`,
    );
  }

  // Recreate our existing keypair.
  // extractable=true is needed only so we can export the PUBLIC key.
  const keyPair = await createKeyPairFromPrivateKeyBytes(
    privateKeyBytes,
    true,
  );

  const publicKeyBuffer = await crypto.subtle.exportKey(
    "raw",
    keyPair.publicKey,
  );

  const publicKeyBytes = new Uint8Array(publicKeyBuffer);

  if (publicKeyBytes.length !== 32) {
    throw new Error(
      `Expected 32 public-key bytes, got ${publicKeyBytes.length}`,
    );
  }

  // Standard Solana keypair format:
  // [32-byte private key][32-byte public key]
  const keypairBytes = new Uint8Array(64);
  keypairBytes.set(privateKeyBytes, 0);
  keypairBytes.set(publicKeyBytes, 32);

  // Critical validation:
  // reload the 64-byte representation and verify its address.
  const signer = await createKeyPairSignerFromBytes(keypairBytes);

  await writeFile(
    OUTPUT_PATH,
    JSON.stringify(Array.from(keypairBytes)),
    { mode: 0o600 },
  );

  console.log("Solana-compatible Attenode keypair created.");
  console.log(`Address: ${signer.address}`);
  console.log(`Keypair: ${OUTPUT_PATH}`);
  console.log(`Bytes: ${keypairBytes.length}`);
  console.log("Secret key was NOT printed.");
}

main().catch((error) => {
  console.error("Failed to export Attenode keypair:");
  console.error(error);
  process.exit(1);
});
