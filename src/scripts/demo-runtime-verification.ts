import { readFile } from "node:fs/promises";
import { approvedDemo, observedV1, observedV2 } from "../runtime/fixtures.js";
import { verifyRuntimeIdentity } from "../runtime/verification.js";

const args = process.argv.slice(2);
if (args.length === 0) {
  for (const [scenario, observed] of [["v1 approved + v1 observed", observedV1], ["v1 approved + v2 observed", observedV2]] as const) {
    console.log(JSON.stringify({ scenario, ...verifyRuntimeIdentity(approvedDemo, observed) }, null, 2));
  }
} else if (args.length === 1) {
  // Optional JSON fixture shape: { approved: {...}, observed: {...} }.
  const fixture: unknown = JSON.parse(await readFile(args[0]!, "utf8"));
  if (fixture === null || typeof fixture !== "object" || Array.isArray(fixture)) throw new Error("Expected a JSON fixture object");
  const { approved, observed } = fixture as Record<string, unknown>;
  console.log(JSON.stringify(verifyRuntimeIdentity(approved, observed), null, 2));
} else {
  throw new Error("Usage: npm run demo:runtime -- [fixture.json]");
}
