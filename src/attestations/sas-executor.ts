import {
  fetchEncodedAccount, getSignatureFromTransaction, signTransactionMessageWithSigners,
  type Address, type Signature, type SolanaClient,
} from "gill";
import { validateDeploymentAttestation } from "./deployment.js";
import {
  deriveAttenodeCredentialPda, deriveDeploymentSchemaPda, deriveDeploymentAttestationPda,
} from "./sas-onchain.js";
import {
  buildCreateCredentialTransaction, buildCreateDeploymentSchemaTransaction,
  buildCreateDeploymentAttestationTransaction, type SasTransactionDependencies,
} from "./sas-transactions.js";

type Message = Awaited<ReturnType<typeof buildCreateCredentialTransaction>>["transaction"];
export type SasExecutionInput = Parameters<typeof buildCreateDeploymentAttestationTransaction>[1];
export type SasExecutionDependencies = Omit<SasTransactionDependencies, "latestBlockhash"> & {
  transport: SasExecutionTransport;
};
export interface SasExecutionTransport {
  accountExists(address: Address): Promise<boolean>;
  getLatestBlockhash(): Promise<SasTransactionDependencies["latestBlockhash"]>;
  /** Resolve only after confirmed success; reject on submission/confirmation failure. */
  submitAndConfirm(message: Message, onAttempt: (signature: Signature) => void): Promise<Signature>;
}
export type SasOperationResult = {
  pda: Address;
  status: "pending" | "already-existed" | "created" | "collision" | "failed";
  signature?: Signature;
  confirmation: "not-submitted" | "unknown" | "confirmed";
};
export type SasExecutionResult = Record<"credential" | "schema" | "attestation", SasOperationResult>;
export class SasExecutionError extends Error {
  constructor(
    message: string,
    public readonly operation: keyof SasExecutionResult,
    public readonly results: SasExecutionResult,
    cause?: unknown,
  ) { super(message, { cause }); }
}

/** No I/O occurs until the returned transport's methods are explicitly invoked. */
export function createGillSasExecutionTransport(
  client: Pick<SolanaClient, "rpc" | "sendAndConfirmTransaction">,
): SasExecutionTransport {
  return {
    async accountExists(address) {
      return (await fetchEncodedAccount(client.rpc, address, { commitment: "confirmed" })).exists;
    },
    async getLatestBlockhash() {
      return (await client.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
    },
    async submitAndConfirm(message, onAttempt) {
      const signed = await signTransactionMessageWithSigners(message);
      const signature = getSignatureFromTransaction(signed);
      // Preserve the attempted signature if sending or confirmation subsequently fails.
      // An attempt is not proof the RPC accepted or landed the transaction.
      onAttempt(signature);
      return client.sendAndConfirmTransaction(signed, { commitment: "confirmed" });
    },
  };
}

/** Explicit execution entry point. Importing this module never starts execution. */
export async function executeDeploymentV1(
  dependencies: SasExecutionDependencies,
  input: Omit<SasExecutionInput, "credential" | "schema">,
): Promise<SasExecutionResult> {
  validateDeploymentAttestation(input.deployment);
  if ((typeof input.expiry === "number" && !Number.isSafeInteger(input.expiry)) ||
      BigInt(input.expiry) < -(2n ** 63n) || BigInt(input.expiry) >= 2n ** 63n) {
    throw new RangeError("expiry must be an explicit i64 Unix timestamp in seconds");
  }
  const [credential] = await deriveAttenodeCredentialPda(dependencies.authority.address);
  const [schema] = await deriveDeploymentSchemaPda({ credential, version: 1 });
  const [attestation] = await deriveDeploymentAttestationPda({ credential, schema, nonce: input.nonce });
  const results: SasExecutionResult = {
    credential: { pda: credential, status: "pending", confirmation: "not-submitted" },
    schema: { pda: schema, status: "pending", confirmation: "not-submitted" },
    attestation: { pda: attestation, status: "pending", confirmation: "not-submitted" },
  };
  const transport = dependencies.transport;
  let operation: keyof SasExecutionResult = "attestation";
  try {
    // Fail before bootstrap side effects if this nonce has already been used.
    if (await transport.accountExists(attestation)) {
      results.attestation.status = "collision";
      throw new SasExecutionError("Attestation already exists: nonce has already been used", operation, results);
    }
    for (operation of ["credential", "schema", "attestation"] as const) {
      const result = results[operation];
      if (await transport.accountExists(result.pda)) {
        if (operation === "attestation") {
          result.status = "collision";
          throw new SasExecutionError("Attestation already exists: nonce has already been used", operation, results);
        }
        result.status = "already-existed";
        continue;
      }
      const latestBlockhash = await transport.getLatestBlockhash();
      const construction = { ...dependencies, latestBlockhash };
      const built = operation === "credential"
        ? await buildCreateCredentialTransaction(construction)
        : operation === "schema"
          ? await buildCreateDeploymentSchemaTransaction(construction, { credential })
          : await buildCreateDeploymentAttestationTransaction(construction, { ...input, credential, schema });
      const signature = await transport.submitAndConfirm(built.transaction, (attemptedSignature) => {
        result.signature = attemptedSignature;
        result.confirmation = "unknown";
      });
      result.signature = signature;
      result.confirmation = "confirmed";
      result.status = "created";
    }
    return results;
  } catch (cause) {
    if (cause instanceof SasExecutionError) throw cause;
    results[operation].status = "failed";
    throw new SasExecutionError(`SAS ${operation} execution failed`, operation, results, cause);
  }
}
