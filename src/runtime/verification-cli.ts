import { parseVerificationArgs, formatKubernetesReport, formatSasKubernetesReport } from "./kubernetes-output.js";
import { verifyKubernetesDeployment, verificationExitCode, type KubernetesReader } from "./kubernetes.js";
import type { SasAccountReader } from "../attestations/sas-reader.js";
import { validateSasBindingPolicy, verifySasKubernetesDeployment } from "./sas-verification.js";
import { atDiagnosticStage, formatDiagnostic, safeDiagnostic, VerificationDiagnosticError, type DiagnosticStage } from "./diagnostics.js";

export interface VerificationCliDependencies {
  sasReader(): SasAccountReader;
  kubernetesReader(kubeconfig: string, context?: string): KubernetesReader | Promise<KubernetesReader>;
}
export interface VerificationCliResult { exitCode: number; stdout?: string; stderr?: string }

/** Injected factories allow all CLI failure paths to be tested without configuration or network access. */
export async function runVerificationCli(args: string[], dependencies: VerificationCliDependencies): Promise<VerificationCliResult> {
  let stage: DiagnosticStage = "CLI_ARGUMENTS";
  let json = args.includes("--json");
  try {
    const values = parseVerificationArgs(args);
    json = values.json;
    for (const key of ["kubeconfig", "namespace", "deployment", "container"] as const) {
      if (!values[key]?.trim()) throw new VerificationDiagnosticError("CLI_ARGUMENTS_INVALID");
    }
    if (values.sas) {
      if (!values.context?.trim() || !values["image-repository"]?.trim()) throw new VerificationDiagnosticError("CLI_ARGUMENTS_INVALID");
      const policy = { namespace: values.namespace!, workload: values.deployment!, container: values.container!, imageRepository: values["image-repository"]! };
      stage = "SAS_APPROVAL_BINDING";
      validateSasBindingPolicy(policy);
      stage = "SAS_RPC";
      const reader = await atDiagnosticStage(stage, dependencies.sasReader);
      stage = "SAS_ACCOUNT_VALIDATION";
      const report = await verifySasKubernetesDeployment(reader,
        () => dependencies.kubernetesReader(values.kubeconfig!, values.context), policy);
      return { stdout: formatSasKubernetesReport(report, json), exitCode: verificationExitCode(report.result) };
    }
    if (!values["approved-image"]?.trim()) throw new VerificationDiagnosticError("CLI_ARGUMENTS_INVALID");
    const approved = { namespace: values.namespace!, workload: values.deployment!, container: values.container!,
      imageReference: values["approved-image"]!, runtimeImageID: values["approved-runtime-image-id"] };
    stage = "KUBERNETES_CLIENT";
    const reader = await atDiagnosticStage(stage, () => dependencies.kubernetesReader(values.kubeconfig!, values.context));
    stage = "KUBERNETES_OBSERVATION";
    const report = await verifyKubernetesDeployment(reader, approved);
    return { stdout: formatKubernetesReport(report, json), exitCode: verificationExitCode(report.result) };
  } catch (error) {
    return { stderr: formatDiagnostic(safeDiagnostic(error, stage), json), exitCode: 1 };
  }
}
