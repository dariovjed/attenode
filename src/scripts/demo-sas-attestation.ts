import { serializeAttestationData } from "sas-lib";

import {
  validateDeploymentAttestation,
  type DeploymentAttestation,
} from "../attestations/deployment.js";
import {
  deploymentSasFieldNames,
  deploymentSasSchema,
  toDeploymentSasPayload,
} from "../attestations/sas.js";

const deployment: DeploymentAttestation = {
  version: 1,
  repository: "dariovjed/attenode-demo-api",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  artifact: {
    type: "container",
    digest:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  environment: "production",
  provenance: { provider: "github" },
  deployedBy: "GisnMiKvJUJfjCejzMbVCRpjcWvWWaFNUMokHaJmpr75",
  deployedAt: new Date().toISOString(),
};

validateDeploymentAttestation(deployment);
const payload = toDeploymentSasPayload(deployment);
const encoded = serializeAttestationData(deploymentSasSchema, payload);

console.log("Attenode offline SAS deployment attestation");
console.log(`Schema: ${new TextDecoder().decode(deploymentSasSchema.name)}`);
console.log(`Fields (all strings): ${deploymentSasFieldNames.join(", ")}`);
console.log(`Bytes: ${encoded.length}`);
console.log("Status: VALID");
