import assert from "node:assert/strict";
import { address, lamports, type Address, type EncodedAccount } from "gill";
import { KubeConfig } from "@kubernetes/client-node";
import { getAttestationEncoder, getCredentialEncoder, getSchemaEncoder, SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS } from "sas-lib";
import { diagnostic, safeDiagnostic, formatDiagnostic, VerificationDiagnosticError, type DiagnosticCode, type DiagnosticContext } from "../runtime/diagnostics.js";
import { runVerificationCli, type VerificationCliDependencies } from "../runtime/verification-cli.js";
import { createKubernetesReader } from "../runtime/kubernetes-client.js";
import { createLazyKubernetesReader } from "../runtime/kubernetes-loader.js";
import type { KubernetesReader } from "../runtime/kubernetes.js";
import { expectedCredential, expectedIdentity, schemaAccountDiscriminator } from "./devnet-schema-verification.js";
import { expectedSchema, attestationAccountDiscriminator } from "./devnet-attestation-demo.js";
import { createDemoApiExecution, demoApiNonce } from "./devnet-demo-api.js";
import { demoApiAttestationAddress } from "../attestations/sas-approval.js";
import { deploymentSasSchema, serializeDeploymentSasAttestation } from "../attestations/sas.js";

// Deliberately hostile synthetic text: never sourced from a real credential/configuration.
const sensitive = "SYNTHETIC_SECRET_DO_NOT_PRINT";
const external = (code?: string | number, statusCode?: number) => Object.assign(new Error(`https://user:${sensitive}@example.invalid/${sensitive}`), {
  code, statusCode, headers: { Authorization: sensitive }, body: sensitive, config: sensitive, context: { sensitive },
});
function noLeak(value: unknown) { assert.ok(!JSON.stringify(value).includes(sensitive)); }
for (const [error, stage, code] of [
  [external("ENOTFOUND"), "SAS_RPC", "SAS_RPC_UNREACHABLE"],
  [external("ETIMEDOUT"), "SAS_RPC", "SAS_RPC_TIMEOUT"],
  [external(undefined, 429), "SAS_RPC", "SAS_RPC_RATE_LIMITED"],
  [external(-32005), "SAS_RPC", "SAS_RPC_FAILED"], // Do not mislabel an arbitrary RPC code as rate limiting.
  [external(sensitive), "SAS_RPC", "SAS_RPC_FAILED"],
  [external("ENOENT"), "KUBERNETES_CLIENT", "KUBECONFIG_NOT_FOUND"],
  [external("EACCES"), "KUBERNETES_CLIENT", "KUBECONFIG_ACCESS_DENIED"],
  [external(undefined, 401), "KUBERNETES_OBSERVATION", "KUBERNETES_AUTHENTICATION_FAILED"],
  [external(undefined, 403), "KUBERNETES_OBSERVATION", "KUBERNETES_AUTHORIZATION_FAILED"],
  [external(403), "KUBERNETES_OBSERVATION", "KUBERNETES_AUTHORIZATION_FAILED"],
  [Object.assign(external(), { cause: external("ENOTFOUND") }), "SAS_RPC", "SAS_RPC_UNREACHABLE"],
  [external(undefined, 404), "KUBERNETES_OBSERVATION", "KUBERNETES_RESOURCE_NOT_FOUND"],
] as const) {
  const safe = safeDiagnostic(error, stage);
  assert.equal(safe.code, code);
  noLeak(safe);
  noLeak(formatDiagnostic(safe));
  assert.deepEqual(JSON.parse(formatDiagnostic(safe, true)), { error: safe });
}
const getters = Object.defineProperties({}, {
  code: { get() { throw external(); } }, status: { get() { throw external(); } },
  message: { get() { throw external(); } }, stack: { get() { throw external(); } },
});
assert.equal(safeDiagnostic(getters, "SAS_RPC").code, "SAS_RPC_FAILED");
const owned = new VerificationDiagnosticError("SAS_RPC_FAILED");
owned.message = sensitive;
owned.diagnostic.explanation = sensitive;
assert.deepEqual(safeDiagnostic(owned, "CLI_ARGUMENTS"), diagnostic("SAS_RPC_FAILED"));
noLeak(formatDiagnostic(owned.diagnostic));

