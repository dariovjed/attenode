import { parseVerificationArgs, formatKubernetesReport } from "../runtime/kubernetes-output.js";
import { createKubernetesReader } from "../runtime/kubernetes-client.js";
import { verifyKubernetesDeployment, verificationExitCode } from "../runtime/kubernetes.js";

try {
  const values = parseVerificationArgs(process.argv.slice(2));
  for (const key of ["kubeconfig", "namespace", "deployment", "container", "approved-image"] as const) {
    if (!values[key]?.trim()) throw new Error("Missing required argument");
  }
  const approved = { namespace: values.namespace!, workload: values.deployment!, container: values.container!,
    imageReference: values["approved-image"]!, runtimeImageID: values["approved-runtime-image-id"] };
  const report = await verifyKubernetesDeployment(createKubernetesReader(values.kubeconfig!, values.context), approved);
  console.log(formatKubernetesReport(report, values.json));
  process.exitCode = verificationExitCode(report.result);
} catch {
  console.error("CLI/configuration failure. Check required arguments, explicit kubeconfig path and context; external error details omitted.");
  process.exitCode = 1;
}
