/** A baseline for one named container in a Kubernetes Deployment. */
export interface ApprovedDeploymentIdentity {
  namespace: string;
  workload: string;
  container: string;
  imageReference: string;
  /** Observed CRI imageID, independent of Docker IDs and registry digests. */
  runtimeImageID?: string;
}

/** The adapter must establish Deployment ownership and supply a single container. */
export interface ObservedRuntimeIdentity {
  namespace: string;
  workload: string;
  pod: string;
  container: string;
  imageReference: string;
  runtimeImageID: string | null;
  ready: boolean;
}

export type VerificationStatus = "VERIFIED" | "TRUST_BROKEN" | "INDETERMINATE";
export type ReasonCode =
  | "INVALID_APPROVAL" | "MISSING_OBSERVATION" | "AMBIGUOUS_OBSERVATION"
  | "MALFORMED_OBSERVATION" | "TARGET_MISMATCH" | "IMAGE_REFERENCE_MISMATCH"
  | "RUNTIME_IMAGE_ID_MISMATCH" | "MISSING_RUNTIME_IMAGE_ID" | "CONTAINER_NOT_READY"
  | "BASELINE_MATCH";
export interface VerificationReason { code: ReasonCode; message: string; field?: string }
export interface RuntimeVerificationResult {
  status: VerificationStatus;
  reasons: VerificationReason[];
  /** Baseline comparison is not a signature or cryptographic provenance check. */
  basis: "image-reference" | "image-reference-and-runtime-image-id" | "none";
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value === value.trim() && !/\s/.test(value);
// Accept raw IDs and opaque CRI prefixes. Do not strip prefixes or convert them
// into registry digests: exact comparisons retain the source's identity domain.
const runtimeID = (value: unknown): value is string =>
  text(value) && /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^\s@]+@)?sha256:[0-9a-f]{64}$/.test(value);
const imageReference = (value: unknown): value is string =>
  text(value) && /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(value) &&
  (!value.includes("@") || /^[^@]+@sha256:[0-9a-f]{64}$/.test(value));

/** Pure, fail-closed comparison. Accepts unknown at the external-data boundary. */
export function verifyRuntimeIdentity(approved: unknown, observed: unknown): RuntimeVerificationResult {
  const result = (status: VerificationStatus, reasons: VerificationReason[], basis: RuntimeVerificationResult["basis"] = "none") => ({ status, reasons, basis });
  if (!record(approved) || !["namespace", "workload", "container"].every(field => text(approved[field])) ||
      !imageReference(approved.imageReference) ||
      (approved.runtimeImageID !== undefined && !runtimeID(approved.runtimeImageID))) {
    return result("INDETERMINATE", [{ code: "INVALID_APPROVAL", message: "Approval is missing or malformed." }]);
  }
  if (observed === null || observed === undefined) {
    return result("INDETERMINATE", [{ code: "MISSING_OBSERVATION", message: "No container observation is available." }]);
  }
  if (Array.isArray(observed)) {
    return result("INDETERMINATE", [{ code: "AMBIGUOUS_OBSERVATION", message: "Supply one unambiguously selected pod/container observation per comparison." }]);
  }
  if (!record(observed) || !["namespace", "workload", "pod", "container"].every(field => text(observed[field])) ||
      !imageReference(observed.imageReference) ||
      (observed.ready !== undefined && typeof observed.ready !== "boolean") ||
      (observed.runtimeImageID !== undefined && observed.runtimeImageID !== null && observed.runtimeImageID !== "" && !runtimeID(observed.runtimeImageID))) {
    return result("INDETERMINATE", [{ code: "MALFORMED_OBSERVATION", message: "Container observation has malformed identity or runtime fields." }]);
  }
  const reasons: VerificationReason[] = [];
  const basis = approved.runtimeImageID === undefined ? "image-reference" : "image-reference-and-runtime-image-id";
  for (const field of ["namespace", "workload", "container"] as const) {
    if (approved[field] !== observed[field]) reasons.push({ code: "TARGET_MISMATCH", field, message: `Observed ${field} does not match the approved target.` });
  }
  // Wrong target data is not evidence of drift in the intended Deployment.
  if (reasons.length) return result("INDETERMINATE", reasons);
  if (approved.imageReference !== observed.imageReference) {
    reasons.push({ code: "IMAGE_REFERENCE_MISMATCH", field: "imageReference", message: "Configured image reference differs from the approved reference." });
  }
  if (approved.runtimeImageID !== undefined && runtimeID(observed.runtimeImageID) && approved.runtimeImageID !== observed.runtimeImageID) {
    reasons.push({ code: "RUNTIME_IMAGE_ID_MISMATCH", field: "runtimeImageID", message: "Runtime imageID differs from the observed approved runtime baseline." });
  }
  const broken = reasons.length > 0;
  if (!runtimeID(observed.runtimeImageID)) reasons.push({ code: "MISSING_RUNTIME_IMAGE_ID", message: "Runtime imageID is not available." });
  if (observed.ready !== true) reasons.push({ code: "CONTAINER_NOT_READY", message: "Container readiness is absent or false." });
  if (broken) return result("TRUST_BROKEN", reasons, basis);
  if (reasons.length) return result("INDETERMINATE", reasons, basis);
  return result("VERIFIED", [{ code: "BASELINE_MATCH", message: "Ready container matches the supplied deployment baseline." }], basis);
}
