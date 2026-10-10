# Attenode Live Trust Dashboard

A read-only React, TypeScript and Vite interface for the working Attenode monitor. It presents backend verification decisions and keeps on-chain claims, local binding policy, runtime observations and operational health visibly separate.

## Start locally

From the repository root, start the monitor using the [monitor configuration guide](../monitor/README.md#start). This authorizes real read-only Devnet/Kubernetes requests; starting the frontend alone does not start the monitor.

In a second terminal:

```bash
# If dashboard dependencies are not yet installed:
npm ci --prefix apps/dashboard --ignore-scripts --no-audit --no-fund
npm run dashboard:start
```

Open **http://127.0.0.1:5173**. Vite uses a fixed loopback port and proxies `/api`, including SSE, to `http://127.0.0.1:3001`. The proxy preserves the frontend Origin and uses a loopback Host, matching monitor CORS/Host restrictions. Filesystem serving is restricted to the dashboard directory with secret/local-file exclusions.

## Interface and architecture

- `src/App.tsx`: prominent trust status, independent source freshness, operational health, SAS claims, local policy, Kubernetes observations and recent transitions. Real public account addresses link to Solana Explorer Devnet.
- `src/model.ts`: type-only backend response imports, response guards and presentation freshness checks. Backend verification modules are not shipped to the browser.
- `src/feed.ts`: initial `/api/status`, `/api/history` and `/api/health` requests plus one native EventSource for `/api/events`. Ordering guards prevent late initial fetches overwriting newer SSE evidence. Reconnection refreshes authoritative history, including ID resets after monitor restart.
- `src/styles.css`: responsive dark layout, readable technical values and text/symbol status distinctions without dependence on color alone.

VERIFIED, TRUST_BROKEN and INDETERMINATE are backend decisions. Loading, unavailable and stale states describe presentation availability; they do not create new trust decisions. The browser never derives approval from operational health, historical reports or diagnostic-only evidence. Disconnected, expired, missing or stale evidence cannot supply current VERIFIED approval.

The timeline uses `/api/history` and live transition notifications exclusively. Transition notifications refresh history; the browser does not invent entries from observed status changes. Evidence events update source details even when overall state is unchanged.

## Validation

From the repository root:

```bash
npm run dashboard:check
npm run test:dashboard
npm run dashboard:build
npm run check
npm run test:monitor
npm run test:sas:k8s
```

Offline tests cover React server rendering of all three trust states, unavailable SAS with fresh Kubernetes, stale/expired/historical evidence suppression, health/trust separation, safe errors, SSE reconnect, response races, history replacement and cleanup. Test fixtures are not imported by the browser. The production build emits to ignored `apps/dashboard/dist/`.

Separately, the operator manually validated the live dashboard against Devnet and kind: VERIFIED → TRUST_BROKEN after image drift → VERIFIED after restoration, with INDETERMINATE during rolling updates and live SSE refreshes. This manual validation is distinct from automated offline tests; no automated browser end-to-end suite is provided.

## Security and limitations

There are no wallet, signer, kubeconfig, mutation controls, synthetic production results, external fonts or chart services in the frontend. Verification stays in the backend. Local target/image repository policy is not presented as an on-chain claim. Kubernetes-reported identity is not cryptographically verified build provenance.

If the backend withholds `report` because SAS is unavailable, the UI can show Kubernetes freshness and diagnostics but cannot invent Pod details or policy. History is limited to the monitor's in-memory retention. A static production build needs a same-origin read-only `/api` proxy; Vite's development proxy is not included in the build. No production hosting configuration is provided.

No real screenshot asset is included yet; the [root README](../../README.md) has a submission screenshot placeholder.
