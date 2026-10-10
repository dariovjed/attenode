export type DiagnosticStage = "CLI_ARGUMENTS" | "SAS_RPC" | "SAS_ACCOUNT_VALIDATION" |
  "SAS_APPROVAL_BINDING" | "KUBERNETES_CLIENT" | "KUBERNETES_OBSERVATION";

// All displayable text is owned here. Never retain an external message, stack, cause, URL or context.
const definitions = {
  CLI_ARGUMENTS_INVALID: ["CLI_ARGUMENTS", "Verification arguments are invalid or incomplete.", "Check required arguments and use --sas without manual approval flags."],
  CLI_ARGUMENTS_DUPLICATE: ["CLI_ARGUMENTS", "A verification option was supplied more than once.", "Supply each option once."],
  SAS_MANUAL_OVERRIDE: ["CLI_ARGUMENTS", "Manual approval overrides are forbidden in SAS mode.", "Remove --approved-image and --approved-runtime-image-id when using --sas."],
  SAS_BINDING_UNSUPPORTED: ["SAS_APPROVAL_BINDING", "Local binding does not match the supported demo-api policy.", "Use attenode-demo/demo-api, container demo-api and image repository ghcr.io/dariovjed/demo-api."],
  SAS_RPC_FAILED: ["SAS_RPC", "Devnet RPC initialization or account read failed.", "Check Devnet availability and local network/proxy/TLS configuration, then retry read-only verification."],
  SAS_RPC_INITIALIZATION_FAILED: ["SAS_RPC", "Devnet RPC client initialization failed before account fetching.", "Check the installed Gill runtime and local RPC/proxy/TLS configuration; compare with the Devnet verify-only CLI."],
  SAS_RPC_ACCOUNT_FETCH_FAILED: ["SAS_RPC", "The SDK account fetch failed during the RPC request or response parsing.", "Retry the Devnet verify-only CLI and compare confirmed versus finalized read availability; no automatic commitment downgrade is performed."],
  SAS_RPC_RESPONSE_INVALID: ["SAS_RPC", "The SDK returned an unexpected encoded-account response shape.", "Check SDK compatibility; expected an exists flag, requested address and encoded account bytes, not raw JSON-RPC or parsed account data."],
  SAS_RPC_RESPONSE_DECODE_FAILED: ["SAS_RPC", "The SDK could not decode the account response bytes.", "Check SDK compatibility and RPC base64 response handling; attestation validation was not bypassed."],
  SAS_SDK_ADDRESS_INVALID: ["SAS_RPC", "The SDK rejected the public account address locally.", "Check conversion to Gill Address; this category does not establish a network failure."],
  SAS_RPC_RATE_LIMITED: ["SAS_RPC", "Devnet RPC rate-limited the request.", "Wait briefly and retry the read-only verification."],
  SAS_RPC_UNREACHABLE: ["SAS_RPC", "Devnet RPC could not be reached.", "Check DNS, connectivity and proxy configuration for the public Devnet endpoint."],
  SAS_RPC_TIMEOUT: ["SAS_RPC", "Devnet RPC timed out.", "Check connectivity and retry the read-only verification."],
  SAS_ACCOUNT_MISSING: ["SAS_ACCOUNT_VALIDATION", "A required finalized SAS account is missing.", "Confirm the credential, schema and real demo-api attestation exist on Devnet and have finalized."],
  SAS_CREDENTIAL_REJECTED: ["SAS_ACCOUNT_VALIDATION", "SAS credential validation failed.", "Check the expected credential PDA, program owner, discriminator, authority and authorized issuer."],
  SAS_SCHEMA_REJECTED: ["SAS_ACCOUNT_VALIDATION", "SAS schema validation failed.", "Check the expected schema PDA, program owner, discriminator, version, layout and pause state."],
  SAS_ATTESTATION_REJECTED: ["SAS_ACCOUNT_VALIDATION", "Real demo-api attestation validation failed.", "Read back the real attestation and check its PDA, nonce, issuer, exact payload, timestamps and expiration."],
  SAS_ACCOUNT_VALIDATION_FAILED: ["SAS_ACCOUNT_VALIDATION", "SAS account validation could not complete.", "Check the real demo-api account chain and current system time."],
  SAS_APPROVAL_EXPIRED: ["SAS_ACCOUNT_VALIDATION", "The SAS approval expired during runtime collection.", "Use an authorized, unexpired approval; do not treat the expired account as current approval."],
  SAS_APPROVAL_BINDING_FAILED: ["SAS_APPROVAL_BINDING", "The SAS approval could not be bound to the local target.", "Check the supported demo-api target and image repository policy."],
  KUBECONFIG_NOT_FOUND: ["KUBERNETES_CLIENT", "The explicitly selected kubeconfig could not be found.", "Check the supplied path; this command does not use a default kubeconfig."],
  KUBECONFIG_ACCESS_DENIED: ["KUBERNETES_CLIENT", "The explicitly selected kubeconfig could not be read.", "Check file permissions for the explicitly authorized kubeconfig."],
  KUBECONFIG_LOAD_FAILED: ["KUBERNETES_CLIENT", "The explicitly selected kubeconfig could not be loaded.", "Check that the approved file is readable and contains valid Kubernetes configuration."],
  KUBERNETES_CONTEXT_INVALID: ["KUBERNETES_CLIENT", "The selected Kubernetes context or cluster is missing.", "Check that the explicit context exists and references a configured cluster."],
  KUBERNETES_CLIENT_FAILED: ["KUBERNETES_CLIENT", "Kubernetes client initialization failed.", "Check the selected context, cluster and authentication configuration in the approved kubeconfig."],
  KUBERNETES_OBSERVATION_FAILED: ["KUBERNETES_OBSERVATION", "Kubernetes runtime observation failed.", "Check API connectivity, authentication and read permissions for Deployments, ReplicaSets and Pods."],
  KUBERNETES_AUTHENTICATION_FAILED: ["KUBERNETES_OBSERVATION", "Kubernetes rejected authentication.", "Check credentials or the configured authentication plugin using the authorized operational workflow."],
  KUBERNETES_AUTHORIZATION_FAILED: ["KUBERNETES_OBSERVATION", "Kubernetes denied a required read operation.", "Ensure the selected identity can GET the Deployment and list ReplicaSets and Pods in the namespace."],
  KUBERNETES_RESOURCE_NOT_FOUND: ["KUBERNETES_OBSERVATION", "A requested Kubernetes resource was not found.", "Check the namespace and Deployment in the selected cluster."],
  KUBERNETES_TARGET_INVALID: ["KUBERNETES_OBSERVATION", "The target Deployment observation is invalid or terminating.", "Check target metadata and wait for a stable, non-terminating Deployment before retrying."],
  KUBERNETES_OBSERVATION_INCOMPLETE: ["KUBERNETES_OBSERVATION", "Runtime collection is incomplete or ambiguous.", "Review collection issues, ownership, container status and rollout readiness; retry once stable."],
} as const;

