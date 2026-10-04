import {
  serializeAttestationData,
  SolanaAttestationServiceAccount,
  type Schema,
} from "sas-lib";

import {
  validateDeploymentAttestation,
  type DeploymentAttestation,
} from "./deployment.js";

export const deploymentSasFieldNames = [
  "repository",
  "commitSha",
  "artifactDigest",
  "environment",
  "provenanceProvider",
  "deployedAt",
] as const;

export type DeploymentSasPayload = Record<
  (typeof deploymentSasFieldNames)[number],
  string
>;

const textEncoder = new TextEncoder();

// SAS 1.0.10 expects joined field names, each prefixed by its u32 LE byte length.
const fieldNames = Uint8Array.from(
  deploymentSasFieldNames.flatMap((name) => {
    const bytes = textEncoder.encode(name);
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, bytes.length, true);
    return [...length, ...bytes];
  }),
);

/** Offline serialization fixture; this is not a registered on-chain schema. */
export const deploymentSasSchema: Schema = {
  discriminator: SolanaAttestationServiceAccount.Schema,
  // Placeholder only: serializeAttestationData reads fieldNames and layout.
  // Replace with an actual SAS credential when registering the schema later.
  credential: "11111111111111111111111111111111" as Schema["credential"],
  name: textEncoder.encode("DeploymentAttestationV1"),
  description: textEncoder.encode("Attenode deployment attestation v1"),
  // The installed sas-lib maps compact layout code 12 to Borsh String.
  layout: Uint8Array.from(deploymentSasFieldNames.map(() => 12)),
  fieldNames,
  isPaused: false,
  version: 1,
};

export function toDeploymentSasPayload(
  deployment: DeploymentAttestation,
): DeploymentSasPayload {
  validateDeploymentAttestation(deployment);

  return {
    repository: deployment.repository,
    commitSha: deployment.commitSha,
    artifactDigest: deployment.artifact.digest,
    environment: deployment.environment,
    // Empty string represents absent optional provenance in this v1 schema.
    provenanceProvider: deployment.provenance?.provider ?? "",
    deployedAt: deployment.deployedAt,
  };
}

export function serializeDeploymentSasAttestation(
  deployment: DeploymentAttestation,
): Uint8Array {
  return serializeAttestationData(
    deploymentSasSchema,
    toDeploymentSasPayload(deployment),
  );
}