const authority: Address = address(expectedIdentity), credential: Address = address(expectedCredential), schema: Address = address(expectedSchema);
const attestation: Address = address(demoApiAttestationAddress);
const { deployment, expiry } = createDemoApiExecution(Date.now());
const image = `ghcr.io/dariovjed/demo-api@${deployment.artifact.digest}`;
const encoded = (accountAddress: Address, data: EncodedAccount["data"]): EncodedAccount => ({ address: accountAddress,
  data, executable: false, programAddress: SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS, lamports: lamports(1n), space: BigInt(data.length) });
const accounts = new Map<Address, EncodedAccount>([
  [credential, encoded(credential, getCredentialEncoder().encode({ discriminator: 0, authority, name: Buffer.from("Attenode"), authorizedSigners: [authority] }))],
  [schema, encoded(schema, getSchemaEncoder().encode({ ...deploymentSasSchema, credential, discriminator: schemaAccountDiscriminator }))],
  [attestation, encoded(attestation, getAttestationEncoder().encode({ discriminator: attestationAccountDiscriminator, credential, schema, nonce: demoApiNonce,
    signer: authority, expiry, data: serializeDeploymentSasAttestation(deployment), tokenAccount: address("11111111111111111111111111111111") }))],
]);
const args = ["--sas", "--kubeconfig", "not-read-by-tests", "--context", "kind-attenode", "--namespace", "attenode-demo",
  "--deployment", "demo-api", "--container", "demo-api", "--image-repository", "ghcr.io/dariovjed/demo-api"];
