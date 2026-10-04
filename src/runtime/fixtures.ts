import type { ApprovedDeploymentIdentity, ObservedRuntimeIdentity } from "./verification.js";

export const approvedDemo: ApprovedDeploymentIdentity = {
  namespace: "attenode-demo", workload: "demo-api", container: "demo-api",
  imageReference: "attenode/demo-api:v1",
  runtimeImageID: "sha256:236c1d781bc1577bcf8eea8dabab84a0e6bbc31e28255550d2afdf9c8d903937",
};
export const observedV1: ObservedRuntimeIdentity = {
  namespace: "attenode-demo", workload: "demo-api", pod: "demo-api-v1-fixture", container: "demo-api",
  imageReference: "attenode/demo-api:v1", runtimeImageID: approvedDemo.runtimeImageID!, ready: true,
};
export const observedV2: ObservedRuntimeIdentity = {
  ...observedV1, pod: "demo-api-v2-fixture", imageReference: "attenode/demo-api:v2",
  runtimeImageID: "sha256:6968be0298a655127c3a5a12e263bdc3e52c24439cd69b98b45e5e06415e0ac3",
};
