# Attenode Live Trust Dashboard

React + TypeScript + Vite frontend, entirely read-only. No wallets, signers, kubeconfig, mutation controls, synthetic production data, external fonts or chart services. The browser imports backend response types with `import type`; verification modules are not shipped to the browser.

From the repository root, start the authorized monitor in one terminal with its existing configuration:

```bash
export ATTENODE_KUBECONFIG="/path/to/authorized/kubeconfig"
export ATTENODE_CONTEXT="kind-attenode"
export ATTENODE_NAMESPACE="attenode-demo"
export ATTENODE_DEPLOYMENT="demo-api"
export ATTENODE_CONTAINER="demo-api"
export ATTENODE_IMAGE_REPOSITORY="ghcr.io/dariovjed/demo-api"
npm run monitor:start
```

In a second terminal:

```bash
# First-time installation, if dashboard dependencies have not been installed:
npm ci --prefix apps/dashboard --ignore-scripts --no-audit --no-fund
npm run dashboard:start
```

Open **http://127.0.0.1:5173**. Vite uses a fixed loopback port and proxies `/api` (including SSE) to `http://127.0.0.1:3001`. Requests keep the local frontend Origin and use a loopback Host, matching the backend's existing restrictive CORS/Host policy. Its filesystem serving allowlist is restricted to the dashboard directory and explicitly denies secret/local files. No backend changes are needed. Starting the frontend does not start the monitor or authorize live reads.

Architecture:

- `src/model.ts`: shared backend types, response guards and presentation freshness checks. It never validates/approves artifacts. VERIFIED/TRUST_BROKEN are presented only from current backend evidence. Disconnected, expired, stale, missing and diagnostic-only evidence cannot supply current approval fields. Backend INDETERMINATE is a normal trust state. LOADING/UNAVAILABLE/STALE are presentation states, not new verifier decisions.
- `src/feed.ts`: initial status/history/health requests, one native EventSource, automatic reconnect, snapshot ordering guards, request cleanup and health polling. Late initial fetches cannot overwrite newer SSE evidence. Transition events refresh the authoritative history endpoint; no transition entries are synthesized from observations. Reconnection refreshes history, including backend restarts and ID resets.
- `src/App.tsx`: live status, independent freshness cards, operational health, on-chain claims, off-chain binding policy, Kubernetes observations and transition timeline. Account links use Solana Explorer Devnet. Current source details do not fall back to `lastObtainedReport`.
- `src/styles.css`: dark, responsive layout with text/symbol status cues, system typography and no animations.

Validation:

```bash
npm run dashboard:check
npm run test:dashboard
npm run dashboard:build
npm run check
npm run test:monitor
npm run test:sas:k8s
```

Tests use synthetic offline fixtures only, never imported by the browser. They cover React server rendering of all trust states, missing SAS with fresh Kubernetes, stale/expired/historical evidence suppression, health/trust separation, safe errors, SSE reconnect, response races, history replacement and cleanup. Production build emits to the ignored `apps/dashboard/dist/` directory.

Limitations: no browser end-to-end or real-cluster verification was performed. When the backend withholds `report` because SAS is unavailable, the dashboard can show Kubernetes freshness/diagnostics but cannot invent its Pod details or target policy. History is limited to the monitor's in-memory retention. The production static build needs a same-origin read-only `/api` proxy; Vite's development proxy is not part of the static build. Build provenance is not established by matching SAS/OCI/CRI evidence.
