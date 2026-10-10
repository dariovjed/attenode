import { parseArgs } from "node:util";
import type { KubernetesVerification } from "./kubernetes.js";
import type { SasKubernetesReport } from "./sas-verification.js";
import { formatDiagnostic, VerificationDiagnosticError } from "./diagnostics.js";

export function parseVerificationArgs(args: string[]) {
  const { values, tokens } = parseArgs({ args, tokens: true, options: {
    kubeconfig: { type: "string" }, context: { type: "string" }, namespace: { type: "string" },
    deployment: { type: "string" }, container: { type: "string" }, "approved-image": { type: "string" },
    "approved-runtime-image-id": { type: "string" }, json: { type: "boolean", default: false },
    sas: { type: "boolean", default: false }, "image-repository": { type: "string" },
  }, strict: true, allowPositionals: false });
  const options = tokens.filter(token => token.kind === "option").map(token => token.name);
  if (new Set(options).size !== options.length) throw new VerificationDiagnosticError("CLI_ARGUMENTS_DUPLICATE");
  if (values.sas && (values["approved-image"] !== undefined || values["approved-runtime-image-id"] !== undefined)) {
    throw new VerificationDiagnosticError("SAS_MANUAL_OVERRIDE");
  }
  if (!values.sas && values["image-repository"] !== undefined) throw new VerificationDiagnosticError("CLI_ARGUMENTS_INVALID");
  return values;
}
// Keep terminal control characters out of human display; JSON retains all data.
const display = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

export function formatSasKubernetesReport(report: SasKubernetesReport, json = false): string {
  if (json) return JSON.stringify(report, null, 2);
  const lines = ["Attenode SAS + Kubernetes Verification", `Overall: ${report.result.status}`, `  ${display(report.result.reason)}`,
    "", `SAS attestation validation: ${report.sas.status}`, `  Devnet: ${report.sas.attestation}`, `  ${display(report.sas.reason)}`];
  if (report.sas.diagnostic) lines.push(formatDiagnostic(report.sas.diagnostic));
  if (report.sas.payload) lines.push(`  repository: ${display(report.sas.payload.repository)}`, `  commit: ${report.sas.payload.commitSha}`,
    `  environment: ${display(report.sas.payload.environment)}`, `  approved manifest: ${report.sas.payload.artifactDigest}`, `  expires (Unix seconds): ${report.sas.expiry}`);
  lines.push("", "Local binding policy (not on-chain claims)",
    `  ${display(report.localPolicy.namespace)}/${display(report.localPolicy.workload)} container ${display(report.localPolicy.container)}`,
    `  image repository: ${display(report.localPolicy.imageRepository)}`,
    "", `Runtime artifact identity evidence: ${report.artifact.status}`, `  ${display(report.artifact.reason)}`);
  for (const pod of report.artifact.perPod.slice(0, 5)) lines.push(`  ${display(pod.pod)}: ${pod.result.status} — ${display(pod.result.reason)}`);
  if (report.artifact.perPod.length > 5) lines.push("  Additional per-Pod artifact results available with --json.");
  lines.push("", "Kubernetes baseline agreement (configuration comparison)");
  lines.push(report.kubernetes ? formatKubernetesReport(report.kubernetes) : "  Not evaluated; SAS approval is unavailable.");
  lines.push("", "Runtime reporting and local binding policy are trusted. No verified build provenance is claimed.");
  return lines.join("\n");
}

export function formatKubernetesReport(report: KubernetesVerification, json = false): string {
  if (json) return JSON.stringify(report, null, 2);
  const { approved, observations, result } = report;
  const lines = ["Attenode Runtime Verification", "", "Target",
    `  ${display(approved.namespace)}/${display(approved.workload)}`, `  container: ${display(approved.container)}`,
    "", "Approved", `  image: ${display(approved.imageReference)}`,
    `  runtime: ${approved.runtimeImageID ? display(approved.runtimeImageID) : "not supplied"}`, "", "Observed"];
  if (!observations.length) lines.push("  no Pod/runtime observations available");
  // Group consistent replicas to avoid repeating full digests for each Pod.
  const groups = new Map<string, typeof observations>();
  for (const observation of observations) {
    const key = JSON.stringify([observation.imageReference, observation.runtimeImageID, observation.ready]);
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  for (const group of [...groups.values()].slice(0, 5)) {
    const first = group[0]!;
    const names = group.slice(0, 3).map(o => display(o.pod)).join(", ");
    const extra = group.length > 3 ? ` (+${group.length - 3} more)` : "";
    lines.push(`  ${group.length === 1 ? "pod" : `pods (${group.length})`}: ${names}${extra}`,
      `  image: ${display(first.imageReference)}`, `  runtime: ${first.runtimeImageID ? display(first.runtimeImageID) : "missing"}`,
      `  ready: ${first.ready}`, "");
  }
  if (groups.size > 5) lines.push(`  ${groups.size - 5} additional observation groups omitted; use --json for all Pods.`, "");
  if (report.collectionIssues.length) {
    lines.push("Collection issues");
    const issues = [...new Set(report.collectionIssues)];
    for (const issue of issues.slice(0, 5)) lines.push(`  ${display(issue)}`);
    if (issues.length > 5) lines.push(`  ${issues.length - 5} additional issues; use --json for details.`);
    lines.push("");
  }
  for (const safe of report.diagnostics ?? []) lines.push(formatDiagnostic(safe));
  const symbol = result.status === "VERIFIED" ? "✓" : result.status === "TRUST_BROKEN" ? "✗" : "?";
  lines.push(`${symbol} ${result.status}`);
  for (const reason of result.reasons) lines.push(`  ${reason.code}: ${display(reason.message)}`);
  // Ambiguous aggregate reports retain visible per-Pod drift explanations.
  if (result.status === "INDETERMINATE") {
    const drift = new Set(report.perPod.filter(p => p.result.status === "TRUST_BROKEN")
      .flatMap(p => p.result.reasons.map(r => r.code)));
    if (drift.size) lines.push(`  Pod drift reasons: ${[...drift].join(", ")}`);
  }
  return lines.join("\n");
}
