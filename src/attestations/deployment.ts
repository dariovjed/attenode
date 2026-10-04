export type DeploymentEnvironment =
  | "development"
  | "staging"
  | "production";

export interface DeploymentAttestation {
  version: 1;

  repository: string;
  commitSha: string;

  artifact: {
    type: "container";
    digest: string;
  };

  environment: DeploymentEnvironment;

  provenance?: {
    provider: "github";
    attestation?: string;
  };

  deployedBy: string;
  deployedAt: string;
}

export function validateDeploymentAttestation(
  attestation: DeploymentAttestation,
): void {
  if (!attestation.repository.trim()) {
    throw new Error("repository is required");
  }

  if (!/^[0-9a-f]{40}$/i.test(attestation.commitSha)) {
    throw new Error("commitSha must be a 40-character Git SHA");
  }

  if (
    !/^sha256:[0-9a-f]{64}$/i.test(attestation.artifact.digest)
  ) {
    throw new Error(
      "artifact.digest must be a sha256 container digest",
    );
  }

  if (!attestation.deployedBy.trim()) {
    throw new Error("deployedBy is required");
  }

  if (Number.isNaN(Date.parse(attestation.deployedAt))) {
    throw new Error("deployedAt must be a valid ISO timestamp");
  }
}

export function serializeDeploymentAttestation(
  attestation: DeploymentAttestation,
): Uint8Array {
  validateDeploymentAttestation(attestation);

  return new TextEncoder().encode(
    JSON.stringify(attestation),
  );
}
