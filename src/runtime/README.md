# Runtime baseline verification

`verifyRuntimeIdentity(approved, observed)` is a pure, network-free function. It
returns a status, reason objects (`code`, `message`, optional `field`), and the
comparison basis. It has no dependency on SAS, Solana or Kubernetes clients.

An approval selects `namespace`, Deployment `workload`, `container`, and
`imageReference`. `runtimeImageID` optionally pins an observed CRI runtime
baseline. An observation includes the same target fields plus `pod`, the
configured `imageReference`, the CRI `runtimeImageID`, and container `ready`.

`VERIFIED` means a ready container matches this supplied baseline. It does **not**
mean its artifact has cryptographic provenance. Mutable tags can point to new
content; a tag-only approval cannot detect content replacement under the same
tag. Results expose `basis: image-reference` in that case. Even with a runtime
imageID baseline, this is local runtime identity comparison, not signature or
build-provenance verification.

Docker local image IDs, CRI imageIDs and registry manifest digests are separate
identity domains. Never substitute one for another. Runtime IDs are compared
exactly, including prefixes. The kind demo had empty CRI `repoDigests`, so no
registry digest evidence is inferred from these fixtures.

## Rules and reasons

- `INVALID_APPROVAL`: incomplete or malformed approval -> INDETERMINATE.
- `MISSING_OBSERVATION`: no observation -> INDETERMINATE.
- `AMBIGUOUS_OBSERVATION`: arrays are not a selected container -> INDETERMINATE.
- `MALFORMED_OBSERVATION`: invalid identity/runtime fields -> INDETERMINATE.
- `TARGET_MISMATCH`: wrong namespace, Deployment or container -> INDETERMINATE;
  this observation is not evidence about the approved target.
- `IMAGE_REFERENCE_MISMATCH`: configured reference differs -> TRUST_BROKEN.
- `RUNTIME_IMAGE_ID_MISMATCH`: supplied runtime baseline differs -> TRUST_BROKEN.
- `MISSING_RUNTIME_IMAGE_ID`: absent, null or empty runtime ID -> INDETERMINATE.
- `CONTAINER_NOT_READY`: readiness false or absent -> INDETERMINATE.
- `BASELINE_MATCH`: all required comparisons and readiness pass -> VERIFIED.

Valid mismatch evidence takes precedence over missing readiness/runtime data:
a v2 reference with no ready runtime still breaks the approved v1 configuration.
Malformed input and incorrect targets are rejected before drift comparison.

## Offline demo

```bash
npm run demo:runtime
npm run test:runtime
npm run demo:runtime -- path/to/fixture.json
```

The optional fixture is `{ "approved": {...}, "observed": {...} }` using the
models above. No live queries occur. CLI results are JSON; status is carried in
the result rather than a policy-specific process exit code.

## Next Kubernetes adapter

Select the approved Deployment and resolve Pod owner references through its
ReplicaSets; never infer Deployment ownership from Pod names or labels alone.
For each selected Pod, locate exactly one matching entry in `spec.containers`
and `status.containerStatuses` by container name. Reject duplicate matches or
ambiguous ownership. Populate namespace and pod from metadata, workload from
verified ownership, imageReference from the configured container, and imageID
and readiness from its status. Also require the Pod to be Running, Ready and
not terminating before setting `ready: true`; absent status sets readiness false
and runtimeImageID null. Feed each Pod/container independently to the verifier.
Report all Pods during rollouts, including mixed v1/v2 results. An empty Pod set
must yield INDETERMINATE; never aggregate it to VERIFIED. No adapter is included
yet.

Registry-backed immutable `repo@sha256:...` references already fit the
`imageReference` field and should become the preferred approved configuration.
A future adapter can add explicitly typed registry-manifest evidence and a
separate comparison basis after validating its source. It must distinguish
manifest/index digests from runtime configuration IDs, and leave missing
registry evidence INDETERMINATE when registry verification is required. Matching
a configured digest reference alone must not be presented as proof that the
runtime executed that artifact.

## Read-only Kubernetes adapter

`kubernetes.ts` accepts an injected reader; `kubernetes-client.ts` uses
`@kubernetes/client-node` with an explicit kubeconfig file. It never calls
`loadFromDefault`, edits a file, or changes global context. `--context` optionally
selects a context only on its private in-memory KubeConfig; otherwise it uses the
current context recorded in the explicitly supplied file. Authentication follows
that file's client configuration, including authentication plugins if configured.

```bash
npm run verify:k8s -- --kubeconfig <path> --namespace attenode-demo --deployment demo-api --container demo-api --approved-image attenode/demo-api:v1 --approved-runtime-image-id sha256:236c1d781bc1577bcf8eea8dabab84a0e6bbc31e28255550d2afdf9c8d903937
# Optional: append --context kind-attenode to select it explicitly.
npm run test:k8s
```

Reads: target apps/v1 Deployment, namespace apps/v1 ReplicaSets, namespace v1
Pods, then target Deployment again. Lists consume all continuation pages.
Controller owner references must uniquely identify parent kind, API version,
name and UID. Unrelated Pods with resolvable unrelated owners are excluded.
Missing/ambiguous ownership and unresolved ReplicaSet references conservatively
make the result INDETERMINATE, even if they occur elsewhere in the namespace.
Names and labels alone never establish target ownership.

Configured image comes from Pod spec; imageID and readiness come from the named
container status. Running state, Pod Running/Ready, and absence of deletion are
also required. Terminating Pods are retained as not-ready observations. Duplicate
container matches, bad metadata, and UID mismatches are collection issues.

Each Pod is passed to the existing verifier. Consistent replicas share its result.
Conflicting image references, imageIDs or readiness produce an array input to
its existing ambiguity rule and an aggregate INDETERMINATE; per-Pod drift reasons
remain visible. Missing Pods yield MISSING_OBSERVATION. Collection/API failures
are INDETERMINATE with sanitized diagnostics. Deployment UID/resourceVersion
changes during collection also force INDETERMINATE. These sequential reads are
not an atomic cluster snapshot; later runtime changes require another check.

The CLI defaults to concise human-readable output with target, approval, observed
Pods, collection issues, status and reason explanations. Consistent replicas are
grouped; large reports show at most five groups and three Pod names per group.
Append `--json` for the complete report (approval, observations, per-Pod results,
collection issues and final verification) as JSON only on stdout. Errors remain
on stderr. When invoking through npm for machine parsing, use
`npm run --silent verify:k8s -- ... --json` to suppress npm's own banner.
Exit codes are
0 VERIFIED, 2 TRUST_BROKEN, 3 INDETERMINATE, and 1 CLI/configuration failures.
For the supplied consistent v2 state, expect TRUST_BROKEN, reference and runtime
imageID mismatch reasons, and exit 2. Mixed v1/v2 rollout Pods yield INDETERMINATE.
No registry digest equivalence is inferred from runtime IDs.
