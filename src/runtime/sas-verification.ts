import { readDemoApiApproval, type SasApproval } from "../attestations/sas-approval.js";
import type { SasAccountReader } from "../attestations/sas-reader.js";
import { demoApiIdentity, demoApiTarget } from "../scripts/devnet-demo-api.js";
import { verifyKubernetesDeployment, type KubernetesReader, type KubernetesVerification } from "./kubernetes.js";
import type { ObservedRuntimeIdentity, VerificationStatus } from "./verification.js";
import { atDiagnosticStage, diagnostic, VerificationDiagnosticError } from "./diagnostics.js";

export interface SasBindingPolicy { namespace: string; workload: string; container: string; imageRepository: string }
export interface ArtifactResult { status: VerificationStatus; reason: string }
export interface SasKubernetesReport {
  mode: "sas";
  localPolicy: SasBindingPolicy;
  sas: SasApproval;
  kubernetes: KubernetesVerification | null;
  artifact: ArtifactResult & { perPod: { pod: string; result: ArtifactResult }[] };
  result: ArtifactResult;
}

/** This MVP intentionally binds only the existing real demo-api attestation. */
export function validateSasBindingPolicy(policy: SasBindingPolicy): void {
  if (policy.namespace !== demoApiTarget.namespace || policy.workload !== demoApiTarget.deployment ||
      policy.container !== demoApiTarget.container || policy.imageRepository !== demoApiIdentity.imageRepository) {
    throw new VerificationDiagnosticError("SAS_BINDING_UNSUPPORTED");
  }
}

/** Only canonical, registry-qualified repository@sha256 manifest references are supported.
 * The runtime's reported semantics are trusted; arbitrary CRI prefixes/config IDs are never normalized.
 */
export function verifyManifestEvidence(approvedReference: string, observation: ObservedRuntimeIdentity): ArtifactResult {
  const runtime = observation.runtimeImageID;
  if (!runtime || !/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/.test(runtime)) {
    return { status: "INDETERMINATE", reason: "Runtime imageID is missing or is not a supported canonical OCI manifest reference." };
  }
  if (!observation.ready) return { status: "INDETERMINATE", reason: "Container is not ready; artifact identity is not verified." };
  if (runtime !== approvedReference) return { status: "TRUST_BROKEN", reason: "Reported runtime manifest reference differs from the SAS-approved image binding." };
  return { status: "VERIFIED", reason: "Runtime reports the manifest reference approved by SAS and local image-repository policy." };
}

/** Kubernetes construction is deferred until a valid, unexpired SAS approval exists. */
export async function verifySasKubernetesDeployment(
  sasReader: SasAccountReader, kubernetesReader: () => KubernetesReader | Promise<KubernetesReader>, policy: SasBindingPolicy, clock: () => number = Date.now,
): Promise<SasKubernetesReport> {
  validateSasBindingPolicy(policy);
  const sas = await readDemoApiApproval(sasReader, clock());
  const report: SasKubernetesReport = { mode: "sas", localPolicy: { ...policy }, sas, kubernetes: null,
    artifact: { status: "INDETERMINATE", reason: "No validated SAS approval; runtime was not read.", perPod: [] },
    result: { status: "INDETERMINATE", reason: sas.reason } };
  if (sas.status !== "VERIFIED" || !sas.payload) return report;
  const approved = { namespace: policy.namespace, workload: policy.workload, container: policy.container,
    imageReference: `${policy.imageRepository}@${sas.payload.artifactDigest}` };
  const reader = await atDiagnosticStage("KUBERNETES_CLIENT", kubernetesReader);
  const kubernetes = await verifyKubernetesDeployment(reader, approved);
  report.kubernetes = kubernetes;
  const perPod = kubernetes.observations.map(observation => ({ pod: observation.pod, result: verifyManifestEvidence(approved.imageReference, observation) }));
  const incomplete = kubernetes.collectionIssues.length > 0 || kubernetes.result.status === "INDETERMINATE" ||
    !perPod.length || perPod.some(pod => pod.result.status === "INDETERMINATE");
  const artifact: ArtifactResult = incomplete
    ? { status: "INDETERMINATE", reason: "Runtime evidence is missing, unsupported, unready, or collection/rollout is ambiguous." }
    : perPod.some(pod => pod.result.status === "TRUST_BROKEN")
      ? { status: "TRUST_BROKEN", reason: "Runtime manifest evidence differs from the approved image binding." }
      : { status: "VERIFIED", reason: "All selected ready Pods report the approved immutable manifest reference." };
  report.artifact = { ...artifact, perPod };
  // Promote only an unambiguous, complete, ready configuration mismatch. The
  // baseline validator must report solely IMAGE_REFERENCE_MISMATCH for every
  // selected Pod: missing/malformed runtime fields and readiness remain blockers.
  // Unsupported OCI identity formats can still accompany reliable spec evidence.
  const reliableConfigurationMismatch = kubernetes.collectionIssues.length === 0 &&
    kubernetes.result.status === "TRUST_BROKEN" && kubernetes.perPod.length > 0 &&
    kubernetes.perPod.every(pod => pod.observation.ready && pod.result.status === "TRUST_BROKEN" &&
      pod.result.reasons.length > 0 && pod.result.reasons.every(reason => reason.code === "IMAGE_REFERENCE_MISMATCH"));
  report.result = reliableConfigurationMismatch
    ? { status: "TRUST_BROKEN", reason: "Ready Pods unambiguously configure an image different from the SAS-approved binding." }
    : incomplete ? artifact
    : kubernetes.result.status === "TRUST_BROKEN" ? { status: "TRUST_BROKEN", reason: "Pod image configuration differs from the SAS-approved binding." }
      : artifact;
  if (BigInt(sas.expiry!) <= BigInt(Math.floor(clock() / 1000))) {
    report.sas = { ...sas, status: "INDETERMINATE", reason: "Attestation expired during runtime collection.", diagnostic: diagnostic("SAS_APPROVAL_EXPIRED") };
    report.result = { status: "INDETERMINATE", reason: report.sas.reason };
  }
  return report;
}
