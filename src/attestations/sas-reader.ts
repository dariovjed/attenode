import { type Address, type EncodedAccount, SOLANA_ERROR__ACCOUNTS__FAILED_TO_DECODE_ACCOUNT, SOLANA_ERROR__CODECS__INVALID_STRING_FOR_BASE, SOLANA_ERROR__ADDRESSES__INVALID_BASE58_ENCODED_ADDRESS, SOLANA_ERROR__ADDRESSES__STRING_LENGTH_OUT_OF_RANGE } from "gill";
import { safeDiagnostic, VerificationDiagnosticError, type SafeDiagnostic } from "../runtime/diagnostics.js";
import { createDevnetSolanaClient, fetchDevnetEncodedAccount } from "./devnet-rpc.js";

export interface SasAccountReader {
  account(address: Address): Promise<EncodedAccount | null>;
}

export function accountFetchDiagnostic(error: unknown): SafeDiagnostic {
  const safe = safeDiagnostic(error, "SAS_RPC");
  let code: unknown;
  try {
    if (error !== null && typeof error === "object") {
      const record = error as { context?: { __code?: unknown }; code?: unknown };
      code = record.context?.__code ?? record.code;
    }
  } catch { /* Inspect only allowlisted scalar categories. */ }
  const decoding = code === SOLANA_ERROR__ACCOUNTS__FAILED_TO_DECODE_ACCOUNT || code === SOLANA_ERROR__CODECS__INVALID_STRING_FOR_BASE;
  const addressInvalid = code === SOLANA_ERROR__ADDRESSES__INVALID_BASE58_ENCODED_ADDRESS || code === SOLANA_ERROR__ADDRESSES__STRING_LENGTH_OUT_OF_RANGE;
  return new VerificationDiagnosticError(addressInvalid ? "SAS_SDK_ADDRESS_INVALID" : decoding ? "SAS_RPC_RESPONSE_DECODE_FAILED"
    : safe.code === "SAS_RPC_FAILED" ? "SAS_RPC_ACCOUNT_FETCH_FAILED" : safe.code,
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
  fetchAccount(rpc: ReturnType<typeof createDevnetSolanaClient>["rpc"], accountAddress: Address, config: { commitment: "finalized" }): Promise<unknown>;
}
export function createDevnetSasReader(dependencies: DevnetReaderDependencies = {
  createClient: createDevnetSolanaClient, fetchAccount: fetchDevnetEncodedAccount,
}): SasAccountReader {
  let rpc: ReturnType<typeof createDevnetSolanaClient>["rpc"];
  try {
    rpc = dependencies.createClient().rpc;
    if (!rpc || typeof rpc.getAccountInfo !== "function") throw new Error("Invalid RPC client");
  } catch (error) {
    const safe = safeDiagnostic(error, "SAS_RPC");
    throw new VerificationDiagnosticError(safe.code === "SAS_RPC_FAILED" ? "SAS_RPC_INITIALIZATION_FAILED" : safe.code, { operation: "RPC_INITIALIZATION" });
  }
  return {
    async account(accountAddress) {
      let response: unknown;
      try { response = await dependencies.fetchAccount(rpc, accountAddress, { commitment: "finalized" }); }
      catch (error) {
        const safe = accountFetchDiagnostic(error);
        throw new VerificationDiagnosticError(safe.code, safe);
      }
      return validateEncodedAccountResponse(response, accountAddress);
    },
  };
}
