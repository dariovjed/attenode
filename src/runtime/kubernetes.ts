import type { V1Deployment, V1ReplicaSet, V1Pod, V1ObjectMeta, V1OwnerReference } from "@kubernetes/client-node";
import { verifyRuntimeIdentity, type ApprovedDeploymentIdentity, type ObservedRuntimeIdentity, type RuntimeVerificationResult } from "./verification.js";

export interface KubernetesReader {
  deployment(namespace: string, name: string): Promise<V1Deployment>;
  replicaSets(namespace: string): Promise<V1ReplicaSet[]>;
  pods(namespace: string): Promise<V1Pod[]>;
}
export interface KubernetesVerification {
  approved: ApprovedDeploymentIdentity;
  observations: ObservedRuntimeIdentity[];
  perPod: { observation: ObservedRuntimeIdentity; result: RuntimeVerificationResult }[];
  collectionIssues: string[];
  result: RuntimeVerificationResult;
}
function controller(meta?: V1ObjectMeta): V1OwnerReference | undefined {
  const owners = meta?.ownerReferences;
  if (!Array.isArray(owners)) return undefined;
  const controllers = owners.filter(owner => owner.controller === true);
  if (controllers.length !== 1) return undefined;
  const owner = controllers[0]!;
  return owner.name && owner.uid && owner.kind && owner.apiVersion ? owner : undefined;
}
function validMeta(meta: V1ObjectMeta | undefined, namespace: string): boolean {
  return !!meta?.uid && !!meta.name && meta.namespace === namespace;
}

/** Only GET/list dependencies are exposed; no credentials or client globals here. */
export async function verifyKubernetesDeployment(reader: KubernetesReader, approved: ApprovedDeploymentIdentity): Promise<KubernetesVerification> {
  const observations: ObservedRuntimeIdentity[] = [], collectionIssues: string[] = [];
  try {
    const deployment = await reader.deployment(approved.namespace, approved.workload);
    if (!validMeta(deployment.metadata, approved.namespace) || deployment.metadata?.name !== approved.workload || deployment.metadata.deletionTimestamp) {
      throw new Error("invalid deployment");
    }
    const replicaSets = await reader.replicaSets(approved.namespace);
    const owned = new Map<string, V1ReplicaSet>();
    for (const rs of replicaSets) {
      const owner = controller(rs.metadata);
      if (!owner) { collectionIssues.push("ReplicaSet ownership is missing or ambiguous."); continue; }
      if (owner.uid !== deployment.metadata.uid) {
        if (owner.kind === "Deployment" && owner.name === approved.workload) collectionIssues.push("ReplicaSet references a different UID for the target Deployment.");
        continue;
      }
      if (owner.kind !== "Deployment" || owner.apiVersion !== "apps/v1" || owner.name !== approved.workload || !validMeta(rs.metadata, approved.namespace) || owned.has(rs.metadata!.uid!)) {
        collectionIssues.push("Target ReplicaSet metadata or ownership is malformed."); continue;
      }
      owned.set(rs.metadata!.uid!, rs);
    }
    const pods = await reader.pods(approved.namespace);
    const seen = new Set<string>();
    for (const pod of pods) {
      const owner = controller(pod.metadata);
      if (!owner) { collectionIssues.push("Pod ownership is missing or ambiguous."); continue; }
      const rs = owned.get(owner.uid);
      if (!rs) {
        if (owner.kind === "ReplicaSet" && !replicaSets.some(candidate => candidate.metadata?.uid === owner.uid && candidate.metadata?.name === owner.name && controller(candidate.metadata))) {
          collectionIssues.push("Pod references an unresolved ReplicaSet owner.");
        }
        if (owner.kind === "ReplicaSet" && [...owned.values()].some(r => r.metadata?.name === owner.name)) collectionIssues.push("Pod references a different UID for a target ReplicaSet.");
        continue;
      }
      if (owner.kind !== "ReplicaSet" || owner.apiVersion !== "apps/v1" || owner.name !== rs.metadata?.name || !validMeta(pod.metadata, approved.namespace) || seen.has(pod.metadata!.uid!)) {
        collectionIssues.push("Target Pod metadata or ownership is malformed."); continue;
      }
      seen.add(pod.metadata!.uid!);
      const containers = pod.spec?.containers?.filter(c => c.name === approved.container) ?? [];
      const statuses = pod.status?.containerStatuses?.filter(c => c.name === approved.container) ?? [];
      if (containers.length !== 1 || statuses.length > 1) {
        collectionIssues.push("Target container spec or status selection is missing or ambiguous."); continue;
      }
      const status = statuses[0];
      observations.push({ namespace: approved.namespace, workload: approved.workload, pod: pod.metadata!.name!, container: approved.container,
        imageReference: containers[0]!.image ?? "", runtimeImageID: status?.imageID ?? null,
        ready: status?.ready === true && !!status.state?.running && pod.status?.phase === "Running" && !pod.metadata?.deletionTimestamp &&
          pod.status.conditions?.some(c => c.type === "Ready" && c.status === "True") === true });
    }
    // Detect Deployment recreation/configuration changes during the read sequence.
    const after = await reader.deployment(approved.namespace, approved.workload);
    if (after.metadata?.uid !== deployment.metadata.uid || after.metadata?.resourceVersion !== deployment.metadata.resourceVersion) {
      collectionIssues.push("Deployment changed during collection; retry with a fresh snapshot.");
    }
  } catch {
    // Avoid exposing API exception bodies or credential-bearing client context.
    collectionIssues.push("Kubernetes read failed or returned an invalid target Deployment.");
  }
  const perPod = observations.map(observation => ({ observation, result: verifyRuntimeIdentity(approved, observation) }));
  const identities = new Set(observations.map(o => JSON.stringify([o.imageReference, o.runtimeImageID, o.ready])));
  let result: RuntimeVerificationResult;
  if (collectionIssues.length || identities.size > 1) {
    if (identities.size > 1) collectionIssues.push("Pod runtime observations disagree during rollout or drift.");
    result = verifyRuntimeIdentity(approved, observations); // existing ambiguity rule
  } else if (!perPod.length) result = verifyRuntimeIdentity(approved, null);
  else result = perPod[0]!.result; // every replica has identical comparison inputs
  return { approved, observations, perPod, collectionIssues, result };
}
export function verificationExitCode(result: RuntimeVerificationResult): number {
  return result.status === "VERIFIED" ? 0 : result.status === "TRUST_BROKEN" ? 2 : 3;
}
