import { createServer } from "node:http";
import { createDevnetSasReader } from "../../src/attestations/sas-reader.js";
import { createMonitorDevnetSasReader } from "../../src/attestations/monitor-rpc.js";
import { createLazyKubernetesReader } from "../../src/runtime/kubernetes-loader.js";
import { readMonitorConfig } from "./config.js";
import { monitorVerifier, TrustMonitor } from "./monitor.js";
import { monitorHandler } from "./http.js";
import { runMonitorSasComparison, traceScheduledSources, type DiagnosticSink } from "./sas-comparison.js";

try {
  const config = readMonitorConfig(process.env);
  const sources = monitorVerifier(config, { sasReader: createMonitorDevnetSasReader, kubernetesReader: createLazyKubernetesReader });
  const diagnosticEnabled = process.env.ATTENODE_DIAGNOSE_SAS === "1";
  const sink: DiagnosticSink = record => console.error(JSON.stringify(record));
  const monitor = new TrustMonitor(diagnosticEnabled ? traceScheduledSources(sources, sink) : sources, config);
  let stopping = false;
  const server = createServer(monitorHandler(monitor, config.allowedOrigin));
  server.on("error", () => {
    console.error("MONITOR_HTTP_FAILED: local HTTP server could not start or continue.");
    monitor.stop(); process.exitCode = 1;
  });
  server.listen(config.port, "127.0.0.1", () => {
    console.log(`Attenode monitor: http://127.0.0.1:${config.port}`);
    if (!diagnosticEnabled) monitor.start();
    else {
      void runMonitorSasComparison({ plainReader: createDevnetSasReader,
        retryReader: () => createDevnetSasReader(undefined, { retryTransient: true }),
        fixedReader: createMonitorDevnetSasReader, kubernetes: sources.kubernetes }, sink)
        .then(() => { if (!stopping) monitor.start(); });
    }
  });
  const stop = () => { stopping = true; monitor.stop(); server.close(); server.closeAllConnections(); process.exit(0); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
} catch {
  console.error("MONITOR_CONFIGURATION_INVALID: check required ATTENODE_* settings, local origin/port and supported demo-api policy.");
  process.exitCode = 1;
}
