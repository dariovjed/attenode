import { type Address, type EncodedAccount, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SOLANA_ERROR__ACCOUNTS__FAILED_TO_DECODE_ACCOUNT, SOLANA_ERROR__CODECS__INVALID_STRING_FOR_BASE, SOLANA_ERROR__ADDRESSES__INVALID_BASE58_ENCODED_ADDRESS, SOLANA_ERROR__ADDRESSES__STRING_LENGTH_OUT_OF_RANGE } from "gill";
import { safeDiagnostic, VerificationDiagnosticError, type SafeDiagnostic } from "../runtime/diagnostics.js";
import { createDevnetSolanaClient, fetchDevnetEncodedAccount } from "./devnet-rpc.js";

export interface SasAccountReader {
  account(address: Address): Promise<EncodedAccount | null>;
}

export function accountFetchDiagnostic(error: unknown): SafeDiagnostic {
  const safe = safeDiagnostic(error, "SAS_RPC");
  let code: unknown;
  let status: unknown;
  let causeCode: unknown;
  try {
    if (error !== null && typeof error === "object") {
      const record = error as { context?: { __code?: unknown; statusCode?: unknown }; code?: unknown; cause?: { code?: unknown } };
      code = record.context?.__code ?? record.code;
      if (code === SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) status = record.context?.statusCode;
      causeCode = record.cause?.code;
    }
  } catch { /* Inspect only allowlisted scalar categories. */ }
  const decoding = code === SOLANA_ERROR__ACCOUNTS__FAILED_TO_DECODE_ACCOUNT || code === SOLANA_ERROR__CODECS__INVALID_STRING_FOR_BASE;
  const addressInvalid = code === SOLANA_ERROR__ADDRESSES__INVALID_BASE58_ENCODED_ADDRESS || code === SOLANA_ERROR__ADDRESSES__STRING_LENGTH_OUT_OF_RANGE;
  const networkCode = causeCode ?? code;
  const transportCode = networkCode === "UND_ERR_INVALID_ARG" ? "SAS_RPC_LOCAL_REQUEST_REJECTED"
    : status === 429 ? "SAS_RPC_RATE_LIMITED"
    : [502, 503, 504].includes(status as number) ? "SAS_RPC_HTTP_UNAVAILABLE"
    : typeof status === "number" ? "SAS_RPC_HTTP_REJECTED"
    : ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(networkCode as string) ? "SAS_RPC_CONNECTION_RESET"
    : ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(networkCode as string) ? "SAS_RPC_TIMEOUT"
    : null;
  return new VerificationDiagnosticError(addressInvalid ? "SAS_SDK_ADDRESS_INVALID" : decoding ? "SAS_RPC_RESPONSE_DECODE_FAILED"
    : transportCode ?? (safe.code === "SAS_RPC_FAILED" ? "SAS_RPC_ACCOUNT_FETCH_FAILED" : safe.code),
  { operation: decoding ? "RESPONSE_DECODING" : "ACCOUNT_FETCH" }).diagnostic;
}

/** SDK response envelope validation only; SAS ownership/discriminators/payload are checked separately. */
export function validateEncodedAccountResponse(response: unknown, accountAddress: Address): EncodedAccount | null {
  try {
    if (!response || typeof response !== "object") throw new Error("Invalid response");
    const account = response as Record<string, unknown>;
    if (typeof account.exists !== "boolean" || account.address !== accountAddress) throw new Error("Invalid response");
    if (account.exists === false) return null;
    if (!(account.data instanceof Uint8Array) || typeof account.programAddress !== "string" ||
        typeof account.executable !== "boolean" || typeof account.lamports !== "bigint" || typeof account.space !== "bigint") throw new Error("Invalid response");
    return response as EncodedAccount;
  } catch { throw new VerificationDiagnosticError("SAS_RPC_RESPONSE_INVALID", { operation: "RESPONSE_DECODING" }); }
}

/** Public Devnet account reads only. No signer, wallet, transaction or default RPC configuration. */
export interface DevnetReaderDependencies {
  createClient(): Pick<ReturnType<typeof createDevnetSolanaClient>, "rpc">;
  fetchAccount(rpc: ReturnType<typeof createDevnetSolanaClient>["rpc"], accountAddress: Address, config: { commitment: "finalized"; abortSignal?: AbortSignal }): Promise<unknown>;
}
export interface SasReaderOptions { retryTransient?: boolean }
const retryable = new Set(["SAS_RPC_RATE_LIMITED", "SAS_RPC_TIMEOUT", "SAS_RPC_CONNECTION_RESET", "SAS_RPC_HTTP_UNAVAILABLE"]);
export function createDevnetSasReader(dependencies: DevnetReaderDependencies = {
  createClient: createDevnetSolanaClient, fetchAccount: fetchDevnetEncodedAccount,
}, options: SasReaderOptions = {}): SasAccountReader {
  let rpc: ReturnType<typeof createDevnetSolanaClient>["rpc"];
  try {
    rpc = dependencies.createClient().rpc;
    if (!rpc || typeof rpc.getAccountInfo !== "function") throw new Error("Invalid RPC client");
  } catch (error) {
    const safe = safeDiagnostic(error, "SAS_RPC");
    throw new VerificationDiagnosticError(safe.code === "SAS_RPC_FAILED" ? "SAS_RPC_INITIALIZATION_FAILED" : safe.code, { operation: "RPC_INITIALIZATION" });
  }
  // Monitor opt-in has a total ten-second budget, below its fifteen-second source watchdog.
  // Each attempt is awaited through settlement, even if a transport ignores cancellation.
  const deadline = Date.now() + 10_000;
  return {
    async account(accountAddress) {
      let response: unknown;
      for (let attempt = 0; ; attempt++) {
        const controller = options.retryTransient ? new AbortController() : null;
        const remaining = deadline - Date.now();
        if (controller && remaining <= 0) throw new VerificationDiagnosticError("SAS_RPC_TIMEOUT", { operation: "ACCOUNT_FETCH" });
        const timer = controller ? setTimeout(() => controller.abort(), Math.min(2000, remaining)) : undefined;
        let failure: SafeDiagnostic | null = null;
        try {
          response = await dependencies.fetchAccount(rpc, accountAddress, { commitment: "finalized", ...(controller ? { abortSignal: controller.signal } : {}) });
          if (controller?.signal.aborted) throw new VerificationDiagnosticError("SAS_RPC_TIMEOUT", { operation: "ACCOUNT_FETCH" });
        } catch (error) {
          failure = controller?.signal.aborted ? new VerificationDiagnosticError("SAS_RPC_TIMEOUT", { operation: "ACCOUNT_FETCH" }).diagnostic : accountFetchDiagnostic(error);
        } finally { clearTimeout(timer); }
        if (!failure) break;
        const delay = 250 * 2 ** attempt;
        if (!options.retryTransient || !retryable.has(failure.code) || attempt >= 2 || Date.now() + delay >= deadline) {
          throw new VerificationDiagnosticError(failure.code, failure);
        }
        await new Promise<void>(resolve => setTimeout(resolve, delay));
      }
      return validateEncodedAccountResponse(response, accountAddress);
    },
  };
}
