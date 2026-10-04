import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import {
  createSolanaClient, createKeyPairSignerFromPrivateKeyBytes, fetchEncodedAccount, getSignatureFromTransaction,
  signTransactionMessageWithSigners,
} from "gill";
import { deriveDeploymentSchemaPda, deriveAttenodeCredentialPda, deriveDeploymentAttestationPda } from "../attestations/sas-onchain.js";
import { buildCreateDeploymentAttestationTransaction } from "../attestations/sas-transactions.js";

import { deploymentSasSchema } from "../attestations/sas.js";
import { DiagnosticError, expectedIdentity, expectedCredential, verifyCredential, verifySchema } from "./devnet-schema-verification.js";

import { toDeploymentSasPayload } from "../attestations/sas.js";
import { createDemoExecution, demoNonce, demoNonceLabel, expectedSchema, verifyDemoAttestation, verifyExistingDemoAttestation } from "./devnet-attestation-demo.js";

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
    throw new DiagnosticError("Usage: npm run devnet:attestation -- [--execute]");
  }
  const execute = args.includes("--execute");
  const { deployment: demoDeployment, expiry } = await stage("execution time capture", () => createDemoExecution(Date.now()));
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
  const client = await stage("Devnet client creation", () => createSolanaClient({ urlOrMoniker: devnetUrl }));
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
  await stage("expected Schema PDA validation", () => {
    if (schema !== expectedSchema) throw new DiagnosticError("Schema PDA does not match the verified deployment Schema");
  });
  async function verifyPrerequisites(): Promise<void> {
    const requiredCredential = await stage("Credential recheck fetch", () => fetchEncodedAccount(client.rpc, credential, { commitment: "confirmed" }));
    await stage("Credential recheck verification", () => {
      if (!requiredCredential.exists) throw new DiagnosticError("Required Credential does not exist");
      verifyCredential(requiredCredential);
    });
    const requiredSchema = await stage("Schema account fetch", () => fetchEncodedAccount(client.rpc, schema, { commitment: "confirmed" }));
    await stage("Schema verification/decoding", () => {
      if (!requiredSchema.exists) throw new DiagnosticError("Required Schema does not exist");
      verifySchema(requiredSchema);
    });
  }
  await verifyPrerequisites();
  function printExpiry(value: bigint): void {
    console.log(`Expiry Unix timestamp: ${value}`);
    console.log(`Expiry UTC: ${new Date(Number(value) * 1000).toISOString()}`);
  }
  console.log("DEMO: repository, commit and digest are fixtures; no build provenance is claimed.");
  console.log(`Deployment model: ${JSON.stringify(demoDeployment, null, 2)}`);
  console.log(`Public SAS payload: ${JSON.stringify(toDeploymentSasPayload(demoDeployment), null, 2)}`);
  console.log(`Nonce label: ${demoNonceLabel}`);
  console.log(`Nonce: ${demoNonce}`);
  printExpiry(expiry);
  const [attestation] = await stage("Attestation PDA derivation", () => deriveDeploymentAttestationPda({ credential, schema, nonce: demoNonce }));
  console.log(`Attestation PDA: ${attestation}`);
  // Runtime expiry changes between invocations. Existing accounts retain their
  // original expiry: require a positive timestamp no later than now + 30 days,
  // verify every other field, and display it. Never refresh or overwrite expiry.
  function verifyExisting(account: Parameters<typeof verifyDemoAttestation>[0]): void {
    const stored = verifyExistingDemoAttestation(account, expiry, demoDeployment);
    console.log("Verified existing Attestation expiry (may already be expired):");
    printExpiry(stored);
  }
  const existing = await stage("Attestation existence fetch", () => fetchEncodedAccount(client.rpc, attestation, { commitment: "confirmed" }));
  console.log(`Attestation exists: ${existing.exists}`);
  if (existing.exists) {
    await stage("existing Attestation verification/decoding", () => verifyExisting(existing));
    console.log("Existing Attestation verified; no transaction submitted.");
    return;
  }
  if (!execute) {
    console.log("Preflight complete. Creation requires explicit --execute; nothing signed or submitted.");
    return;
  }
  await verifyPrerequisites();
  const rechecked = await stage("execute: Attestation existence recheck", () => fetchEncodedAccount(client.rpc, attestation, { commitment: "confirmed" }));
  if (rechecked.exists) {
    await stage("existing Attestation verification/decoding", () => verifyExisting(rechecked));
    console.log("Attestation appeared during preflight; verified and skipped creation.");
    return;
  }
  const { value: latestBlockhash } = await stage("execute: blockhash fetch", () => client.rpc.getLatestBlockhash({ commitment: "confirmed" }).send());
  const built = await stage("execute: transaction build", async () => {
    const result = await buildCreateDeploymentAttestationTransaction({ authority: signer, payer: signer, latestBlockhash }, { credential, schema, nonce: demoNonce, expiry, deployment: demoDeployment });
    if (result.attestation !== attestation || result.transaction.instructions.length !== 1) {
      throw new DiagnosticError("Unexpected Attestation transaction construction");
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
  const created = await stage("post-confirmation account fetch", () => fetchEncodedAccount(client.rpc, attestation, { commitment: "confirmed" }));
  await stage("post-confirmation verification/decoding", () => {
    if (!created.exists) throw new DiagnosticError("Attestation was not found after confirmation");
    verifyDemoAttestation(created, expiry, demoDeployment);
  });
  console.log("Attestation verified after confirmation: SAS owner, discriminator, Credential, Schema, nonce, issuer, expiry and exact serialized payload match.");
}

main().catch(error => {
  reportFailure(error);
  process.exitCode = 1;
});
