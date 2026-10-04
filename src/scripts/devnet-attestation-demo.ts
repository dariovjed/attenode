import { createHash } from "node:crypto";
import { getAddressDecoder, type EncodedAccount } from "gill";
import { decodeAttestation, deserializeAttestationData, SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS } from "sas-lib";
import type { DeploymentAttestation } from "../attestations/deployment.js";
import { deploymentSasSchema, serializeDeploymentSasAttestation } from "../attestations/sas.js";
import { DiagnosticError, expectedIdentity, expectedCredential } from "./devnet-schema-verification.js";

export const expectedSchema = "75KXCjZncnxb7ACLqErXH5MYSjmCSVk772qGzrQpGmKp";
export const demoNonceLabel = "attenode:devnet:DeploymentAttestationV1:first-controlled-demo:v1";
// A public SHA-256 digest interpreted as an address; no keypair or secret exists.
export const demoNonce = getAddressDecoder().decode(createHash("sha256").update(demoNonceLabel, "utf8").digest());
export function createDemoExecution(executionTimeMs: number): { deployment: DeploymentAttestation; expiry: bigint } {
  const deployedAt = new Date(executionTimeMs).toISOString();
  const deployment: DeploymentAttestation = {
  version: 1,
  repository: "attenode/attenode-controlled-demo",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  artifact: { type: "container", digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
  environment: "development",
  deployedBy: expectedIdentity,
  deployedAt,
  };
  return { deployment, expiry: expiryFromUnixTime(Math.floor(executionTimeMs / 1000)) };
}
export const thirtyDaysSeconds = 30n * 24n * 60n * 60n;
export function expiryFromUnixTime(now: number): bigint {
  if (!Number.isSafeInteger(now) || now < 0) throw new DiagnosticError("Invalid Unix time");
  return BigInt(now) + thirtyDaysSeconds;
}
// Rust AttestationDiscriminator = 2, prefixed by AccountSerialize::to_bytes.
// https://github.com/solana-foundation/solana-attestation-service/blob/master/program/src/state/discriminator.rs
// https://github.com/solana-foundation/solana-attestation-service/blob/master/program/src/state/attestation.rs
// The sas-lib generated account enum ordinal is not the serialized tag.
export const attestationAccountDiscriminator = 2;
function decodeCheckedAttestation(account: EncodedAccount, deployment: DeploymentAttestation) {
  if (account.programAddress !== SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS || account.executable !== false) {
    throw new DiagnosticError("Attestation verification failed: incorrect owner or executable account");
  }
  if (account.data[0] !== attestationAccountDiscriminator) {
    throw new DiagnosticError("Attestation verification failed: invalid account discriminator");
  }
  // Fixed Rust fields occupy 173 bytes in addition to the deployment payload.
  if (account.data.length !== 173 + serializeDeploymentSasAttestation(deployment).length) {
    throw new DiagnosticError("Attestation verification failed: incorrect serialized account length");
  }
  return decodeAttestation(account).data;
}
export function verifyDemoAttestation(account: EncodedAccount, expectedExpiry: bigint, deployment: DeploymentAttestation): void {
  const data = decodeCheckedAttestation(account, deployment);
  const mismatches: string[] = [];
  const check = (field: string, matches: boolean): void => { if (!matches) mismatches.push(field); };
  check("Credential", data.credential === expectedCredential);
  check("Schema", data.schema === expectedSchema);
  check("nonce", data.nonce === demoNonce);
  // Rust stores the issuing authorized signer, rather than a separate authority.
  check("issuer/signer", data.signer === expectedIdentity);
  check("expiry", expectedExpiry > 0n && data.expiry === expectedExpiry);
  check("payload", Buffer.from(data.data).equals(Buffer.from(serializeDeploymentSasAttestation(deployment))));
  check("tokenAccount", data.tokenAccount === "11111111111111111111111111111111");
  if (mismatches.length) throw new DiagnosticError(`Attestation verification failed: mismatched ${mismatches.join(", ")}`);
}

// Existing accounts keep their original deployment time. Recover only that
// field from the public payload, then verify all bytes against the demo model.
export function verifyExistingDemoAttestation(account: EncodedAccount, maximumExpiry: bigint, deployment: DeploymentAttestation): bigint {
  const data = decodeCheckedAttestation(account, deployment);
  const payload = deserializeAttestationData(deploymentSasSchema, Uint8Array.from(data.data)) as Record<string, unknown>;
  const deployedAt = payload.deployedAt;
  if (typeof deployedAt !== "string") throw new DiagnosticError("Existing Attestation deployment time is invalid");
  const timestamp = Date.parse(deployedAt);
  if (!Number.isFinite(timestamp) || timestamp < 0 || new Date(timestamp).toISOString() !== deployedAt) {
    throw new DiagnosticError("Existing Attestation deployment time is invalid");
  }
  const original = { ...deployment, deployedAt };
  const expectedExpiry = expiryFromUnixTime(Math.floor(timestamp / 1000));
  if (expectedExpiry > maximumExpiry) throw new DiagnosticError("Existing Attestation expiry is outside the controlled demo time range");
  verifyDemoAttestation(account, expectedExpiry, original);
  return expectedExpiry;
}
