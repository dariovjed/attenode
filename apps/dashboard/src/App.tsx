import { useEffect, useState, type ReactNode } from "react";
import { browserTransport, DashboardFeed } from "./feed.js";
import { currentReport, explorer, initialState, sourceFresh, trustLabel, type DashboardState, type MonitorSnapshot } from "./model.js";

export function useDashboard() {
  const [state, setState] = useState(initialState);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const feed = new DashboardFeed(browserTransport, setState); feed.start();
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => { clearInterval(timer); feed.stop(); };
  }, []);
  return { state, now };
}
const time = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not observed";
const tone = (value: string) => value === "VERIFIED" ? "good" : value === "TRUST_BROKEN" ? "broken" : "uncertain";
function Badge({ value }: { value: string }) { return <span className={`badge ${tone(value)}`}>{value.replaceAll("_", " ")}</span>; }
function Detail({ label, children, mono = true }: { label: string; children: ReactNode; mono?: boolean }) {
  return <div className="detail"><dt>{label}</dt><dd className={mono ? "mono" : ""}>{children || <span className="muted">Unavailable in current evidence</span>}</dd></div>;
}
function Account({ address }: { address?: string }) {
  const url = explorer(address);
  return url ? <a href={url} target="_blank" rel="noopener noreferrer">{address}<span className="external" aria-label="Open Solana Explorer">↗</span></a> : <>{address}</>;
}
function Source({ snapshot, name, receivedAt, now }: { snapshot: MonitorSnapshot | null; name: "sas" | "kubernetes"; receivedAt: number; now: number }) {
  const value = snapshot?.freshness[name];
  const fresh = snapshot && sourceFresh(snapshot, name, receivedAt, now);
  const age = value?.ageMs === null || value?.ageMs === undefined ? null : value.ageMs + Math.max(0, now - receivedAt);
  return <div className="source"><div className="source-title"><span>{name === "sas" ? "SAS approval" : "Kubernetes observation"}</span><span className={fresh ? "fresh" : "muted"}>{fresh ? "● Fresh" : "◷ Not current"}</span></div>
    <div className="source-age">{age === null ? "Awaiting evidence" : `${Math.floor(age / 1000)}s old`}<span>Limit {value ? `${value.maxAgeMs / 1000}s` : "—"}</span></div>
    <p className="small muted">Checked {time(value?.checkedAt)}</p>
    {value?.inFlight && <p className="small">{value.timedOut ? "Transport blocked after timeout" : "Read in progress"}</p>}
    {value?.diagnostic && <div className="diagnostic"><strong>{value.diagnostic.code}</strong><p>{value.diagnostic.explanation}</p></div>}
  </div>;
}

