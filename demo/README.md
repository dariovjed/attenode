# Attenode demo workload and drift walkthrough

`demo/demo-api` is the small HTTP workload used in the validated Solana SAS → Kubernetes → dashboard demonstration. It does not perform verification or interact with Solana. The current approved baseline is the existing GHCR image pinned by its immutable digest.

## Existing approved baseline

The local policy selects namespace `attenode-demo`, Deployment `demo-api`, container `demo-api` and image repository `ghcr.io/dariovjed/demo-api`. The configured image and supported runtime imageID must match:

```text
ghcr.io/dariovjed/demo-api@sha256:3190be029b3730939206615819911fac3d6c5285d48eadd5c363826c950c9fee
```

Start the monitor and dashboard using the [root instructions](../README.md#run-the-dashboard). With valid current SAS approval and ready, unambiguous runtime evidence, the dashboard reports VERIFIED.

The operator manually validated intentional image drift to `attenode/demo-api:v2` as TRUST_BROKEN and restoration as VERIFIED. During rolling updates, INDETERMINATE was observed before a determined state returned. These are live observations, separate from offline tests.

## Repeat the drift/recovery demonstration

The following commands **mutate the demo workload** and must be run only by an explicitly authorized operator. Attenode monitoring itself remains read-only. Docker, kind and kubectl must already be available, and the existing cluster/context must be the intended target. Do not run against unrelated workloads.

Set `ATTENODE_KUBECONFIG` to the single authorized isolated kubeconfig path, as in the root startup instructions. Every kubectl example below explicitly selects that file and `kind-attenode`; the required-variable check stops the command if the path is unset or empty, preventing fallback to the default kubeconfig. Do not supply a colon-separated list of files.

Prepare a distinguishable local drift image:

```bash
docker build --build-arg APP_VERSION=v2 -t attenode/demo-api:v2 demo/demo-api
kind load docker-image attenode/demo-api:v2 --name attenode
```

Change the image and wait for rollout while watching the dashboard:

```bash
kubectl --kubeconfig "${ATTENODE_KUBECONFIG:?Set the authorized isolated kubeconfig path}" --context kind-attenode -n attenode-demo set image deployment/demo-api demo-api=attenode/demo-api:v2
kubectl --kubeconfig "${ATTENODE_KUBECONFIG:?Set the authorized isolated kubeconfig path}" --context kind-attenode -n attenode-demo rollout status deployment/demo-api --timeout=120s
```

After a complete, ready, unambiguous observation, the configuration mismatch should produce overall TRUST_BROKEN. A kind-reported bare `sha256:…` imageID is unsupported OCI identity evidence and remains INDETERMINATE in the separate runtime artifact result; it is not converted into a registry manifest digest.

Restore the exact approved reference:

```bash
kubectl --kubeconfig "${ATTENODE_KUBECONFIG:?Set the authorized isolated kubeconfig path}" --context kind-attenode -n attenode-demo set image deployment/demo-api demo-api=ghcr.io/dariovjed/demo-api@sha256:3190be029b3730939206615819911fac3d6c5285d48eadd5c363826c950c9fee
kubectl --kubeconfig "${ATTENODE_KUBECONFIG:?Set the authorized isolated kubeconfig path}" --context kind-attenode -n attenode-demo rollout status deployment/demo-api --timeout=120s
```

VERIFIED requires supported matching runtime evidence, not just successful rollout or matching Pod spec. An expired/stale/rejected SAS approval, unsupported runtime identity or incomplete observation prevents verification. No new attestation is needed for this drift/recovery flow while the existing approval remains valid.

## Workload API and local checks

The API listens on port 8080. `GET /` returns `service`, `version` and `message`; `GET /health` returns HTTP 200 with `{"status":"ok"}`. `APP_VERSION` defaults to `v1` and can be supplied at build time or overridden at runtime. `PORT` optionally changes the listening port.

From the repository root:

```bash
npm ci --prefix demo/demo-api --ignore-scripts
npm run check --prefix demo/demo-api
npm test --prefix demo/demo-api
APP_VERSION=v2 npm start --prefix demo/demo-api
```

The test script builds the application before running offline tests; `npm start` requires compiled `dist/server.js`. API health/version output is useful for demonstrating the workload, not evidence of cryptographic artifact identity.

## Fixture manifests and kind-loaded images

The checked-in `demo/k8s/namespace.yaml`, `deployment.yaml` and `service.yaml` are local setup fixtures. **The Deployment manifest still selects `attenode/demo-api:v1` with `IfNotPresent`; applying it does not install the approved GHCR baseline and can overwrite the approved image selection.** Setting the immutable approved image explicitly is a separate operator action.

For a fresh authorized demo setup, these manifests can create the namespace, Deployment and Service in the existing cluster. A local `v1` image must first be built/loaded if using the fixture as written:

```bash
docker build --build-arg APP_VERSION=v1 -t attenode/demo-api:v1 demo/demo-api
kind load docker-image attenode/demo-api:v1 --name attenode
kubectl --kubeconfig "${ATTENODE_KUBECONFIG:?Set the authorized isolated kubeconfig path}" --context kind-attenode -n attenode-demo apply -f demo/k8s/namespace.yaml
kubectl --kubeconfig "${ATTENODE_KUBECONFIG:?Set the authorized isolated kubeconfig path}" --context kind-attenode -n attenode-demo apply -f demo/k8s/deployment.yaml -f demo/k8s/service.yaml
```

Then select the approved GHCR reference using the restoration command above. GHCR access/pull availability belongs to cluster setup. Never treat a kind-loaded Docker image ID, CRI bare hash or mutable tag as proof of the SAS manifest digest.

Optional workload inspection after setup:

```bash
kubectl --kubeconfig "${ATTENODE_KUBECONFIG:?Set the authorized isolated kubeconfig path}" --context kind-attenode -n attenode-demo port-forward service/demo-api 8080:80
```

In another terminal, `curl --fail http://127.0.0.1:8080/health` checks the application response only.

The multi-stage Docker image installs development dependencies in its build stage; runtime contains compiled JavaScript and runs directly under Node as UID 1000. The Node 24 Alpine base tag follows maintenance updates; reproducible base identity would require explicit digest pinning. This demo does not establish verified build provenance or automatic enforcement.