export type DiagnosticCode = keyof typeof definitions;
export function isDiagnosticCode(value: unknown): value is DiagnosticCode {
  return typeof value === "string" && Object.hasOwn(definitions, value);
}
export interface DiagnosticContext {
  operation?: "RPC_INITIALIZATION" | "ACCOUNT_FETCH" | "RESPONSE_DECODING";
  accountKind?: "CREDENTIAL" | "SCHEMA" | "ATTESTATION";
}
export interface SafeDiagnostic extends DiagnosticContext { stage: DiagnosticStage; code: DiagnosticCode; explanation: string; action: string }
export function diagnostic(code: DiagnosticCode): SafeDiagnostic {
  const [stage, explanation, action] = definitions[code];
  return { stage, code, explanation, action };
}
export class VerificationDiagnosticError extends Error {
  readonly diagnostic: SafeDiagnostic;
  constructor(code: DiagnosticCode, context: DiagnosticContext = {}) {
    const safe = diagnostic(code);
    super(safe.explanation);
    this.name = "VerificationDiagnosticError";
    this.diagnostic = { ...safe, ...safeContext(context) };
  }
}

const defaults: Record<DiagnosticStage, DiagnosticCode> = {
  CLI_ARGUMENTS: "CLI_ARGUMENTS_INVALID", SAS_RPC: "SAS_RPC_FAILED",
  SAS_ACCOUNT_VALIDATION: "SAS_ACCOUNT_VALIDATION_FAILED", SAS_APPROVAL_BINDING: "SAS_APPROVAL_BINDING_FAILED",
  KUBERNETES_CLIENT: "KUBERNETES_CLIENT_FAILED", KUBERNETES_OBSERVATION: "KUBERNETES_OBSERVATION_FAILED",
};
// Examine only allowlisted scalar error categories, never external text or serialized objects.
function field(value: unknown, key: string): unknown {
  try { return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}
function safeContext(value: unknown): DiagnosticContext {
  const operation = field(value, "operation"), accountKind = field(value, "accountKind");
  return {
    ...(operation === "RPC_INITIALIZATION" || operation === "ACCOUNT_FETCH" || operation === "RESPONSE_DECODING" ? { operation } : {}),
    ...(accountKind === "CREDENTIAL" || accountKind === "SCHEMA" || accountKind === "ATTESTATION" ? { accountKind } : {}),
  };
}
export function safeDiagnostic(error: unknown, stage: DiagnosticStage): SafeDiagnostic {
  if (error instanceof VerificationDiagnosticError) {
    const code = error.diagnostic.code;
    // Reconstruct from the catalog rather than trusting a mutated error message or diagnostic text.
    if (Object.hasOwn(definitions, code)) return { ...diagnostic(code), ...safeContext(error.diagnostic) };
  }
  const code = field(error, "code") ?? field(field(error, "cause"), "code");
  const status = field(error, "statusCode") ?? field(error, "status") ?? field(field(error, "response"), "statusCode") ?? field(field(error, "response"), "status");
  if (stage === "SAS_RPC") {
    if (status === 429 || code === 429) return diagnostic("SAS_RPC_RATE_LIMITED");
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED" || code === "ENETUNREACH") return diagnostic("SAS_RPC_UNREACHABLE");
    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return diagnostic("SAS_RPC_TIMEOUT");
  }
  if (stage === "KUBERNETES_CLIENT") {
    if (code === "ENOENT") return diagnostic("KUBECONFIG_NOT_FOUND");
    if (code === "EACCES" || code === "EPERM") return diagnostic("KUBECONFIG_ACCESS_DENIED");
  }
  if (stage === "KUBERNETES_OBSERVATION") {
    if (status === 401 || code === 401) return diagnostic("KUBERNETES_AUTHENTICATION_FAILED");
    if (status === 403 || code === 403) return diagnostic("KUBERNETES_AUTHORIZATION_FAILED");
    if (status === 404 || code === 404) return diagnostic("KUBERNETES_RESOURCE_NOT_FOUND");
  }
  return diagnostic(defaults[stage]);
}
export async function atDiagnosticStage<T>(stage: DiagnosticStage, operation: () => T | Promise<T>, context: DiagnosticContext = {}): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const safe = safeDiagnostic(error, stage);
    throw new VerificationDiagnosticError(safe.code, { ...context, ...safeContext(safe) });
  }
}
export function formatDiagnostic(safe: SafeDiagnostic, json = false): string {
  // Only catalog values can be printed, including when the caller supplied a modified object.
  const value = { ...diagnostic(safe.code), ...safeContext(safe) };
  return json ? JSON.stringify({ error: value }) : `[${value.stage}] ${value.code}: ${value.explanation}` +
    (value.operation ? `\nOperation: ${value.operation}` : "") + (value.accountKind ? `\nAccount: ${value.accountKind}` : "") + `\nAction: ${value.action}`;
}
