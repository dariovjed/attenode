import { address } from "gill";
import { decodeAttestation, deserializeAttestationData } from "sas-lib";
import { deploymentSasSchema, type DeploymentSasPayload } from "./sas.js";
import { deriveAttenodeCredentialPda, deriveDeploymentSchemaPda } from "./sas-onchain.js";
import type { SasAccountReader } from "./sas-reader.js";
import { expectedCredential, expectedIdentity, verifyCredential, verifySchema } from "../scripts/devnet-schema-verification.js";
import { expectedSchema } from "../scripts/devnet-attestation-demo.js";
import { verifyExistingDemoApiAttestation } from "../scripts/devnet-demo-api.js";
import { atDiagnosticStage, diagnostic, type DiagnosticCode, type SafeDiagnostic } from "../runtime/diagnostics.js";

export const demoApiAttestationAddress = "HVjR8c5iF5mXegmboR54HB3EzRSTadb7j9L5D4uLq9WQ";
export interface SasApproval {
  status: "VERIFIED" | "INDETERMINATE";
  network: "devnet";
  attestation: string;
  credential: string;
  schema: string;
  issuer: string;
  checkedAt: string;
  expiry?: string;
  payload?: DeploymentSasPayload;
  reason: string;
  diagnostic?: SafeDiagnostic;
}

/** Reuses the exact real-image read-back verifier, including nonce, PDA and expiry policy. */
export async function readDemoApiApproval(reader: SasAccountReader, nowMs: number): Promise<SasApproval> {
  const report: SasApproval = {
    status: "INDETERMINATE", network: "devnet", attestation: demoApiAttestationAddress,
    credential: expectedCredential, schema: expectedSchema, issuer: expectedIdentity,
    checkedAt: new Date(nowMs).toISOString(), reason: "Required SAS account is missing.",
  };
  // Transport errors propagate to the CLI's execution-error exit code. No external error text is printed.
  const credential = await atDiagnosticStage("SAS_RPC", () => reader.account(address(expectedCredential)), { accountKind: "CREDENTIAL" });
  const schema = await atDiagnosticStage("SAS_RPC", () => reader.account(address(expectedSchema)), { accountKind: "SCHEMA" });
  const attestation = await atDiagnosticStage("SAS_RPC", () => reader.account(address(demoApiAttestationAddress)), { accountKind: "ATTESTATION" });
  if (!credential || !schema || !attestation) return { ...report, diagnostic: diagnostic("SAS_ACCOUNT_MISSING") };
  let rejection: DiagnosticCode = "SAS_CREDENTIAL_REJECTED";
  try {
    const [credentialPda] = await deriveAttenodeCredentialPda(address(expectedIdentity));
    const [schemaPda] = await deriveDeploymentSchemaPda({ credential: address(expectedCredential), version: 1 });
    if (credential.address !== credentialPda) throw new Error("PDA mismatch");
    verifyCredential(credential);
    rejection = "SAS_SCHEMA_REJECTED";
    if (schema.address !== schemaPda) throw new Error("PDA mismatch");
    verifySchema(schema);
    rejection = "SAS_ATTESTATION_REJECTED";
    const expiry = await verifyExistingDemoApiAttestation(attestation, nowMs);
    const data = decodeAttestation(attestation).data;
    // The verifier above has compared these exact payload bytes against the real-image policy.
    // Approval is sourced from the decoded account, never the local expected digest.
    const payload = deserializeAttestationData(deploymentSasSchema, Uint8Array.from(data.data)) as DeploymentSasPayload;
    if (!/^sha256:[0-9a-f]{64}$/.test(payload.artifactDigest)) throw new Error("Invalid manifest digest");
    if (Date.parse(payload.deployedAt) > nowMs) throw new Error("Future deployment timestamp");
    return { ...report, status: "VERIFIED", issuer: data.signer, expiry: expiry.toString(), payload,
      reason: "SAS account chain, authorized issuer, exact payload and current expiration validated." };
  } catch {
    return { ...report, reason: "SAS validation rejected account identity, ownership, schema, issuer, payload or expiration.", diagnostic: diagnostic(rejection) };
  }
}
