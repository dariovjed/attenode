import { parseArgs } from "node:util";
import { diagnoseVerificationCli, formatVerificationCliDiagnostic } from "../runtime/verification-cli-diagnostic.js";
import { formatDiagnostic, safeDiagnostic } from "../runtime/diagnostics.js";

try {
  const { values } = parseArgs({ options: { json: { type: "boolean", default: false } }, strict: true, allowPositionals: false });
  const report = await diagnoseVerificationCli();
  console.log(formatVerificationCliDiagnostic(report, values.json));
  process.exitCode = report.diagnosticPassed ? 0 : 1;
} catch (error) {
  console.error(formatDiagnostic(safeDiagnostic(error, "CLI_ARGUMENTS"), process.argv.includes("--json")));
  process.exitCode = 1;
}
