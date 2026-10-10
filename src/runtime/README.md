# Runtime and SAS deployment verification

The implemented runtime verifier supports a manual Kubernetes baseline, an opt-in Solana SAS approval gate and the continuous monitor. The shared core preserves separate SAS validation, Kubernetes configuration agreement, OCI runtime identity and overall results.

## Run the existing CLI

From the repository root, after configuring the environment in the [root guide](../../README.md#run-the-dashboard):

```bash
npm run --silent verify:k8s -- \
  --sas \
  --kubeconfig "$ATTENODE_KUBECONFIG" \
  --context "$ATTENODE_CONTEXT" \
  --namespace "$ATTENODE_NAMESPACE" \
  --deployment "$ATTENODE_DEPLOYMENT" \
  --container "$ATTENODE_CONTAINER" \
  --image-repository "$ATTENODE_IMAGE_REPOSITORY"
```

Append `--json` for the complete structured report on stdout; errors remain on stderr. Exit codes are `0` VERIFIED, `2` TRUST_BROKEN, `3` INDETERMINATE and `1` configuration/execution error. SAS mode rejects `--approved-image` and `--approved-runtime-image-id` overrides.

The existing manual baseline mode remains available:

```bash
npm run --silent verify:k8s -- \
  --kubeconfig "$ATTENODE_KUBECONFIG" \
  --context "$ATTENODE_CONTEXT" \
  --namespace attenode-demo --deployment demo-api --container demo-api \
  --approved-image attenode/demo-api:v1
```

Manual `--approved-runtime-image-id` optionally supplies an exact runtime baseline. Manual VERIFIED means agreement with that supplied baseline, not SAS approval or cryptographic artifact identity. A tag-only baseline cannot detect content replacement under the same tag.

## Shared implementation

- `verification.ts`: pure `verifyRuntimeIdentity(approved, observed)` baseline comparison. Approvals select namespace, workload, container, image reference and optional exact runtime imageID. Results include status, reason codes and comparison basis.
- `kubernetes.ts`: injected `KubernetesReader`, independent `collectKubernetesEvidence`, pure `compareKubernetesEvidence` and the combined one-shot adapter.
- `kubernetes-client.ts` / `kubernetes-loader.ts`: read-only client with explicit kubeconfig and lazy loading. No default kubeconfig discovery or resource mutation. Optional CLI context selection changes only its private in-memory configuration; authentication follows that file, including configured plugins.
- `sas-verification.ts`: local binding validation, `approvedIdentityFromSas`, manifest evidence comparison, expiration checks and `composeSasKubernetesReport` shared by CLI and monitor.
- `../attestations/sas-reader.ts`, `sas-onchain.ts` and `sas-approval.ts`: wallet-free account fetching and account-chain/payload validation. Runtime reads remain finalized.
- `diagnostics.ts`: safe stage/code explanations instead of raw external error text.

`verifySasKubernetesDeployment` validates SAS before constructing the Kubernetes client. The monitor independently collects Kubernetes while periodically renewing SAS, then uses the same pure comparison and aggregation functions. It caches validated approval only, never an overall VERIFIED result. See the [monitor guide](../../apps/monitor/README.md) for freshness and transport lifecycle.

## Kubernetes observations

The adapter reads the Deployment, all paginated namespace ReplicaSets and Pods, then the Deployment again. Ownership is established by unique controller references and matching kinds, API versions, names and UIDs through Deployment → ReplicaSet → Pod. Names or labels alone never prove ownership.

It selects exactly one named spec container and its container status. Readiness requires a Running/Ready Pod, a ready running container and no deletion timestamp. Missing status, duplicate matches, unresolved ownership and malformed metadata are conservative collection issues. Deployment UID/resourceVersion changes during collection invalidate the observation.

Empty Pod sets, unready Pods, collection errors and mixed image/runtime/readiness observations yield INDETERMINATE. Per-Pod findings remain visible during ambiguous rollouts. Sequential API reads are not an atomic cluster snapshot.

## SAS binding and aggregation

The unchanged `DeploymentAttestationV1` schema attests repository, commit SHA, artifact digest, environment, provenance provider and deployedAt. Account ownership, discriminators, trusted credential/schema, issuer authority, schema version/layout, PDA/nonce, exact decoded payload and expiration are validated before approval is used.

The approved digest comes from the decoded validated account, never a silent substitution of configured expected data. Image repository, namespace, Deployment and container are explicit **local policy**, not on-chain claims. This MVP supports the fixed demo-api binding documented in the [root guide](../../README.md#read-only-sas--kubernetes-verification).

| Evidence | Overall result |
| --- | --- |
| Valid current SAS, matching configuration and complete supported matching runtime identity | VERIFIED |
| Valid current SAS and reliable, ready, unambiguous configured-image mismatch | TRUST_BROKEN, even if unsupported OCI identity remains separately INDETERMINATE |
| Valid SAS, matching configuration, missing/unsupported runtime identity | INDETERMINATE |
| Missing/stale/expired/rejected approval, incomplete collection or ambiguous rollout | INDETERMINATE |

Configuration mismatch promotion requires no collection issues and every selected ready Pod to report only the explicit image-reference mismatch. Missing/malformed runtime fields, unready Pods and ambiguous evidence remain blockers. Do not generalize the pure baseline function's mismatch precedence to integrated trust aggregation.

SAS runtime identity accepts only canonical unprefixed registry-qualified `repository@sha256:<64 lowercase hex characters>` references. A supported differing reference can establish runtime TRUST_BROKEN; missing/unsupported formats remain runtime INDETERMINATE. Docker config IDs, arbitrary hashes and CRI prefixes are never normalized into OCI manifest identity. Matching Pod spec alone is insufficient.

## Offline validation

```bash
npm run check
npm run test:runtime
npm run test:k8s
npm run test:k8s:output
npm run test:sas:k8s
npm run test:sas:reader
npm run test:verification:diagnostics
npm run test:verification:cli-diagnostic
npm run demo:runtime
```

`demo:runtime` is a network-free JSON fixture demonstration; an optional file can be supplied as `npm run demo:runtime -- path/to/fixture.json`. Its result carries status rather than the live CLI's policy-specific exit codes.

Automated tests use offline observations and mocked accounts, including configuration drift with unsupported runtime IDs, mixed Pods, expiry, rejection and fail-closed errors. Separately, the operator manually validated the real Devnet/kind dashboard flow: approved deployment, drift detection and recovery, including conservative rolling-update states.

## Security boundaries

The verifier reads accounts and Kubernetes resources without loading a Solana wallet, submitting transactions or enforcing changes. It trusts the RPC endpoint and Kubernetes API/node/CRI observations; matching reported identity is not independent execution proof or cryptographically verified build provenance. Monitor health is not a trust verdict. The fixed attestation expires; renewal requires a deliberate approval process, not automatic trust extension.
