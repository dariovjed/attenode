import { atDiagnosticStage, diagnostic, safeDiagnostic, VerificationDiagnosticError, type SafeDiagnostic, type DiagnosticStage } from "../../src/runtime/diagnostics.js";
import { readDemoApiApproval, type SasApproval } from "../../src/attestations/sas-approval.js";
import { approvedIdentityFromSas, composeSasKubernetesReport, sasApprovalHasExpired, type SasKubernetesReport } from "../../src/runtime/sas-verification.js";
import { collectKubernetesEvidence, compareKubernetesEvidence, type KubernetesEvidence } from "../../src/runtime/kubernetes.js";
import type { VerificationCliDependencies } from "../../src/runtime/verification-cli.js";
import type { VerificationStatus } from "../../src/runtime/verification.js";
import type { MonitorConfig } from "./config.js";

export const intervalMs = 5_000;
export const sasIntervalMs = 60_000;
export const freshnessMs = 15_000;
type MonitorDiagnostic = SafeDiagnostic | { stage: "MONITOR"; code: "MONITOR_PENDING" | "MONITOR_STALE" | "MONITOR_TIMEOUT"; explanation: string };
export interface MonitorSources {
  sas(): Promise<SasApproval>;
  kubernetes(): Promise<KubernetesEvidence>;
}
export function monitorVerifier(config: MonitorConfig, dependencies: VerificationCliDependencies): MonitorSources {
  return {
    async sas() {
      const reader = await atDiagnosticStage("SAS_RPC", () => dependencies.sasReader());
      return readDemoApiApproval(reader, Date.now());
    },
    async kubernetes() {
      const reader = await atDiagnosticStage("KUBERNETES_CLIENT", () => dependencies.kubernetesReader(config.kubeconfig, config.context));
      const evidence = await collectKubernetesEvidence(reader, config.policy);
      const failure = evidence.diagnostics?.[0];
      if (failure) throw new VerificationDiagnosticError(failure.code, failure);
      return evidence;
    },
  };
}

interface SourceFreshness {
  checkedAt: string | null;
  lastAttemptAt: string | null;
  completedAt: string | null;
  ageMs: number | null;
  maxAgeMs: number;
  fresh: boolean;
  inFlight: boolean;
  timedOut: boolean;
  diagnostic: MonitorDiagnostic | null;
}
export interface MonitorSnapshot {
  status: VerificationStatus;
  timestamp: string;
  inFlight: boolean;
  freshness: { evidenceCurrent: boolean; sas: SourceFreshness; kubernetes: SourceFreshness };
  diagnostic: MonitorDiagnostic | null;
  report: SasKubernetesReport | null;
  lastObtainedReport: { timestamp: string; report: SasKubernetesReport; diagnosticOnly: true } | null;
}
export interface MonitorEvent { id: number; type: "evidence" | "transition"; snapshot: MonitorSnapshot }
export interface Transition { id: number; timestamp: string; from: VerificationStatus; to: VerificationStatus; diagnostic: MonitorDiagnostic | null }

/** Owns the transport promise until settlement. A timeout releases the caller,
 * not the single-flight lock. Late values/errors are consumed but never applied.
 */
