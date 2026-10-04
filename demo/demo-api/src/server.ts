import { createApi } from "./app.js";

const port = Number(process.env.PORT ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer from 1 to 65535");
}
const server = createApi(process.env.APP_VERSION ?? "v1");
server.listen(port, "0.0.0.0", () => console.log(`demo-api listening on port ${port}`));
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
