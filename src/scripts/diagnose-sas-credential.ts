import { parseArgs } from "node:util";
import { diagnoseCredentialFetch, formatCredentialFetchReport } from "../attestations/sas-fetch-diagnostic.js";
import { formatDiagnostic, safeDiagnostic } from "../runtime/diagnostics.js";

try {
  const { values } = parseArgs({ options: { json: { type: "boolean", default: false } }, strict: true, allowPositionals: false });
  const report = await diagnoseCredentialFetch();
  console.log(formatCredentialFetchReport(report, values.json));
  const steps = [report.clientInitialization, report.publicKeyConversion, report.confirmedFetch, report.finalizedFetch,
    ...Object.values(report.responseShapeValidation), ...Object.values(report.credentialValidation)];
  process.exitCode = steps.every(step => step.status === "PASS") ? 0 : 1;
} catch (error) {
  console.error(formatDiagnostic(safeDiagnostic(error, "CLI_ARGUMENTS"), process.argv.includes("--json")));
  process.exitCode = 1;
}
