import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { address, getAddressDecoder, type EncodedAccount } from "gill";
import { validateDeploymentAttestation, type DeploymentAttestation } from "../attestations/deployment.js";
import { deriveDeploymentAttestationPda } from "../attestations/sas-onchain.js";
import { DiagnosticError, expectedCredential, expectedIdentity } from "./devnet-schema-verification.js";
import { expectedSchema, expiryFromUnixTime, verifyDemoAttestation, verifyExistingDemoAttestation } from "./devnet-attestation-demo.js";

// Operator-supplied verified inputs. This flow does not verify build provenance.
export const demoApiIdentity = Object.freeze({
  repository: "dariovjed/attenode",
  commitSha: "bb2d3cf15f2b31137e8b5112770587d672458064",
  artifactDigest: "sha256:3190be029b3730939206615819911fac3d6c5285d48eadd5c363826c950c9fee",
  imageRepository: "ghcr.io/dariovjed/demo-api",
  environment: "development" as const,
});
// Kubernetes binding is context only; these fields are absent from the SAS schema.
export const demoApiTarget = Object.freeze({ namespace: "attenode-demo", deployment: "demo-api", container: "demo-api" });
export const demoApiNonceLabel = `attenode:devnet:DeploymentAttestationV1:real-demo-api:v1:${demoApiIdentity.repository}:${demoApiIdentity.commitSha}:${demoApiIdentity.artifactDigest}:${demoApiIdentity.environment}`;
export const demoApiNonce = getAddressDecoder().decode(createHash("sha256").update(demoApiNonceLabel, "utf8").digest());

export function validateDemoApiDeployment(deployment: DeploymentAttestation): void {
  validateDeploymentAttestation(deployment);
  if (deployment.version !== 1 || deployment.repository !== demoApiIdentity.repository ||
      deployment.commitSha !== demoApiIdentity.commitSha || deployment.artifact.type !== "container" ||
      deployment.artifact.digest !== demoApiIdentity.artifactDigest || deployment.environment !== demoApiIdentity.environment ||
      deployment.provenance !== undefined || deployment.deployedBy !== expectedIdentity ||
      new Date(deployment.deployedAt).toISOString() !== deployment.deployedAt) {
    throw new DiagnosticError("Real demo-api payload does not match the approved inputs");
  }
}

export function createDemoApiExecution(timeMs: number): { deployment: DeploymentAttestation; expiry: bigint } {
  const expiry = expiryFromUnixTime(Math.floor(timeMs / 1000));
  const deployment: DeploymentAttestation = {
    version: 1, repository: demoApiIdentity.repository, commitSha: demoApiIdentity.commitSha,
    artifact: { type: "container", digest: demoApiIdentity.artifactDigest },
    environment: demoApiIdentity.environment, deployedBy: expectedIdentity, deployedAt: new Date(timeMs).toISOString(),
  };
  validateDemoApiDeployment(deployment);
  return { deployment, expiry };
}

export function verifyDemoApiAttestation(account: EncodedAccount, expiry: bigint, deployment: DeploymentAttestation): void {
  validateDemoApiDeployment(deployment);
  verifyDemoAttestation(account, expiry, deployment, demoApiNonce);
}

export async function verifyExistingDemoApiAttestation(account: EncodedAccount, nowMs: number): Promise<bigint> {
  const [expectedAddress] = await deriveDeploymentAttestationPda({ credential: address(expectedCredential), schema: address(expectedSchema), nonce: demoApiNonce });
  if (account.address !== expectedAddress) throw new DiagnosticError("Real demo-api Attestation PDA mismatch");
  const { deployment, expiry: maximumExpiry } = createDemoApiExecution(nowMs);
  const expiry = verifyExistingDemoAttestation(account, maximumExpiry, deployment, demoApiNonce);
  if (expiry <= BigInt(Math.floor(nowMs / 1000))) throw new DiagnosticError("Real demo-api Attestation has expired");
  return expiry;
}

export function parseAttestationArgs(args: string[]) {
  const { values, tokens } = parseArgs({ args, tokens: true, strict: true, allowPositionals: false, options: {
    payload: { type: "string", default: "fixture" }, execute: { type: "boolean", default: false },
    preview: { type: "boolean", default: false }, "verify-only": { type: "boolean", default: false },
  } });
  const options = tokens.filter(token => token.kind === "option").map(token => token.name);
  if (new Set(options).size !== options.length) throw new DiagnosticError("Duplicate attestation argument");
  if (values.payload !== "fixture" && values.payload !== "demo-api") throw new DiagnosticError("Select --payload fixture or --payload demo-api");
  if ([values.execute, values.preview, values["verify-only"]].filter(Boolean).length > 1) {
    throw new DiagnosticError("--execute, --preview and --verify-only are mutually exclusive");
  }
  return values;
}