class Source<T> {
  value: T | null = null;
  checked: number | null = null;
  attempted: number | null = null;
  completed: number | null = null;
  error: MonitorDiagnostic | null = null;
  active = false;
  timedOut = false;
  private timer?: ReturnType<typeof setTimeout>;
  private release?: () => void;
  private discarded = false;
  constructor(private operation: () => Promise<T>, private stage: DiagnosticStage,
    private clock: () => number, private updated: () => void, private keepOnFailure: (error: MonitorDiagnostic) => boolean,
    private invalidation: (value: T) => SafeDiagnostic | null = () => null) {}
  run(): Promise<void> {
    if (this.active) return Promise.resolve();
    this.active = true; this.timedOut = false; this.discarded = false;
    const started = this.clock(); this.attempted = started;
    return new Promise(resolve => {
      this.release = resolve;
      this.timer = setTimeout(() => {
        this.timedOut = true; this.discarded = true;
        this.error = { stage: "MONITOR", code: "MONITOR_TIMEOUT", explanation: "Source timed out; its transport remains single-flight until settlement. Late evidence is discarded." };
        if (!this.keepOnFailure(this.error)) this.value = null;
        this.updated(); resolve();
      }, freshnessMs);
      const finish = () => {
        clearTimeout(this.timer); this.active = false; this.completed = this.clock();
        this.release = undefined; this.updated(); resolve();
      };
      // Both continuations are attached immediately, including to rejected transports.
      Promise.resolve().then(this.operation).then(value => {
        const rejected = this.invalidation(value);
        if (rejected) {
          // Negative evidence always invalidates cached approval, even if it arrives
          // after a timeout. A late positive response can never restore approval.
          this.value = null; this.error = rejected;
        } else if (!this.discarded && this.clock() - started < freshnessMs) {
          this.value = value; this.checked = started; this.error = null;
        } else if (!this.discarded) {
          this.timedOut = true;
          this.error = { stage: "MONITOR", code: "MONITOR_TIMEOUT", explanation: "Source exceeded its time budget; late evidence was discarded." };
          if (!this.keepOnFailure(this.error)) this.value = null;
        }
        finish();
      }, error => {
        const safe = safeDiagnostic(error, this.stage);
        if (!this.discarded) {
          this.error = safe;
          if (!this.keepOnFailure(this.error)) this.value = null;
        } else if (!this.keepOnFailure(safe)) {
          this.value = null; this.error = safe;
        }
        finish();
      });
    });
  }
  stop() {
    this.discarded = true; clearTimeout(this.timer); this.release?.();
    // The lock stays held until the non-cancellable transport finishes.
  }
  freshness(maxAgeMs: number): SourceFreshness {
    const ageMs = this.checked === null ? null : Math.max(0, this.clock() - this.checked);
    const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
    return { checkedAt: iso(this.checked), lastAttemptAt: iso(this.attempted), completedAt: iso(this.completed), ageMs, maxAgeMs,
      fresh: this.value !== null && ageMs !== null && ageMs < maxAgeMs, inFlight: this.active, timedOut: this.timedOut, diagnostic: this.error };
  }
}
// Ambiguous account-fetch failures are availability failures, not proof of rate limiting.
// Decode/address/init errors and explicit validation rejection never permit cached reuse.
const availableFailure = (error: MonitorDiagnostic) => ["MONITOR_TIMEOUT", "SAS_RPC_ACCOUNT_FETCH_FAILED", "SAS_RPC_FAILED",
  "SAS_RPC_TIMEOUT", "SAS_RPC_UNREACHABLE", "SAS_RPC_RATE_LIMITED", "SAS_RPC_CONNECTION_RESET", "SAS_RPC_HTTP_UNAVAILABLE"].includes(error.code);

