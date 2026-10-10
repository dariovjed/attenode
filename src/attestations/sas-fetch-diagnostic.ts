import { address, type Address } from "gill";
import { createDevnetSolanaClient, fetchDevnetEncodedAccount } from "./devnet-rpc.js";
import { accountFetchDiagnostic, validateEncodedAccountResponse } from "./sas-reader.js";
import { diagnostic, formatDiagnostic, safeDiagnostic, type SafeDiagnostic } from "../runtime/diagnostics.js";
import { expectedCredential, verifyCredential } from "../scripts/devnet-schema-verification.js";

type Step = { status: "PASS" | "FAIL" | "SKIPPED"; diagnostic?: SafeDiagnostic };
type Commitment = "confirmed" | "finalized";
export interface CredentialFetchReport {
  credential: string;
  clientInitialization: Step;
  publicKeyConversion: Step;
  confirmedFetch: Step;
  finalizedFetch: Step;
  responseShapeValidation: Record<Commitment, Step>;
  credentialValidation: Record<Commitment, Step>;
}
export interface CredentialDiagnosticDependencies {
  createClient(): Pick<ReturnType<typeof createDevnetSolanaClient>, "rpc">;
  convertAddress(value: string): Address;
  fetchAccount(rpc: ReturnType<typeof createDevnetSolanaClient>["rpc"], key: Address, config: { commitment: Commitment }): Promise<unknown>;
}

/** Two independent diagnostic reads. Confirmed success never substitutes for finalized approval. */
export async function diagnoseCredentialFetch(dependencies: CredentialDiagnosticDependencies = {
  createClient: createDevnetSolanaClient, convertAddress: address, fetchAccount: fetchDevnetEncodedAccount,
}): Promise<CredentialFetchReport> {
  const skip = (): Step => ({ status: "SKIPPED" });
  const report: CredentialFetchReport = { credential: expectedCredential, clientInitialization: skip(), publicKeyConversion: skip(),
    confirmedFetch: skip(), finalizedFetch: skip(), responseShapeValidation: { confirmed: skip(), finalized: skip() },
    credentialValidation: { confirmed: skip(), finalized: skip() } };
  let rpc: ReturnType<typeof createDevnetSolanaClient>["rpc"] | undefined;
  let key: Address | undefined;
  try {
    rpc = dependencies.createClient().rpc;
    if (!rpc || typeof rpc.getAccountInfo !== "function") throw new Error("Invalid client");
    report.clientInitialization = { status: "PASS" };
  } catch (error) {
    const safe = safeDiagnostic(error, "SAS_RPC");
    report.clientInitialization = { status: "FAIL", diagnostic: { ...diagnostic(safe.code === "SAS_RPC_FAILED" ? "SAS_RPC_INITIALIZATION_FAILED" : safe.code), operation: "RPC_INITIALIZATION" } };
  }
  try {
    key = dependencies.convertAddress(expectedCredential);
    if (typeof key !== "string" || key !== expectedCredential) throw new Error("Unexpected key");
    report.publicKeyConversion = { status: "PASS" };
  } catch {
    report.publicKeyConversion = { status: "FAIL", diagnostic: diagnostic("SAS_SDK_ADDRESS_INVALID") };
  }
  if (!rpc || !key || report.clientInitialization.status !== "PASS" || report.publicKeyConversion.status !== "PASS") return report;
  for (const commitment of ["confirmed", "finalized"] as const) {
    const fetchStep = commitment === "confirmed" ? "confirmedFetch" : "finalizedFetch";
    let response: unknown;
    try {
      response = await dependencies.fetchAccount(rpc, key, { commitment });
      report[fetchStep] = { status: "PASS" };
    } catch (error) {
      report[fetchStep] = { status: "FAIL", diagnostic: { ...accountFetchDiagnostic(error), accountKind: "CREDENTIAL" } };
      continue;
    }
    let account;
    try {
      account = validateEncodedAccountResponse(response, key);
      report.responseShapeValidation[commitment] = { status: "PASS" };
    } catch (error) {
      report.responseShapeValidation[commitment] = { status: "FAIL", diagnostic: safeDiagnostic(error, "SAS_RPC") };
      continue;
    }
    if (!account) {
      report.credentialValidation[commitment] = { status: "FAIL", diagnostic: diagnostic("SAS_ACCOUNT_MISSING") };
      continue;
    }
    try { verifyCredential(account); report.credentialValidation[commitment] = { status: "PASS" }; }
    catch { report.credentialValidation[commitment] = { status: "FAIL", diagnostic: diagnostic("SAS_CREDENTIAL_REJECTED") }; }
  }
  return report;
}

export function formatCredentialFetchReport(report: CredentialFetchReport, json = false): string {
  if (json) return JSON.stringify(report, null, 2);
  const lines = ["Attenode read-only Devnet Credential diagnostic", `Credential: ${report.credential}`];
  const stages: [string, Step][] = [["Client initialization", report.clientInitialization], ["Public key conversion (Gill Address)", report.publicKeyConversion],
    ["Confirmed fetch", report.confirmedFetch], ["Finalized fetch", report.finalizedFetch],
    ["Confirmed response shape", report.responseShapeValidation.confirmed], ["Finalized response shape", report.responseShapeValidation.finalized],
    ["Confirmed credential validation", report.credentialValidation.confirmed], ["Finalized credential validation", report.credentialValidation.finalized]];
  for (const [label, step] of stages) {
    lines.push(`${label}: ${step.status}`);
    if (step.diagnostic) lines.push(formatDiagnostic(step.diagnostic));
  }
  lines.push("A generic account-fetch failure may be SDK, transport or response parsing; it is not proof of a network failure.",
    "Both commitments were tested independently. No runtime approval, commitment downgrade or transaction is performed.");
  return lines.join("\n");
}
