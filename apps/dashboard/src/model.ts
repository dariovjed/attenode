import type { MonitorSnapshot, Transition, TrustMonitor } from "../../monitor/monitor.js";

export type { MonitorSnapshot, Transition };
export type Health = ReturnType<TrustMonitor["health"]>;
export type Connection = "connecting" | "live" | "reconnecting";
export interface DashboardState {
  snapshot: MonitorSnapshot | null;
  receivedAt: number;
  connection: Connection;
  health: Health | null;
  healthAt: number;
  history: Transition[];
  errors: { status?: string; health?: string; history?: string };
}
export const initialState = (): DashboardState => ({ snapshot: null, receivedAt: 0, connection: "connecting", health: null,
  healthAt: 0, history: [], errors: {} });
const statuses = new Set(["VERIFIED", "TRUST_BROKEN", "INDETERMINATE"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const validDiagnostic = (value: unknown) => value === null || value === undefined ||
  (object(value) && typeof value.stage === "string" && typeof value.code === "string" && typeof value.explanation === "string");
export function parseSnapshot(value: unknown): MonitorSnapshot {
  if (!object(value) || !statuses.has(value.status as string) || typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp)) || !object(value.freshness)) throw new Error("Invalid snapshot");
  for (const key of ["sas", "kubernetes"]) {
    const source = value.freshness[key];
    if (!object(source) || typeof source.fresh !== "boolean" || typeof source.maxAgeMs !== "number" || !Number.isFinite(source.maxAgeMs) || source.maxAgeMs <= 0 ||
      (source.ageMs !== null && (typeof source.ageMs !== "number" || !Number.isFinite(source.ageMs) || source.ageMs < 0)) ||
      (source.checkedAt !== null && (typeof source.checkedAt !== "string" || !Number.isFinite(Date.parse(source.checkedAt))))) throw new Error("Invalid freshness");
    if (!validDiagnostic(source.diagnostic)) throw new Error("Invalid diagnostic");
  }
  if (typeof value.freshness.evidenceCurrent !== "boolean") throw new Error("Invalid evidence");
  if (value.report !== null && (!object(value.report) || !object(value.report.result) || !statuses.has(value.report.result.status as string) ||
    !object(value.report.sas) || !object(value.report.localPolicy) || !object(value.report.artifact) ||
    (value.report.kubernetes !== null && (!object(value.report.kubernetes) || !Array.isArray(value.report.kubernetes.observations))))) throw new Error("Invalid report");
  if (object(value.report)) {
    const report = value.report;
    const sas = report.sas as Record<string, unknown>;
    for (const key of ["attestation", "issuer", "credential", "schema", "expiry"]) {
      if (sas[key] !== undefined && typeof sas[key] !== "string") throw new Error("Invalid SAS fields");
    }
    if (!statuses.has(sas.status as string) || !object(report.artifact) || !statuses.has(report.artifact.status as string) ||
      typeof report.artifact.reason !== "string") throw new Error("Invalid source status");
    if (sas.payload !== undefined && (!object(sas.payload) || Object.values(sas.payload).some(field => typeof field !== "string"))) throw new Error("Invalid payload");
    if (Object.values(report.localPolicy as object).some(field => typeof field !== "string")) throw new Error("Invalid policy");
    if (object(report.kubernetes)) {
      const kube = report.kubernetes;
      if (!object(kube.result) || !statuses.has(kube.result.status as string) || !Array.isArray(kube.perPod) || !Array.isArray(kube.collectionIssues) ||
        kube.collectionIssues.some(field => typeof field !== "string") || (kube.observations as unknown[]).some(pod => !object(pod) ||
          typeof pod.pod !== "string" || typeof pod.container !== "string" || typeof pod.imageReference !== "string" ||
          typeof pod.ready !== "boolean" || (pod.runtimeImageID !== null && typeof pod.runtimeImageID !== "string")) ||
        kube.perPod.some(entry => !object(entry) || !object(entry.observation) || !object(entry.result) || !Array.isArray(entry.result.reasons) ||
          entry.result.reasons.some(reason => !object(reason) || typeof reason.code !== "string" || typeof reason.message !== "string"))) throw new Error("Invalid observation");
    }
  }
  return value as unknown as MonitorSnapshot;
}
export function parseHistory(value: unknown): Transition[] {
  if (!Array.isArray(value) || value.some(row => !object(row) || !Number.isSafeInteger(row.id) ||
    typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp)) || !statuses.has(row.from as string) || !statuses.has(row.to as string) || !validDiagnostic(row.diagnostic))) throw new Error("Invalid history");
  return [...new Map((value as Transition[]).map(row => [row.id, row])).values()].sort((a, b) => a.id - b.id).slice(-100);
}
export function sourceFresh(snapshot: MonitorSnapshot, source: "sas" | "kubernetes", receivedAt: number, now: number): boolean {
  const value = snapshot.freshness[source];
  const elapsed = Math.max(0, now - receivedAt);
  if (source === "sas" && snapshot.report?.sas.expiry && Number(snapshot.report.sas.expiry) * 1000 <= Date.parse(snapshot.timestamp) + elapsed) return false;
  return value.fresh && value.checkedAt !== null && value.ageMs !== null && value.ageMs + elapsed < value.maxAgeMs;
}
export function currentReport(state: DashboardState, now: number) {
  const snapshot = state.snapshot;
  if (!snapshot || state.connection !== "live" || !snapshot.report || !sourceFresh(snapshot, "sas", state.receivedAt, now) ||
    !sourceFresh(snapshot, "kubernetes", state.receivedAt, now)) return null;
  // Fail-closed presentation only; the browser does not validate or approve an artifact.
  if (snapshot.report.sas.status !== "VERIFIED" || !snapshot.report.sas.payload || !snapshot.report.sas.expiry) return null;
  const expiry = Number(snapshot.report.sas.expiry) * 1000;
  const evidenceClock = Date.parse(snapshot.timestamp) + Math.max(0, now - state.receivedAt);
  if (!Number.isFinite(expiry) || !Number.isFinite(new Date(expiry).getTime()) || !Number.isFinite(evidenceClock) || expiry <= evidenceClock) return null;
  return snapshot.report;
}
export function trustLabel(state: DashboardState, now: number): string {
  if (!state.snapshot) return state.errors.status || state.connection === "reconnecting" ? "UNAVAILABLE" : "LOADING";
  if (state.connection !== "live") return "UNAVAILABLE";
  if (state.snapshot.status === "INDETERMINATE") return "INDETERMINATE";
  const report = currentReport(state, now);
  return report && state.snapshot.freshness.evidenceCurrent && report.result.status === state.snapshot.status ? state.snapshot.status : "STALE";
}
export function explorer(address: string | undefined): string | null {
  return address && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=devnet` : null;
}
