import type { SasAccountReader } from "../../src/attestations/sas-reader.js";
import { readDemoApiApproval } from "../../src/attestations/sas-approval.js";
import { safeDiagnostic } from "../../src/runtime/diagnostics.js";
import type { MonitorSources } from "./monitor.js";

export type Phase = "PLAIN_FRESH_BEFORE_K8S" | "PLAIN_REUSED_BEFORE_K8S" | "RETRY_FRESH_BEFORE_K8S" |
  "PLAIN_CONCURRENT_K8S" | "PLAIN_FRESH_AFTER_K8S" | "RETRY_CONCURRENT_K8S" | "PLAIN_REUSED_AFTER_K8S" |
  "FIXED_AFTER_K8S" | "FIXED_CONCURRENT_K8S";
export interface ComparisonRecord {
  diagnostic: "MONITOR_SAS_COMPARISON";
  phase: Phase | "SCHEDULED";
  source: "SAS" | "KUBERNETES";
  outcome: "VALIDATED" | "REJECTED" | "COMPLETED" | "FAILED" | "STILL_PENDING";
  durationMs: number;
  code?: string;
  stage?: string;
  operation?: string;
  accountKind?: string;
}
export type DiagnosticSink = (record: ComparisonRecord) => void;

/** Console-only, no raw errors or evidence. Pending operations remain owned;
 * the watchdog reports a stall but never launches overlapping comparison phases.
 */
async function measured<T>(phase: ComparisonRecord["phase"], source: ComparisonRecord["source"], operation: () => Promise<T>,
  sink: DiagnosticSink, outcome: (value: T) => ComparisonRecord["outcome"]): Promise<T> {
  const start = performance.now();
  const emit = (record: Omit<ComparisonRecord, "diagnostic" | "phase" | "source" | "durationMs">) => {
    try { sink({ diagnostic: "MONITOR_SAS_COMPARISON", phase, source, durationMs: Math.round(performance.now() - start), ...record }); }
    catch { /* Logging must not alter verification. */ }
  };
  const watchdog = setTimeout(() => emit({ outcome: "STILL_PENDING" }), 15_000);
  try {
    const value = await operation();
    const result = outcome(value);
    emit({ outcome: result, ...(result === "REJECTED" ? { code: "SAS_ACCOUNT_VALIDATION_REJECTED" } : {}) });
    return value;
  } catch (error) {
    const safe = safeDiagnostic(error, source === "SAS" ? "SAS_RPC" : "KUBERNETES_OBSERVATION");
    emit({ outcome: "FAILED", code: safe.code, stage: safe.stage, ...(safe.operation ? { operation: safe.operation } : {}),
      ...(safe.accountKind ? { accountKind: safe.accountKind } : {}) });
    throw error;
  } finally { clearTimeout(watchdog); }
}

export interface ComparisonDependencies {
  plainReader(): SasAccountReader;
  retryReader(): SasAccountReader;
  fixedReader?(): SasAccountReader;
  kubernetes: MonitorSources["kubernetes"];
  verify?: typeof readDemoApiApproval;
}
/** Only invoked before periodic polling starts. Results never seed monitor evidence. */
export async function runMonitorSasComparison(dependencies: ComparisonDependencies, sink: DiagnosticSink): Promise<void> {
  let reused: SasAccountReader | undefined;
  const verify = dependencies.verify ?? readDemoApiApproval;
  const run = (phase: Phase, factory: () => SasAccountReader) => measured(phase, "SAS",
    async () => verify(factory(), Date.now()), sink, value => value.status === "VERIFIED" ? "VALIDATED" : "REJECTED");
  const settle = async (operation: () => Promise<unknown>) => { try { await operation(); } catch { /* recorded safely above */ } };
  await settle(() => run("PLAIN_FRESH_BEFORE_K8S", () => { reused = dependencies.plainReader(); return reused; }));
  await settle(() => run("PLAIN_REUSED_BEFORE_K8S", () => reused ?? dependencies.plainReader()));
  await settle(() => run("RETRY_FRESH_BEFORE_K8S", dependencies.retryReader));
  await Promise.allSettled([
    run("PLAIN_CONCURRENT_K8S", dependencies.plainReader),
    measured("PLAIN_CONCURRENT_K8S", "KUBERNETES", dependencies.kubernetes, sink, () => "COMPLETED"),
  ]);
  await settle(() => run("PLAIN_FRESH_AFTER_K8S", dependencies.plainReader));
  await Promise.allSettled([
    run("RETRY_CONCURRENT_K8S", dependencies.retryReader),
    measured("RETRY_CONCURRENT_K8S", "KUBERNETES", dependencies.kubernetes, sink, () => "COMPLETED"),
  ]);
  await settle(() => run("PLAIN_REUSED_AFTER_K8S", () => reused ?? dependencies.plainReader()));
  if (dependencies.fixedReader) {
    await settle(() => run("FIXED_AFTER_K8S", dependencies.fixedReader!));
    await Promise.allSettled([
      run("FIXED_CONCURRENT_K8S", dependencies.fixedReader),
      measured("FIXED_CONCURRENT_K8S", "KUBERNETES", dependencies.kubernetes, sink, () => "COMPLETED"),
    ]);
  }
}

/** Observes real scheduled source calls without extra reads or altering results/errors. */
export function traceScheduledSources(sources: MonitorSources, sink: DiagnosticSink): MonitorSources {
  return {
    sas: () => measured("SCHEDULED", "SAS", sources.sas, sink, value => value.status === "VERIFIED" ? "VALIDATED" : "REJECTED"),
    kubernetes: () => measured("SCHEDULED", "KUBERNETES", sources.kubernetes, sink, () => "COMPLETED"),
  };
}
