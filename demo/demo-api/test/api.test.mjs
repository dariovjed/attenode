import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApi } from "../dist/app.js";

for (const version of ["v1", "v2"]) {
  test(`API exposes ${version} and health`, async (t) => {
    const server = createApi(version);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}`;
    const root = await fetch(url);
    assert.equal(root.status, 200);
    assert.deepEqual(await root.json(), { service: "demo-api", version, message: `Hello from Attenode demo-api ${version}` });
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await fetch(`${url}/missing`)).status, 404);
    const post = await fetch(url, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET");
  });
}
