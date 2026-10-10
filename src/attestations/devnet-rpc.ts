import { createSolanaClient, fetchEncodedAccount, type Address } from "gill";

export const devnetRpcUrl = "https://api.devnet.solana.com";

/** Shared with the proven Devnet CLI; importing this module performs no I/O. */
export function createDevnetSolanaClient() {
  return createSolanaClient({ urlOrMoniker: devnetRpcUrl });
}
export function fetchDevnetEncodedAccount(
  rpc: ReturnType<typeof createDevnetSolanaClient>["rpc"], accountAddress: Address,
  config: { commitment: "confirmed" | "finalized" },
) {
  return fetchEncodedAccount(rpc, accountAddress, config);
}
