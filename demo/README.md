# Attenode Kubernetes demo

This standalone API supports the later runtime image verification and deployment
 drift demo. It does not implement verification or interact with Solana.

The API listens on port 8080. `GET /` returns `service`, `version`, and `message`;
`GET /health` returns 200 and `{"status":"ok"}`. `APP_VERSION` defaults to `v1`
and can be set at image build time or overridden in the container environment.
`PORT` optionally overrides the listening port.

## Local checks

From the repository root:

```bash
npm ci --prefix demo/demo-api --ignore-scripts
npm run check --prefix demo/demo-api
npm test --prefix demo/demo-api
APP_VERSION=v2 npm start --prefix demo/demo-api
```

## Existing kind cluster workflow

Run from the repository root. These commands use the existing `attenode` cluster
and explicitly target its `kind-attenode` kubectl context. They never create or
reconfigure the cluster. Docker, kind and kubectl must already be available.

```bash
# Build v1; only demo/demo-api is sent as the Docker build context.
docker build --build-arg APP_VERSION=v1 -t attenode/demo-api:v1 demo/demo-api

# Load the image into the existing cluster.
kind load docker-image attenode/demo-api:v1 --name attenode

# Create the namespace first, then the application resources.
kubectl --context kind-attenode apply -f demo/k8s/namespace.yaml
kubectl --context kind-attenode apply -f demo/k8s/deployment.yaml -f demo/k8s/service.yaml

# Wait for a successful rollout and a Ready pod.
kubectl --context kind-attenode -n attenode-demo rollout status deployment/demo-api --timeout=120s
kubectl --context kind-attenode -n attenode-demo wait --for=condition=Ready pod -l app=demo-api --timeout=120s
kubectl --context kind-attenode -n attenode-demo get pods -l app=demo-api

# Keep this command running in a terminal.
kubectl --context kind-attenode -n attenode-demo port-forward service/demo-api 8080:80
```

In a second terminal:

```bash
curl --fail http://127.0.0.1:8080/
curl --fail http://127.0.0.1:8080/health
```

Expected root response:

```json
{"service":"demo-api","version":"v1","message":"Hello from Attenode demo-api v1"}
```

## A distinguishable v2 image for a later drift demo

Build a separate tag rather than replacing v1:

```bash
docker build --build-arg APP_VERSION=v2 -t attenode/demo-api:v2 demo/demo-api
```

The manifests intentionally keep v1 selected and use `IfNotPresent` for images
loaded into kind. There is no Kubernetes `APP_VERSION` override, so the API
reports the version baked into the image. Tags are suitable for this local demo;
a later verification workflow can select an image digest.

The multi-stage image installs locked development dependencies only in the
build stage. Its runtime contains compiled JavaScript and runs as the built-in
`node` user (UID 1000), directly under Node for signal handling. The Node 24
Alpine base tag follows maintenance updates; pin it to a digest when reproducible
base-image identity is needed.
