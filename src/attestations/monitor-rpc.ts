import { createSolanaRpcFromTransport, SolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from "gill";
import { devnetRpcUrl, fetchDevnetEncodedAccount } from "./devnet-rpc.js";
import { parseJsonWithBigInts, stringifyJsonWithBigInts } from "@solana/rpc-spec-types";
import { createDevnetSasReader, type DevnetReaderDependencies } from "./sas-reader.js";

/** Monitor-only transport: Node fetch must generate Content-Length itself.
 * Gill's installed HTTP transport supplies it explicitly, which Node 24 duplicates
 * before the installed Undici 8 dispatcher rejects the request locally.
 * Retain SDK JSON-bigint serialization and RPC response transformation.
 */
export function createMonitorDevnetRpc(fetchRequest: typeof fetch = globalThis.fetch) {
  return createSolanaRpcFromTransport(async <TResponse>({ payload, signal }: { payload: unknown; signal?: AbortSignal }): Promise<TResponse> => {
    const response = await fetchRequest(devnetRpcUrl, { method: "POST", signal,
      headers: { accept: "application/json", "content-type": "application/json; charset=utf-8" },
      body: stringifyJsonWithBigInts(payload),
    });
    if (!response.ok) throw new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
      statusCode: response.status, headers: response.headers, message: "RPC HTTP failure",
    });
    return parseJsonWithBigInts(await response.text()) as TResponse;
  });
}

export function createMonitorDevnetSasReader() {
  return createDevnetSasReader({
    createClient: () => ({ rpc: createMonitorDevnetRpc() }) as ReturnType<DevnetReaderDependencies["createClient"]>,
    fetchAccount: fetchDevnetEncodedAccount,
  }, { retryTransient: true });
}
