import { validateSasBindingPolicy, type SasBindingPolicy } from "../../src/runtime/sas-verification.js";

export interface MonitorConfig {
  kubeconfig: string;
  context: string;
  policy: SasBindingPolicy;
  port: number;
  allowedOrigin: string;
  sasMaxAgeMs: number;
}
export function readMonitorConfig(env: NodeJS.ProcessEnv): MonitorConfig {
  const required = (key: string): string => {
    const value = env[key];
    if (!value?.trim() || value !== value.trim()) throw new Error("Invalid monitor configuration");
    return value;
  };
  const policy = { namespace: required("ATTENODE_NAMESPACE"), workload: required("ATTENODE_DEPLOYMENT"),
    container: required("ATTENODE_CONTAINER"), imageRepository: required("ATTENODE_IMAGE_REPOSITORY") };
  validateSasBindingPolicy(policy);
  const portText = env.ATTENODE_MONITOR_PORT ?? "3001";
  if (!/^\d+$/.test(portText)) throw new Error("Invalid monitor port");
  const port = Number(portText);
  if (port < 1 || port > 65535) throw new Error("Invalid monitor port");
  const allowedOrigin = env.ATTENODE_MONITOR_ORIGIN ?? "http://127.0.0.1:5173";
  const url = new URL(allowedOrigin);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.origin !== allowedOrigin || url.username || url.password) throw new Error("Invalid monitor origin");
  const ageText = env.ATTENODE_SAS_MAX_AGE_MS ?? "120000";
  if (!/^\d+$/.test(ageText) || Number(ageText) < 1000 || Number(ageText) > 3600000) throw new Error("Invalid SAS freshness window");
  return { kubeconfig: required("ATTENODE_KUBECONFIG"), context: required("ATTENODE_CONTEXT"), policy, port, allowedOrigin, sasMaxAgeMs: Number(ageText) };
}