const manual = ["--kubeconfig", "not-read-by-tests", "--namespace", "attenode-demo", "--deployment", "demo-api", "--container", "demo-api", "--approved-image", image];
let factoryCalls = 0;
const kube: KubernetesReader = {
  async deployment() { return { metadata: { namespace: "attenode-demo", name: "demo-api", uid: "dep", resourceVersion: "1" } }; },
  async replicaSets() { return [{ metadata: { namespace: "attenode-demo", name: "rs", uid: "rs", ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "demo-api", uid: "dep", controller: true }] } }]; },
  async pods() { return [{ metadata: { namespace: "attenode-demo", name: "pod", uid: "pod", ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "rs", uid: "rs", controller: true }] },
    spec: { containers: [{ name: "demo-api", image }] }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [{ name: "demo-api", image, imageID: image, ready: true, restartCount: 0, state: { running: {} } }] } }]; },
};
const dependencies: VerificationCliDependencies = {
  sasReader() { factoryCalls++; return { async account(accountAddress) { return accounts.get(accountAddress) ?? null; } }; },
  kubernetesReader() { factoryCalls++; return kube; },
};
let cases = 0;
// Dynamic loading is tested with injected modules: never import/load a real kubeconfig here.
const order: string[] = [];
const lazyDependencies: VerificationCliDependencies = {
  sasReader() {
    order.push("sas-initialize");
    return { async account(accountAddress) { order.push(`sas-account:${accountAddress}`); return accounts.get(accountAddress) ?? null; } };
  },
  kubernetesReader(path, context) {
    return createLazyKubernetesReader(path, context, async () => {
      order.push("kubernetes-import");
      await Promise.resolve();
      return { createKubernetesReader(receivedPath, receivedContext) {
        assert.equal(receivedPath, "not-read-by-tests");
        assert.equal(receivedContext, context);
        order.push("kubernetes-construct");
        return kube;
      } };
    });
  },
};
assert.deepEqual(order, []);
const lazySas = await runVerificationCli([...args, "--json"], lazyDependencies);
assert.equal(lazySas.exitCode, 0);
assert.equal(JSON.parse(lazySas.stdout!).sas.status, "VERIFIED");
assert.deepEqual(order, ["sas-initialize", ...[credential, schema, attestation].map(value => `sas-account:${value}`), "kubernetes-import", "kubernetes-construct"]);
order.length = 0;
assert.equal((await runVerificationCli(manual, lazyDependencies)).exitCode, 0);
assert.deepEqual(order, ["kubernetes-import", "kubernetes-construct"]);
order.length = 0;
assert.equal((await runVerificationCli(args, { ...lazyDependencies, sasReader() { throw external(); } })).exitCode, 1);
assert.deepEqual(order, []);
assert.equal((await runVerificationCli(args, { ...lazyDependencies, sasReader: () => ({ async account() { return null; } }) })).exitCode, 3);
assert.deepEqual(order, []);
for (const cliArgs of [args, manual]) {
  for (const phase of ["import", "construct"] as const) {
    const result = await runVerificationCli([...cliArgs, "--json"], { ...dependencies,
      kubernetesReader: (path, context) => createLazyKubernetesReader(path, context, async () => {
        if (phase === "import") throw external();
        return { createKubernetesReader() { throw external(); } };
      }),
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, undefined);
    assert.equal(JSON.parse(result.stderr!).error.stage, "KUBERNETES_CLIENT");
    noLeak(result);
    cases++;
  }
  const result = await runVerificationCli([...cliArgs, "--json"], { ...dependencies,
    kubernetesReader: (path, context) => createLazyKubernetesReader(path, context, async () => ({
      createKubernetesReader: () => ({ ...kube, async deployment() { throw external(); } }),
    })),
  });
  assert.equal(result.exitCode, 3);
  const observationReport = JSON.parse(result.stdout!);
  const observation = observationReport.kubernetes ?? observationReport;
  assert.equal(observation.result.status, "INDETERMINATE");
  assert.equal(observation.diagnostics[0].stage, "KUBERNETES_OBSERVATION");
  noLeak(result);
  cases++;
}
async function failure(cliArgs: string[], deps: VerificationCliDependencies, code: DiagnosticCode, context: DiagnosticContext = {}) {
  for (const json of [false, true]) {
    const result = await runVerificationCli([...cliArgs, ...(json ? ["--json"] : [])], deps);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, undefined);
    assert.ok(result.stderr?.includes(code));
    noLeak(result);
    if (json) assert.deepEqual(JSON.parse(result.stderr!), { error: { ...diagnostic(code), ...context } });
    else assert.ok(result.stderr?.includes("Action:"));
    cases++;
  }
}
factoryCalls = 0;
await failure(["--unknown", sensitive], dependencies, "CLI_ARGUMENTS_INVALID");
await failure([], dependencies, "CLI_ARGUMENTS_INVALID");
await failure([...args, "--sas"], dependencies, "CLI_ARGUMENTS_DUPLICATE");
await failure([...args, "--approved-image", sensitive], dependencies, "SAS_MANUAL_OVERRIDE");
await failure(args.map(arg => arg === "attenode-demo" ? "other" : arg), dependencies, "SAS_BINDING_UNSUPPORTED");
assert.equal(factoryCalls, 0); // Argument/binding failures occur before all I/O factories.
await failure(args, { ...dependencies, sasReader() { throw external("ENOTFOUND"); } }, "SAS_RPC_UNREACHABLE");
await failure(args, { ...dependencies, sasReader() { return { async account() { throw external(undefined, 429); } }; } }, "SAS_RPC_RATE_LIMITED", { accountKind: "CREDENTIAL" });
await failure(args, { ...dependencies, sasReader() { return { async account() { throw external(sensitive); } }; } }, "SAS_RPC_FAILED", { accountKind: "CREDENTIAL" });
await failure(args, { ...dependencies, kubernetesReader() { throw external("ENOENT"); } }, "KUBECONFIG_NOT_FOUND");
await failure(manual, { ...dependencies, kubernetesReader() { throw external("EACCES"); } }, "KUBECONFIG_ACCESS_DENIED");
await failure(args, { ...dependencies, kubernetesReader() { throw new VerificationDiagnosticError("KUBERNETES_CONTEXT_INVALID"); } }, "KUBERNETES_CONTEXT_INVALID");

