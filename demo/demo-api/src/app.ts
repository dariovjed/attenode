import { createServer } from "node:http";

export function createApi(version = "v1") {
  return createServer((request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/") {
      response.end(JSON.stringify({ service: "demo-api", version, message: `Hello from Attenode demo-api ${version}` }));
    } else if (path === "/health") {
      response.end(JSON.stringify({ status: "ok" }));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ error: "Not found" }));
    }
  });
}
