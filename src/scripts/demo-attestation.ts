import {
  serializeDeploymentAttestation,
  validateDeploymentAttestation,
  type DeploymentAttestation,
} from "../attestations/deployment.js";

const deployment: DeploymentAttestation = {
  version: 1,

  repository: "dariovjed/attenode-demo-api",

  commitSha:
    "0123456789abcdef0123456789abcdef01234567",

  artifact: {
    type: "container",
    digest:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },

  environment: "production",

  provenance: {
    provider: "github",
  },

  deployedBy:
    "GisnMiKvJUJfjCejzMbVCRpjcWvWWaFNUMokHaJmpr75",

  deployedAt: new Date().toISOString(),
};

validateDeploymentAttestation(deployment);

const encoded =
  serializeDeploymentAttestation(deployment);

console.log("Attenode Deployment Attestation");
console.log("--------------------------------");
console.log(JSON.stringify(deployment, null, 2));

console.log("\nSerialized payload");
console.log(`Bytes: ${encoded.length}`);

console.log("\nStatus: VALID");