for (const missing of [true, false]) {
  let kubeCalls = 0;
  const result = await runVerificationCli([...args, "--json"], { ...dependencies,
    sasReader() { return { async account(accountAddress) { return missing ? null : { ...accounts.get(accountAddress)!, executable: true }; } }; },
    kubernetesReader() { kubeCalls++; throw external(); },
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, undefined);
  assert.equal(kubeCalls, 0);
  const report = JSON.parse(result.stdout!);
  assert.equal(report.sas.diagnostic.stage, "SAS_ACCOUNT_VALIDATION");
  assert.equal(report.sas.diagnostic.code, missing ? "SAS_ACCOUNT_MISSING" : "SAS_CREDENTIAL_REJECTED");
  noLeak(result);
}
for (const accountAddress of [schema, attestation]) {
  const deps = { ...dependencies, sasReader() { return { async account(requested: Address) {
    const account = accounts.get(requested)!;
    return requested === accountAddress ? { ...account, executable: true } : account;
  } }; } };
  const result = await runVerificationCli([...args, "--json"], deps);
  assert.equal(result.exitCode, 3);
  assert.equal(JSON.parse(result.stdout!).sas.diagnostic.code, accountAddress === schema ? "SAS_SCHEMA_REJECTED" : "SAS_ATTESTATION_REJECTED");
}
for (const [status, code] of [[401, "KUBERNETES_AUTHENTICATION_FAILED"], [403, "KUBERNETES_AUTHORIZATION_FAILED"], [404, "KUBERNETES_RESOURCE_NOT_FOUND"], [500, "KUBERNETES_OBSERVATION_FAILED"]] as const) {
  for (const cliArgs of [args, manual]) {
    for (const json of [false, true]) {
      const result = await runVerificationCli([...cliArgs, ...(json ? ["--json"] : [])], { ...dependencies,
        kubernetesReader() { return { ...kube, async deployment() { throw external(status); } }; },
      });
      assert.equal(result.exitCode, 3); // Observation failures remain INDETERMINATE, not execution errors.
      assert.equal(result.stderr, undefined);
      assert.ok(result.stdout?.includes(code));
      noLeak(result);
      if (json) {
        const report = JSON.parse(result.stdout!);
        const diagnostics = report.kubernetes?.diagnostics ?? report.diagnostics;
        assert.deepEqual(diagnostics, [diagnostic(code)]);
      }
      cases++;
    }
  }
}
for (const cliArgs of [args, manual]) {
  const success = await runVerificationCli([...cliArgs, "--json"], dependencies);
  assert.equal(success.exitCode, 0);
  assert.equal(JSON.parse(success.stdout!).result.status, "VERIFIED");
  assert.equal(success.stderr, undefined);
}

// Exercise real setup error handling with loadFromFile replaced: no file is ever opened.
const originalLoad = KubeConfig.prototype.loadFromFile;
try {
  for (const [error, code] of [[external("ENOENT"), "KUBECONFIG_NOT_FOUND"], [external("EPERM"), "KUBECONFIG_ACCESS_DENIED"], [external(), "KUBECONFIG_LOAD_FAILED"]] as const) {
    KubeConfig.prototype.loadFromFile = () => { throw error; };
    assert.throws(() => createKubernetesReader("not-read-by-tests", "kind-attenode"), (failure: unknown) => {
      const safe = safeDiagnostic(failure, "KUBERNETES_CLIENT");
      assert.equal(safe.code, code);
      noLeak(safe);
      return true;
    });
  }
  KubeConfig.prototype.loadFromFile = () => {};
  assert.throws(() => createKubernetesReader("not-read-by-tests", "missing"), (failure: unknown) => {
    assert.equal(safeDiagnostic(failure, "KUBERNETES_CLIENT").code, "KUBERNETES_CONTEXT_INVALID");
    return true;
  });
} finally { KubeConfig.prototype.loadFromFile = originalLoad; }
console.log(`Verification diagnostics offline tests: PASS (${cases} CLI failure scenarios plus sanitization, all six stages, mock client setup and exit-code preservation)`);