export class TrustMonitor {
  private sas: Source<SasApproval>;
  private kube: Source<KubernetesEvidence>;
  private retained: MonitorSnapshot["lastObtainedReport"] = null;
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  private listeners = new Set<(event: MonitorEvent) => void>();
  private sequence = 0;
  private publishedStatus: VerificationStatus = "INDETERMINATE";
  private transitions: Transition[] = [];
  constructor(private readonly sources: MonitorSources, private readonly config: MonitorConfig, private readonly clock = Date.now) {
    this.sas = new Source(sources.sas, "SAS_RPC", clock, () => this.publish(), availableFailure,
      value => value.status !== "VERIFIED" ? value.diagnostic ?? diagnostic("SAS_ACCOUNT_VALIDATION_FAILED") : null);
    this.kube = new Source(sources.kubernetes, "KUBERNETES_OBSERVATION", clock, () => this.publish(), () => false);
  }
  snapshot(): MonitorSnapshot {
    const now = this.clock(), sasFresh = this.sas.freshness(this.config.sasMaxAgeMs), kubeFresh = this.kube.freshness(freshnessMs);
    const approval = this.sas.value;
    const expired = approval !== null && sasApprovalHasExpired(approval, now);
    sasFresh.fresh = sasFresh.fresh && approval?.status === "VERIFIED" && !!approval.payload && !expired;
    const policyDiagnostic: MonitorDiagnostic = { stage: "MONITOR", code: approval ? "MONITOR_STALE" : "MONITOR_PENDING",
      explanation: approval ? "SAS or Kubernetes evidence is outside its allowed freshness window." : "No current validated SAS evidence is available." };
    const sasDiagnostic = expired ? diagnostic("SAS_APPROVAL_EXPIRED") : approval?.status === "INDETERMINATE" ? approval.diagnostic ?? policyDiagnostic
      : this.sas.error ?? (!sasFresh.fresh ? policyDiagnostic : null);
    const kubeDiagnostic = this.kube.error ?? (!kubeFresh.fresh ? policyDiagnostic : null);
    let report: SasKubernetesReport | null = null;
    if (sasFresh.fresh && kubeFresh.fresh && approval && this.kube.value) {
      const approved = approvedIdentityFromSas(approval, this.config.policy)!;
      const comparison = compareKubernetesEvidence(this.kube.value, approved);
      report = composeSasKubernetesReport(approval, comparison, this.config.policy, now);
    }
    const current = !!report && report.result.status !== "INDETERMINATE";
    return { status: report?.result.status ?? "INDETERMINATE", timestamp: new Date(now).toISOString(),
      inFlight: this.sas.active || this.kube.active,
      freshness: { evidenceCurrent: current, sas: { ...sasFresh, diagnostic: sasDiagnostic }, kubernetes: { ...kubeFresh, diagnostic: kubeDiagnostic } },
      diagnostic: sasDiagnostic ?? kubeDiagnostic ?? report?.kubernetes?.diagnostics?.[0] ?? null,
      report, lastObtainedReport: this.retained };
  }
  subscribe(listener: (event: MonitorEvent) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  history(): Transition[] { return structuredClone(this.transitions); }
  private publish(): void {
    const snapshot = this.snapshot();
    if (snapshot.report) {
      const evidenceAt = Math.max(this.sas.checked!, this.kube.checked!);
      this.retained = { timestamp: new Date(evidenceAt).toISOString(), report: snapshot.report, diagnosticOnly: true };
      snapshot.lastObtainedReport = this.retained;
    }
    const deliver = (type: MonitorEvent["type"]) => {
      const event = { id: ++this.sequence, type, snapshot };
      for (const listener of this.listeners) { try { listener(event); } catch { this.listeners.delete(listener); } }
      return event.id;
    };
    if (snapshot.status !== this.publishedStatus) {
      const from = this.publishedStatus; this.publishedStatus = snapshot.status;
      const id = ++this.sequence;
      this.transitions.push({ id, timestamp: snapshot.timestamp, from, to: snapshot.status, diagnostic: snapshot.diagnostic });
      if (this.transitions.length > 100) this.transitions.shift();
      for (const listener of this.listeners) { try { listener({ id, type: "transition", snapshot }); } catch { this.listeners.delete(listener); } }
    }
    deliver("evidence");
  }
  async tick(): Promise<void> {
    const dueSas = this.sas.attempted === null || this.clock() - this.sas.attempted >= sasIntervalMs;
    await Promise.all([dueSas ? this.sas.run() : Promise.resolve(), this.kube.run()]);
    this.publish();
  }
  start(): void {
    if (this.running) return;
    this.running = true; void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
  }
  stop(): void {
    this.running = false; clearInterval(this.timer); this.sas.stop(); this.kube.stop();
  }
  health() {
    const snapshot = this.snapshot();
    return { operational: this.running, state: !this.running ? "STOPPED" : snapshot.diagnostic || !snapshot.freshness.evidenceCurrent ? "DEGRADED" : "MONITORING",
      inFlight: snapshot.inFlight, verificationStatus: snapshot.status, freshness: snapshot.freshness, diagnostic: snapshot.diagnostic };
  }
}
