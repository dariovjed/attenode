import { parseArgs } from "node:util";
import { createKubernetesReader } from "../runtime/kubernetes-client.js";
import { verifyKubernetesDeployment, verificationExitCode } from "../runtime/kubernetes.js";

try {
  const { values } = parseArgs({ options: Object.fromEntries([
    "kubeconfig", "context", "namespace", "deployment", "container", "approved-image", "approved-runtime-image-id",
  ].map(name => [name, { type: "string" as const }])), strict: true, allowPositionals: false });
  for (const key of ["kubeconfig", "namespace", "deployment", "container", "approved-image"]) {
    if (!values[key]?.trim()) throw new Error("Missing required argument");
  }
  const approved = { namespace: values.namespace!, workload: values.deployment!, container: values.container!,
    imageReference: values["approved-image"]!, runtimeImageID: values["approved-runtime-image-id"] };
  console.log(`Target: ${approved.namespace}/${approved.workload} container=${approved.container}`);
  const report = await verifyKubernetesDeployment(createKubernetesReader(values.kubeconfig!, values.context), approved);
  console.log(JSON.stringify(report, null, 2));
  console.log(`Final status: ${report.result.status}`);
  process.exitCode = verificationExitCode(report.result);
} catch {
  console.error("CLI/configuration failure. Check required arguments, explicit kubeconfig path and context; external error details omitted.");
  process.exitCode = 1;
}
