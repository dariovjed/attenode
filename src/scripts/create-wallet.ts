import {
  createKeyPairSignerFromPrivateKeyBytes,
} from "gill";
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const WALLET_PATH = ".local/wallet.json";

async function main() {
  try {
    await access(WALLET_PATH);

    console.error(
      `Wallet already exists at ${WALLET_PATH}. Refusing to overwrite it.`,
    );

    process.exit(1);
  } catch {
    // Expected when wallet does not exist.
  }

  // 32-byte Ed25519 private key.
  const privateKey = randomBytes(32);

  const signer =
    await createKeyPairSignerFromPrivateKeyBytes(privateKey);

  await mkdir(dirname(WALLET_PATH), {
    recursive: true,
  });

  await writeFile(
    WALLET_PATH,
    JSON.stringify(Array.from(privateKey)),
    {
      mode: 0o600,
    },
  );

  console.log("Attenode Devnet identity created.");
  console.log(`Address: ${signer.address}`);
  console.log(`Wallet: ${WALLET_PATH}`);
  console.log("Private key was NOT printed.");
}

main().catch((error) => {
  console.error("Failed to create Attenode identity:");
  console.error(error);
  process.exit(1);
});
