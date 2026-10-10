import { createDevnetSasReader, type SasAccountReader } from "../attestations/sas-reader.js";
import { demoApiIdentity, demoApiTarget } from "../scripts/devnet-demo-api.js";
import { runVerificationCli } from "./verification-cli.js";
import { formatDiagnostic, isDiagnosticCode, safeDiagnostic, VerificationDiagnosticError, type SafeDiagnostic } from "./diagnostics.js";

export interface CliDiagnosticReport {
  mode: "SAS_CLI_WITH_MOCK_KUBERNETES";
  sasApproval: "SUCCEEDED" | "REJECTED" | "NOT_COMPLETED";
  sasFactoryInvoked: boolean;
  reachedKubernetesAdapter: boolean;
  mockObservationInvoked: boolean;
  mockCalls: { deployment: number; replicaSets: number; pods: number };
  sanitizedError: SafeDiagnostic | null;
  cliExitCode: number;
  diagnosticPassed: boolean;
  runtimeVerification: "NOT_EVALUATED_MOCK_KUBERNETES";
}

function reconstructDiagnostic(value: unknown): SafeDiagnostic | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!isDiagnosticCode(record.code)) return null;
  // Reconstruct only catalog text and allowlisted context; never forward serialized external text.
  return safeDiagnostic(new VerificationDiagnosticError(record.code, record), "SAS_ACCOUNT_VALIDATION");
}

/** Production default uses REAL finalized Devnet reads. Injection exists exclusively for offline tests.
 * This module never imports the real Kubernetes client or reads configuration.
 */
export async function diagnoseVerificationCli(sasFactory: () => SasAccountReader = createDevnetSasReader): Promise<CliDiagnosticReport> {
  const report: CliDiagnosticReport = { mode: "SAS_CLI_WITH_MOCK_KUBERNETES", sasApproval: "NOT_COMPLETED", sasFactoryInvoked: false,
    reachedKubernetesAdapter: false, mockObservationInvoked: false, mockCalls: { deployment: 0, replicaSets: 0, pods: 0 },
    sanitizedError: null, cliExitCode: 1, diagnosticPassed: false, runtimeVerification: "NOT_EVALUATED_MOCK_KUBERNETES" };
  const args = ["--sas", "--json", "--kubeconfig", "DIAGNOSTIC_MOCK_ONLY_NO_FILE", "--context", "DIAGNOSTIC_MOCK_ONLY",
    "--namespace", demoApiTarget.namespace, "--deployment", demoApiTarget.deployment, "--container", demoApiTarget.container,
    "--image-repository", demoApiIdentity.imageRepository];
  const result = await runVerificationCli(args, {
    sasReader() { report.sasFactoryInvoked = true; return sasFactory(); },
    kubernetesReader() {
      report.reachedKubernetesAdapter = true;
      return {
        async deployment() {
          report.mockCalls.deployment++;
          return { metadata: { namespace: demoApiTarget.namespace, name: demoApiTarget.deployment, uid: "diagnostic-mock-deployment", resourceVersion: "1" } };
        },
        async replicaSets() { report.mockCalls.replicaSets++; return []; },
        async pods() { report.mockCalls.pods++; report.mockObservationInvoked = true; return []; },
      };
    },
  });
  report.cliExitCode = result.exitCode;
  try {
    if (result.stderr) {
      report.sanitizedError = reconstructDiagnostic(JSON.parse(result.stderr).error);
    } else if (result.stdout) {
      const cliReport = JSON.parse(result.stdout);
      report.sasApproval = cliReport.sas?.status === "VERIFIED" ? "SUCCEEDED" : "REJECTED";
      report.sanitizedError = reconstructDiagnostic(cliReport.sas?.diagnostic);
    }
  } catch {
    report.sanitizedError = safeDiagnostic(new Error(), "SAS_ACCOUNT_VALIDATION");
  }
  report.diagnosticPassed = report.sasApproval === "SUCCEEDED" && report.reachedKubernetesAdapter && report.mockObservationInvoked && !report.sanitizedError;
  return report;
}

export function formatVerificationCliDiagnostic(report: CliDiagnosticReport, json = false): string {
  if (json) return JSON.stringify(report, null, 2);
  const lines = ["Attenode CLI diagnostic: REAL Devnet SAS, MOCK Kubernetes",
    `SAS factory invoked: ${report.sasFactoryInvoked}`, `SAS approval: ${report.sasApproval}`,
    `CLI reached Kubernetes adapter: ${report.reachedKubernetesAdapter}`, `Mock Pod observation invoked: ${report.mockObservationInvoked}`,
    `Mock calls: Deployment=${report.mockCalls.deployment}, ReplicaSets=${report.mockCalls.replicaSets}, Pods=${report.mockCalls.pods}`,
    `Inner CLI exit code: ${report.cliExitCode} (3 is expected after successful SAS with empty mock Pods)`,
    `Diagnostic completed: ${report.diagnosticPassed ? "PASS" : "FAIL"}`];
  lines.push(report.sanitizedError ? formatDiagnostic(report.sanitizedError) : "Sanitized error: none");
  lines.push("Real Kubernetes runtime verification: NOT EVALUATED. No runtime VERIFIED claim is made.",
    "The mock returns no Pods and never reads kubeconfig or contacts Kubernetes.");
  return lines.join("\n");
}