export function Dashboard({ state, now }: { state: DashboardState; now: number }) {
  const label = trustLabel(state, now);
  const report = currentReport(state, now);
  const sas = report?.sas;
  const policy = report?.localPolicy;
  const pods = report?.kubernetes?.observations ?? [];
  const healthCurrent = state.health && !state.errors.health && now - state.healthAt < 20_000;
  const healthLabel = healthCurrent ? state.health!.state : "UNAVAILABLE";
  const description = label === "VERIFIED" ? "Current evidence agrees with the approved artifact."
    : label === "TRUST_BROKEN" ? "Current observations disagree with the approved deployment."
    : label === "INDETERMINATE" ? "The monitor cannot establish trust from the available evidence."
    : label === "STALE" ? "Evidence is no longer current. Waiting for a fresh monitor update."
    : label === "LOADING" ? "Connecting to the read-only monitor and collecting evidence."
    : "The monitor connection is unavailable. Live trust is not being presented.";
  return <div className="shell">
    <header className="header"><a className="brand" href="/" aria-label="Attenode dashboard"><span className="brand-mark">A</span><span>attenode<span className="brand-sub">LIVE TRUST</span></span></a>
      <div className="header-meta"><span className="network">Solana Devnet</span><span className="read-only">Read-only monitor</span></div></header>
    <main>
      <div className="page-heading"><div><p className="eyebrow">DEPLOYMENT INTEGRITY / LIVE EVIDENCE</p><h1>Trust, observed.</h1><p className="muted">From on-chain approval to the running artifact.</p></div><div className="stream"><span className={state.connection === "live" ? "fresh" : "muted"}>● {state.connection === "live" ? "Event stream connected" : state.connection === "reconnecting" ? "Reconnecting event stream" : "Connecting event stream"}</span><small>Updated {time(state.snapshot?.timestamp)}</small></div></div>
      <section className={`trust-panel ${tone(label)}`} aria-live="polite" aria-label="Live trust status"><div className="trust-main"><div className="trust-symbol" aria-hidden="true">{label === "VERIFIED" ? "✓" : label === "TRUST_BROKEN" ? "!" : "?"}</div><div><p className="eyebrow">OVERALL VERIFICATION</p><h2>{label.replaceAll("_", " ")}</h2><p>{description}</p></div></div><div className="trust-meta"><span className="small muted">Decision authority</span><strong>Attenode verifier</strong><span className="small muted">SAS + configuration + OCI evidence</span></div></section>
      {(state.errors.status || state.connection === "reconnecting") && <div className="notice" role="status">{state.errors.status ?? "Connection interrupted. Reconnecting automatically; previous evidence is not shown as live approval."}</div>}
      <div className="overview-grid"><section className="card"><div className="card-heading"><h2>Evidence freshness</h2><span className="section-tag">INDEPENDENT SOURCES</span></div><div className="sources"><Source snapshot={state.snapshot} name="sas" receivedAt={state.receivedAt} now={now}/><Source snapshot={state.snapshot} name="kubernetes" receivedAt={state.receivedAt} now={now}/></div></section>
        <section className="card health"><div className="card-heading"><h2>Monitor operations</h2><span className="section-tag">HEALTH</span></div><div className="health-status"><span className={healthLabel === "MONITORING" ? "fresh" : "muted"}>●</span><strong>{healthLabel}</strong></div><p className="muted small">{state.errors.health ?? (healthCurrent ? state.health!.inFlight ? "A read-only verification is in progress." : "Monitor health endpoint is responding." : "Awaiting a current health response.")}</p><p className="health-note">Operational health is not proof of software trust.</p></section></div>
      <div className="evidence-grid"><section className="card"><div className="card-heading"><div><p className="eyebrow">01 / ON-CHAIN CLAIMS</p><h2>Solana SAS attestation</h2></div><Badge value={sas?.status ?? "INDETERMINATE"}/></div>
        {!sas && <div className="empty">No current validated SAS payload is available. Historical diagnostic reports are not used as approval.</div>}
        <dl><Detail label="Attestation account"><Account address={sas?.attestation}/></Detail><Detail label="Authorized issuer"><Account address={sas?.issuer}/></Detail><Detail label="Credential"><Account address={sas?.credential}/></Detail><Detail label="Schema"><Account address={sas?.schema}/></Detail><Detail label="Repository">{sas?.payload?.repository}</Detail><Detail label="Commit SHA">{sas?.payload?.commitSha}</Detail><Detail label="Approved OCI manifest digest">{sas?.payload?.artifactDigest}</Detail><Detail label="Environment">{sas?.payload?.environment}</Detail><Detail label="Approval expires" mono={false}>{sas?.expiry ? time(new Date(Number(sas.expiry) * 1000).toISOString()) : null}</Detail></dl>
        <p className="boundary">The attestation approves an artifact digest. It does not attest Kubernetes targets or establish verified build provenance.</p>
      </section>
      <div className="runtime-column"><section className="card policy"><div className="card-heading"><div><p className="eyebrow">02 / LOCAL BINDING POLICY</p><h2>Deployment target</h2></div><span className="section-tag">OFF-CHAIN</span></div><dl className="target-grid"><Detail label="Namespace">{policy?.namespace}</Detail><Detail label="Deployment">{policy?.workload}</Detail><Detail label="Container">{policy?.container}</Detail><Detail label="Image repository">{policy?.imageRepository}</Detail></dl><p className="boundary">These bindings are enforced locally; they are not claims in the SAS payload.</p></section>
      <section className="card runtime"><div className="card-heading"><div><p className="eyebrow">03 / KUBERNETES-REPORTED OBSERVATIONS</p><h2>Runtime evidence</h2></div><Badge value={report?.kubernetes?.result.status ?? "INDETERMINATE"}/></div>
        <div className="finding"><span>OCI runtime identity</span><Badge value={report?.artifact.status ?? "INDETERMINATE"}/></div>
        {!pods.length ? <div className="empty">{state.snapshot && sourceFresh(state.snapshot, "kubernetes", state.receivedAt, now) ? "Kubernetes collection is fresh. Runtime details are unavailable until the backend publishes evidence bound to a valid SAS approval." : "No current Pod observations available."}</div> : pods.map(pod => <article className="pod" key={`${pod.pod}:${pod.container}`}><div className="pod-heading"><strong className="mono">{pod.pod}</strong><span className={pod.ready ? "fresh" : "muted"}>{pod.ready ? "✓ Ready" : "! Not ready"}</span></div><dl><Detail label="Configured image">{pod.imageReference}</Detail><Detail label="Reported runtime imageID">{pod.runtimeImageID}</Detail></dl>{report?.kubernetes?.perPod.find(entry => entry.observation.pod === pod.pod)?.result.reasons.map((reason, index) => <p className="small muted" key={`${reason.code}:${index}`}>{reason.code}: {reason.message}</p>)}</article>)}
        {report?.kubernetes?.collectionIssues.map((issue, index) => <p className="diagnostic" key={index}>{issue}</p>)}
        {report && <p className="small muted">{report.artifact.reason}</p>}
        <p className="boundary">Runtime imageID is evidence reported by Kubernetes/CRI. Matching the Pod spec alone does not prove artifact identity.</p>
      </section></div></div>
      <section className="card timeline"><div className="card-heading"><div><p className="eyebrow">STATE CHANGES / MONITOR HISTORY</p><h2>Recent transitions</h2></div><span className="section-tag">LAST {state.history.length} REPORTED</span></div>
        {state.errors.history && <p className="notice">{state.errors.history} Previously fetched history is retained.</p>}
        {!state.history.length ? <div className="empty">No transitions received from the monitor yet.</div> : <ol>{[...state.history].reverse().map(entry => <li key={entry.id}><span className={`timeline-dot ${tone(entry.to)}`} aria-hidden="true"/><div className="transition-label"><Badge value={entry.from}/><span className="muted">→</span><Badge value={entry.to}/>{entry.diagnostic && <small className="muted">{entry.diagnostic.code}</small>}</div><time dateTime={entry.timestamp}>{time(entry.timestamp)}</time></li>)}</ol>}
      </section>
    </main><footer><span>ATTENODE <span className="muted">/ Live Trust Dashboard</span></span><span>Read-only evidence · No wallet connection · No mutation controls</span></footer>
  </div>;
}
export default function App() { const { state, now } = useDashboard(); return <Dashboard state={state} now={now}/>; }
