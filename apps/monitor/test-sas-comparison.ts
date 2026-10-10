import assert from "node:assert/strict";
import { mock } from "node:test";
import type { SasAccountReader } from "../../src/attestations/sas-reader.js";
import type { SasApproval } from "../../src/attestations/sas-approval.js";
import { VerificationDiagnosticError } from "../../src/runtime/diagnostics.js";
import { runMonitorSasComparison, traceScheduledSources, type ComparisonRecord } from "./sas-comparison.js";

const records: ComparisonRecord[] = [];
const secret = "SYNTHETIC_COMPARISON_SECRET";
const readers = new Map<SasAccountReader, "plain" | "retry">();
let plainFactories = 0, retryFactories = 0, active = 0, maximum = 0, kubeCalls = 0, kubeStarted = false;
const approval: SasApproval = { status: "INDETERMINATE", network: "devnet", attestation: "", credential: "", schema: "", issuer: "",
  checkedAt: new Date().toISOString(), reason: secret };
const evidence = { observations: [], collectionIssues: [] };
const factory = (kind: "plain" | "retry") => {
  if (kind === "plain") plainFactories++; else retryFactories++;
  const reader: SasAccountReader = { async account() { return null; } };
  readers.set(reader, kind); return reader;
};
await runMonitorSasComparison({
  plainReader: () => factory("plain"), retryReader: () => factory("retry"),
  async verify(reader) {
    active++; maximum = Math.max(maximum, active);
    try {
      await Promise.resolve();
      if (readers.get(reader) === "retry") throw new VerificationDiagnosticError("SAS_RPC_ACCOUNT_FETCH_FAILED", { accountKind: "SCHEMA", operation: "ACCOUNT_FETCH" });
      return approval;
    } finally { active--; }
  },
  async kubernetes() { kubeStarted = true; kubeCalls++; await Promise.resolve(); return evidence; },
}, record => records.push(record));
assert.equal(plainFactories, 3); assert.equal(retryFactories, 2); assert.equal(kubeCalls, 2);
assert.equal(maximum, 1); assert.equal(kubeStarted, true);
assert.equal(records.length, 9);
assert.equal(records[0]!.phase, "PLAIN_FRESH_BEFORE_K8S");
assert.equal(records.at(-1)!.phase, "PLAIN_REUSED_AFTER_K8S");
assert.ok(records.some(row => row.accountKind === "SCHEMA" && row.operation === "ACCOUNT_FETCH"));
assert.ok(records.every(row => Number.isInteger(row.durationMs) && row.durationMs >= 0));
assert.ok(!JSON.stringify(records).includes(secret));
const raw = Object.assign(new Error(secret), { headers: secret, url: secret, stack: secret });
const scheduled = traceScheduledSources({ async sas() { throw raw; }, async kubernetes() { return evidence; } }, row => records.push(row));
await assert.rejects(scheduled.sas(), error => error === raw); // exact original error propagates
assert.equal(await scheduled.kubernetes(), evidence); // exact result propagates
assert.ok(!JSON.stringify(records).includes(secret));
const noEffect = traceScheduledSources({ async sas() { return approval; }, async kubernetes() { return evidence; } }, () => { throw raw; });
assert.equal(await noEffect.sas(), approval); // logging failure never changes trust

// A blocked probe is reported but cannot start another SAS phase until settlement.
mock.timers.enable({ apis: ["setTimeout"] });
let release!: () => void, checks = 0;
const blocked = runMonitorSasComparison({ plainReader: () => factory("plain"), retryReader: () => factory("retry"),
  async verify() { if (++checks === 1) await new Promise<void>(resolve => { release = resolve; }); return approval; },
  async kubernetes() { return evidence; },
}, row => records.push(row));
await Promise.resolve(); mock.timers.tick(15000);
assert.equal(checks, 1);
assert.ok(records.some(row => row.outcome === "STILL_PENDING"));
release(); await blocked;
assert.equal(checks, 7);
mock.timers.reset();
const fixedRecords: ComparisonRecord[] = [];
await runMonitorSasComparison({ plainReader: () => factory("plain"), retryReader: () => factory("retry"), fixedReader: () => factory("plain"),
  async verify() { return approval; }, async kubernetes() { return evidence; },
}, row => fixedRecords.push(row));
assert.ok(fixedRecords.some(row => row.phase === "FIXED_AFTER_K8S"));
assert.ok(fixedRecords.some(row => row.phase === "FIXED_CONCURRENT_K8S" && row.source === "SAS"));
console.log("Monitor SAS comparison offline tests: PASS (phase order, fresh/reused/retry readers, no overlapping SAS probes, controlled Kubernetes concurrency, safe categories/timings, pending transport ownership and scheduled result/error preservation)");
