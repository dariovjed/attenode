import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import {
  createSolanaClient, createKeyPairSignerFromPrivateKeyBytes, fetchEncodedAccount, getSignatureFromTransaction,
  signTransactionMessageWithSigners, type EncodedAccount,
} from "gill";
import {
  decodeCredential, SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,
} from "sas-lib";
import { attenodeCredentialName, deriveAttenodeCredentialPda } from "../attestations/sas-onchain.js";
import { buildCreateCredentialTransaction } from "../attestations/sas-transactions.js";

const expectedIdentity = "GisnMiKvJUJfjCejzMbVCRpjcWvWWaFNUMokHaJmpr75";
// Canonical serialized account tag: AttestationAccountDiscriminators::CredentialDiscriminator.
// https://github.com/solana-foundation/solana-attestation-service/blob/master/program/src/state/discriminator.rs
// sas-lib@1.0.10 exports no Credential account discriminator constant; its
// SolanaAttestationServiceAccount enum uses a different order, and its codec
// reads an arbitrary u8 without validating it. Do not use the instruction tag.
const credentialAccountDiscriminator = 0;
const devnetUrl = "https://api.devnet.solana.com";

let failedStage = "argument validation";
class DiagnosticError extends Error {}

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

function verifyCredential(account: EncodedAccount): void {
  // Only explicitly selected public account fields may enter diagnostics.
  const mismatches: string[] = [];
  const check = (field: string, matches: boolean, actual: unknown, expected: unknown): void => {
    if (!matches) {
      mismatches.push(`${field}: decoded=${JSON.stringify(actual)}; expected=${JSON.stringify(expected)}`);
    }
  };
  check("owner", account.programAddress === SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,
    account.programAddress, SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS);
  check("executable", account.executable === false, account.executable, false);
  if (mismatches.length) {
    throw new DiagnosticError(`Credential verification failed: ${mismatches.join("; ")}`);
  }
  const { data } = decodeCredential(account);
  check("discriminator", data.discriminator === credentialAccountDiscriminator,
    data.discriminator, credentialAccountDiscriminator);
  check("authority", data.authority === expectedIdentity, data.authority, expectedIdentity);
  // SAS decodes name as bytes. Keep exact byte equality, without trimming,
  // removing padding, or accepting replacement characters from UTF-8 decoding.
  const nameBytes = Buffer.from(data.name);
  const expectedNameBytes = Buffer.from(attenodeCredentialName, "utf8");
  check("name", nameBytes.equals(expectedNameBytes),
    { utf8: nameBytes.toString("utf8"), hex: nameBytes.toString("hex"), byteLength: nameBytes.length },
    { utf8: attenodeCredentialName, hex: expectedNameBytes.toString("hex"), byteLength: expectedNameBytes.length });
  check("authorizedSigners.length", data.authorizedSigners.length === 1,
    data.authorizedSigners.length, 1);
  check("authorizedSigners", data.authorizedSigners.length === 1 && data.authorizedSigners[0] === expectedIdentity,
    data.authorizedSigners, [expectedIdentity]);
  if (mismatches.length) {
    throw new DiagnosticError(`Credential verification failed: ${mismatches.join("; ")}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--execute") || args.length > 1) {
    throw new DiagnosticError("Usage: npm run devnet:credential -- [--execute]");
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
  console.log(`Credential name: ${attenodeCredentialName}`);
  const client = await stage("Devnet client creation", () => createSolanaClient({ urlOrMoniker: "devnet" }));
  const [credential] = await stage("Credential PDA derivation", () => deriveAttenodeCredentialPda(signer.address));
  console.log(`Credential PDA: ${credential}`);
  const existing = await stage("account existence fetch", () => fetchEncodedAccount(client.rpc, credential, { commitment: "confirmed" }));
  console.log(`Credential exists: ${existing.exists}`);
  console.log(`Intended operation: ${existing.exists ? "verify existing Credential; skip creation" : "create only the Attenode Credential"}`);
  if (existing.exists) {
    await stage("existing Credential verification/decoding", () => verifyCredential(existing));
    console.log("Existing Credential verified; no transaction submitted.");
    return;
  }
  if (!execute) {
    console.log("Preflight complete. Creation requires explicit --execute; nothing signed or submitted.");
    return;
  }

  // Recheck immediately before creation; never replace an existing account.
  const rechecked = await stage("execute: account existence recheck", () => fetchEncodedAccount(client.rpc, credential, { commitment: "confirmed" }));
  if (rechecked.exists) {
    await stage("existing Credential verification/decoding", () => verifyCredential(rechecked));
    console.log("Credential appeared during preflight; verified and skipped creation.");
    return;
  }
  const { value: latestBlockhash } = await stage("execute: blockhash fetch", () => client.rpc.getLatestBlockhash({ commitment: "confirmed" }).send());
  const built = await stage("execute: transaction build", async () => {
    const result = await buildCreateCredentialTransaction({ authority: signer, payer: signer, latestBlockhash });
    if (result.credential !== credential || result.transaction.instructions.length !== 1) {
      throw new DiagnosticError("Unexpected Credential transaction construction");
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
  const created = await stage("post-confirmation account fetch", () => fetchEncodedAccount(client.rpc, credential, { commitment: "confirmed" }));
  await stage("post-confirmation verification/decoding", () => {
    if (!created.exists) throw new DiagnosticError("Credential was not found after confirmation");
    verifyCredential(created);
  });
  console.log("Credential verified after confirmation: SAS owner, authority, name and authorized signer match.");
}

main().catch(error => {
  reportFailure(error);
  process.exitCode = 1;
});
