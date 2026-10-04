import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import {
  createSolanaClient, createKeyPairSignerFromPrivateKeyBytes, fetchEncodedAccount, getSignatureFromTransaction,
  signTransactionMessageWithSigners,
} from "gill";
import { deriveDeploymentSchemaPda, deriveAttenodeCredentialPda } from "../attestations/sas-onchain.js";
import { buildCreateDeploymentSchemaTransaction } from "../attestations/sas-transactions.js";

import { deploymentSasSchema } from "../attestations/sas.js";
import { DiagnosticError, expectedIdentity, expectedCredential, verifyCredential, verifySchema } from "./devnet-schema-verification.js";

const devnetUrl = "https://api.devnet.solana.com";

let failedStage = "argument validation";

async function stage<T>(name: string, operation: () => T | Promise<T>): Promise<T> {
  failedStage = name;
  const result = await operation();
  console.log(`OK: ${name}`);
  return result;
}

// Never forward external exception messages, names, stacks or serialized contexts.
function reportFailure(error: unknown): void {
  const record = error !== null && typeof error === "object"
    ? error as Record<string, unknown> : undefined;
  const allowedNames = new Set(["Error", "SyntaxError", "TypeError", "RangeError", "SolanaError", "DOMException", "OperationError", "DataError", "AbortError", "DiagnosticError"]);
  const name = typeof record?.name === "string" && allowedNames.has(record.name) ? record.name : "UnknownError";
  console.error(`Failed stage: ${failedStage}`);
  console.error(`Error class: ${name}`);
  const fileMessages: Record<string, string> = {
    ENOENT: "Wallet file was not found.", EACCES: "Wallet file access denied.",
    EPERM: "Wallet file access denied.", EISDIR: "Wallet path refers to a directory.",
  };
  const fileMessage = failedStage === "wallet file read" && typeof record?.code === "string"
    ? fileMessages[record.code] : undefined;
  console.error(`Message: ${error instanceof DiagnosticError ? error.message
    : fileMessage ?? "Operation failed; external message omitted because it may contain sensitive input."}`);
  // Gill SolanaError stores JSON-RPC codes in context.__code. Print numbers only.
  const context = record?.context;
  const contextCode = context !== null && typeof context === "object"
    ? (context as Record<string, unknown>).__code : undefined;
  const code = typeof contextCode === "number" ? contextCode : record?.code;
  if (typeof code === "number" && Number.isSafeInteger(code) && code >= -32768 && code <= -32000) {
    console.error(`RPC error code: ${code}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--execute") || args.length > 1) {
    throw new DiagnosticError("Usage: npm run devnet:schema -- [--execute]");
  }
  const execute = args.includes("--execute");
  // Resolve relative to this source file, not the caller's working directory.
  const walletPath = fileURLToPath(new URL("../../.local/wallet.json", import.meta.url));
  let walletText = await stage("wallet file read", () => readFile(walletPath, "utf8"));
  const walletBytes = await stage("wallet JSON parsing", () => {
    const parsed: unknown = JSON.parse(walletText);
    if (!Array.isArray(parsed) || parsed.length !== 32 ||
        !parsed.every(value => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255)) {
      throw new DiagnosticError("Wallet must be a JSON array of exactly 32 integer bytes.");
    }
    return Uint8Array.from(parsed);
  });
  walletText = "";
  const signer = await stage("signer creation", async () => {
    try { return await createKeyPairSignerFromPrivateKeyBytes(walletBytes); }
    finally { walletBytes.fill(0); }
  });
  await stage("expected-address validation", () => {
    if (signer.address !== expectedIdentity) {
      throw new DiagnosticError("Wallet address does not match the approved Attenode Devnet identity");
    }
  });
  console.log(`Network: Solana Devnet (${devnetUrl})`);
  console.log(`Mode: ${execute ? "execute" : "read-only preflight"}`);
  console.log(`Payer / authority / authorized signer: ${signer.address}`);
  const client = await stage("Devnet client creation", () => createSolanaClient({ urlOrMoniker: "devnet" }));
  const [credential] = await stage("Credential PDA derivation", () => deriveAttenodeCredentialPda(signer.address));
  await stage("expected Credential PDA validation", () => {
    if (credential !== expectedCredential) throw new DiagnosticError("Credential PDA does not match the verified Attenode Credential");
  });
  console.log(`Credential PDA: ${credential}`);
  const credentialAccount = await stage("Credential account fetch", () => fetchEncodedAccount(client.rpc, credential, { commitment: "confirmed" }));
  await stage("Credential verification/decoding", () => {
    if (!credentialAccount.exists) throw new DiagnosticError("Required Attenode Credential does not exist");
    verifyCredential(credentialAccount);
  });
  const [schema] = await stage("Schema PDA derivation", () => deriveDeploymentSchemaPda({ credential, version: deploymentSasSchema.version }));
  console.log(`Schema PDA: ${schema}`);
  console.log(`Schema name: ${Buffer.from(deploymentSasSchema.name).toString("utf8")}`);
  console.log(`Schema description: ${Buffer.from(deploymentSasSchema.description).toString("utf8")}`);
  console.log(`Schema version: ${deploymentSasSchema.version}`);
  const existing = await stage("account existence fetch", () => fetchEncodedAccount(client.rpc, schema, { commitment: "confirmed" }));
  console.log(`Schema exists: ${existing.exists}`);
  console.log(`Intended operation: ${existing.exists ? "verify existing Schema; skip creation" : "create only the Attenode Schema"}`);
  if (existing.exists) {
    await stage("existing Schema verification/decoding", () => verifySchema(existing));
    console.log("Existing Schema verified; no transaction submitted.");
    return;
  }
  if (!execute) {
    console.log("Preflight complete. Creation requires explicit --execute; nothing signed or submitted.");
    return;
  }

  // Recheck immediately before creation; never replace an existing account.
  const rechecked = await stage("execute: account existence recheck", () => fetchEncodedAccount(client.rpc, schema, { commitment: "confirmed" }));
  if (rechecked.exists) {
    await stage("existing Schema verification/decoding", () => verifySchema(rechecked));
    console.log("Schema appeared during preflight; verified and skipped creation.");
    return;
  }
  const prerequisite = await stage("execute: Credential recheck fetch", () => fetchEncodedAccount(client.rpc, credential, { commitment: "confirmed" }));
  await stage("execute: Credential recheck verification", () => {
    if (!prerequisite.exists) throw new DiagnosticError("Required Attenode Credential no longer exists");
    verifyCredential(prerequisite);
  });
  const { value: latestBlockhash } = await stage("execute: blockhash fetch", () => client.rpc.getLatestBlockhash({ commitment: "confirmed" }).send());
  const built = await stage("execute: transaction build", async () => {
    const result = await buildCreateDeploymentSchemaTransaction({ authority: signer, payer: signer, latestBlockhash }, { credential });
    if (result.schema !== schema || result.transaction.instructions.length !== 1) {
      throw new DiagnosticError("Unexpected Schema transaction construction");
    }
    return result;
  });
  const signed = await stage("execute: transaction signing", () => signTransactionMessageWithSigners(built.transaction));
  const signature = await stage("execute: signature extraction", () => getSignatureFromTransaction(signed));
  console.log(`Transaction signature (submission attempt): ${signature}`);
  // Gill exposes send + confirmation as one operation; a failure here has an
  // uncertain outcome. Preserve the original error's class and numeric RPC code.
  await stage("execute: send/confirm", () => client.sendAndConfirmTransaction(signed, { commitment: "confirmed" }));
  console.log(`Confirmed transaction: ${signature}`);
  const created = await stage("post-confirmation account fetch", () => fetchEncodedAccount(client.rpc, schema, { commitment: "confirmed" }));
  await stage("post-confirmation verification/decoding", () => {
    if (!created.exists) throw new DiagnosticError("Schema was not found after confirmation");
    verifySchema(created);
  });
  console.log("Schema verified after confirmation: SAS owner, discriminator, Credential reference, name, description, version, layout and field names match.");
}

main().catch(error => {
  reportFailure(error);
  process.exitCode = 1;
});
