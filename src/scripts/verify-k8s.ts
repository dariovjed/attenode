import { createLazyKubernetesReader } from "../runtime/kubernetes-loader.js";
import { createDevnetSasReader } from "../attestations/sas-reader.js";
import { runVerificationCli } from "../runtime/verification-cli.js";

const result = await runVerificationCli(process.argv.slice(2), {
  sasReader: createDevnetSasReader,
  kubernetesReader: createLazyKubernetesReader,
});
if (result.stdout !== undefined) console.log(result.stdout);
if (result.stderr !== undefined) console.error(result.stderr);
process.exitCode = result.exitCode;
