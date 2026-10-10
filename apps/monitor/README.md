# Attenode Live Trust Monitor

A local, read-only HTTP backend for the [Live Trust Dashboard](../dashboard/README.md). It reuses SAS validation, Kubernetes collection and pure runtime aggregation from the existing verifier. It does not cache a final VERIFIED decision or change the CLI's verification behavior.

## Start

From the repository root, with dependencies installed and live reads authorized:

```bash
export ATTENODE_KUBECONFIG="/path/to/authorized/kubeconfig"
export ATTENODE_CONTEXT="kind-attenode"
export ATTENODE_NAMESPACE="attenode-demo"
export ATTENODE_DEPLOYMENT="demo-api"
export ATTENODE_CONTAINER="demo-api"
export ATTENODE_IMAGE_REPOSITORY="ghcr.io/dariovjed/demo-api"
npm run monitor:start
```

All six variables are required. The implemented local binding supports only this demo-api target and image repository. No `.env`, wallet or default kubeconfig is loaded. Authentication follows the explicitly supplied kubeconfig, including its configured authentication plugins.

| Optional variable | Default | Meaning |
| --- | --- | --- |
| `ATTENODE_MONITOR_PORT` | `3001` | Local HTTP port |
| `ATTENODE_MONITOR_ORIGIN` | `http://127.0.0.1:5173` | One exact local HTTP frontend origin |
| `ATTENODE_SAS_MAX_AGE_MS` | `120000` | Maximum SAS evidence age; range 1000–3600000 ms |

The server always binds to `127.0.0.1`. CORS allows the configured origin without credentials or wildcards; Host must also be loopback. Local requests without Origin are accepted. There is no authentication: other local processes can read the public evidence. No HTTP parameter selects files, targets or commands.

## HTTP contract

- `GET /api/status`: current status, response timestamp, source freshness, sanitized diagnostics and current `report`. `lastObtainedReport` is historical and explicitly `diagnosticOnly`; it must never be presented as current approval.
- `GET /api/events`: SSE `evidence` updates and `transition` events only when overall state changes. New connections receive a snapshot. Reconnect clients fetch current history; there is no SSE replay. Up to 64 clients are supported; slow consumers are disconnected.
- `GET /api/history`: last 100 transitions in memory, with IDs, timestamps, state changes and safe diagnostics. Cleared on restart; no account bodies, kubeconfig or secrets are stored.
- `GET /api/health`: operational `MONITORING`, `DEGRADED` or `STOPPED`, source activity and diagnostics. HTTP 200 means the API responds, not that software is VERIFIED.

`freshness.sas` and `freshness.kubernetes` expose separate checked/attempt/completion timestamps, age, maximum age, freshness, in-flight and timeout information. Evidence age starts when reading begins; errors do not reset it. `freshness.evidenceCurrent` requires current evidence from both sources and a determined result.

## Evidence lifecycle

Kubernetes is collected initially and every **5 seconds**, including when SAS is unavailable. SAS is validated initially and every **60 seconds**, always with **finalized** commitment. Each snapshot recomputes trust from validated SAS approval and current Kubernetes observations through the shared core.

SAS approval may survive an availability failure only within `ATTENODE_SAS_MAX_AGE_MS` and before on-chain expiration. Such a snapshot can remain VERIFIED or TRUST_BROKEN with a visible SAS warning and DEGRADED health. Generic fetch failures do not prove rate limiting. Observed invalid credentials, schemas, attestations, missing accounts, initialization/address/decoding failures and explicit late rejections invalidate approval immediately. Late positive results cannot restore timed-out evidence. Without valid current approval, trust is INDETERMINATE; Kubernetes drift cannot be attributed to an unestablished identity.

Kubernetes maximum age is **15 seconds**, but collection failures immediately invalidate current Kubernetes evidence. SAS freshness below its 60-second renewal interval intentionally creates INDETERMINATE gaps. Expiration is checked on every snapshot using the shared core rule.

Each source has a **15-second watchdog** and its own operation lock. A timeout publishes a safe diagnostic while the transport remains tracked until settlement; no second operation for that source starts meanwhile. Sources can operate concurrently with each other. Late successful results are discarded. When transport settles, a later eligible tick can recover. An operation that never settles requires manual restart; Kubernetes currently has no cancellation interface.

## RPC reliability

The monitor uses `createMonitorDevnetSasReader`; the CLI retains its original reader transport. Both reuse account-fetching and validation logic. The monitor transport lets native fetch calculate Content-Length, retaining SDK bigint serialization, RPC transformations and finalized account reads.

An offline regression on Node.js 24.10.0 reproduced the installed Kubernetes client's Undici dispatcher initialization interacting with Gill's explicit Content-Length: the header became a duplicated value and was rejected locally before connection. This was not evidence of RPC rate limiting. The operator subsequently validated the monitor-only fix in a persistent live process, including two scheduled SAS renewals. The original live exception's full contents were not collected, and compatibility across all Node/SDK versions is not established.

Retries are limited to three attempts per account with 250/500 ms backoff, only for identified connection interruption, timeout, HTTP 429 or HTTP 502/503/504. Each attempt has a 2-second AbortSignal budget, and renewal has a 10-second budget from reader creation. Accounts are fetched sequentially. Generic unknown failures, TLS, address, decoding, initialization and missing accounts are not retried. If cancellation is ignored, the lock remains until settlement. No commitment downgrade or global dispatcher patch is used.

## Validation

From the repository root:

```bash
npm run check
npm run test:monitor
npm run test:monitor:sas-comparison
npm run test:monitor:rpc-transport
npm run test:sas:reader
npm run test:sas:k8s
```

These automated tests use offline readers/transport fixtures. They cover drift/recovery, expiration, availability failures, timeout ownership, concurrency, SSE/history and the transport regression. Separately, the operator manually validated real Devnet/kind monitoring and dashboard drift/recovery; offline tests do not substitute for those observations.

## Troubleshooting

Safe diagnostics identify stages and allowlisted categories without publishing raw messages, headers, URLs, stack traces or account bytes. Unknown RPC errors do not establish a transient cause. Check source diagnostics and freshness separately from health and overall trust.

Temporary process-local instrumentation is available after stopping the existing monitor:

```bash
ATTENODE_DIAGNOSE_SAS=1 npm run monitor:start
```

It compares original fresh/reused/retry SAS readers before, concurrently with and after Kubernetes initialization, then runs `FIXED_AFTER_K8S` and `FIXED_CONCURRENT_K8S` using the corrected transport. All probes perform full finalized SAS validation. Records go to local stderr only; no browser endpoint is exposed and probe results never seed monitor approval. Old transport phases can reproduce local rejection while fixed phases succeed. A diagnostic watchdog reports pending work without abandoning it; a probe that never settles prevents normal polling from starting. Restart without the flag for normal operation.

## Boundaries

Read-only GET/list collection does not enforce policy or roll back workloads. Kubernetes/CRI and RPC reports remain trusted sources. Unsupported runtime IDs remain OCI INDETERMINATE even if reliable configuration mismatch establishes overall TRUST_BROKEN. No verified build provenance is claimed.

Polling cannot detect unknown revocations instantly: exposure is bounded by renewal, configured freshness and expiry. The local clock must be correct. History has no persistence, and a permanently blocked transport requires restart. See the [root guide](../../README.md) for approved identity and the independent CLI command.
