import type { KubernetesReader } from "./kubernetes.js";

type KubernetesClientModule = {
  createKubernetesReader(kubeconfig: string, context?: string): KubernetesReader;
};

/** Import and construction both occur only when the verifier invokes this factory.
 * The importer is injectable for offline tests; production always uses the local adapter.
 * Failures propagate to the existing KUBERNETES_CLIENT diagnostic boundary.
 */
export async function createLazyKubernetesReader(
  kubeconfig: string,
  context?: string,
  importer: () => Promise<KubernetesClientModule> = () => import("./kubernetes-client.js"),
): Promise<KubernetesReader> {
  const client = await importer();
  return client.createKubernetesReader(kubeconfig, context);
}
