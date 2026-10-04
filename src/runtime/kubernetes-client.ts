import { KubeConfig, AppsV1Api, CoreV1Api } from "@kubernetes/client-node";
import type { KubernetesReader } from "./kubernetes.js";

/** Called only at CLI runtime with an explicit file and optional explicit context. */
export function createKubernetesReader(kubeconfig: string, context?: string): KubernetesReader {
  const config = new KubeConfig();
  config.loadFromFile(kubeconfig);
  // Changes only this in-memory instance; never writes the kubeconfig file.
  if (context) config.setCurrentContext(context);
  const selected = config.getCurrentContext();
  if (!selected || !config.getContextObject(selected) || !config.getCurrentCluster()) throw new Error("Invalid Kubernetes context");
  const apps = config.makeApiClient(AppsV1Api), core = config.makeApiClient(CoreV1Api);
  return {
    deployment: (namespace, name) => apps.readNamespacedDeployment({ namespace, name }),
    async replicaSets(namespace) {
      const items = []; let continuation: string | undefined;
      do {
        const page = await apps.listNamespacedReplicaSet({ namespace, limit: 500, _continue: continuation });
        items.push(...page.items); continuation = page.metadata?._continue || undefined;
      } while (continuation);
      return items;
    },
    async pods(namespace) {
      const items = []; let continuation: string | undefined;
      do {
        const page = await core.listNamespacedPod({ namespace, limit: 500, _continue: continuation });
        items.push(...page.items); continuation = page.metadata?._continue || undefined;
      } while (continuation);
      return items;
    },
  };
}
