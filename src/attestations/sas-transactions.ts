import {
  createTransaction,
  type Instruction,
  type TransactionMessageWithBlockhashLifetime,
  type TransactionSigner,
} from "gill";
import {
  buildAttenodeCredentialInstruction,
  buildDeploymentSchemaInstruction,
  buildDeploymentAttestationInstruction,
} from "./sas-onchain.js";

export type SasTransactionDependencies = {
  authority: TransactionSigner;
  /** Pays both account creation and transaction fees; defaults to authority. */
  payer?: TransactionSigner;
  /** Supplied by the caller, from a future injected RPC client or an offline fixture. */
  latestBlockhash: TransactionMessageWithBlockhashLifetime["lifetimeConstraint"];
};

// No client or URL is created here. RPC access belongs to a future caller that
// injects latestBlockhash; construction itself is entirely offline and unsigned.
function constructTransaction(dependencies: SasTransactionDependencies, instruction: Instruction) {
  return createTransaction({
    version: "legacy",
    feePayer: dependencies.payer ?? dependencies.authority,
    instructions: [instruction],
    latestBlockhash: dependencies.latestBlockhash,
  });
}

export async function buildCreateCredentialTransaction(dependencies: SasTransactionDependencies) {
  const built = await buildAttenodeCredentialInstruction(dependencies);
  return { ...built, transaction: constructTransaction(dependencies, built.instruction) };
}

export async function buildCreateDeploymentSchemaTransaction(
  dependencies: SasTransactionDependencies,
  input: Pick<Parameters<typeof buildDeploymentSchemaInstruction>[0], "credential">,
) {
  const built = await buildDeploymentSchemaInstruction({ ...dependencies, ...input, version: 1 });
  return { ...built, transaction: constructTransaction(dependencies, built.instruction) };
}

export async function buildCreateDeploymentAttestationTransaction(
  dependencies: SasTransactionDependencies,
  input: Pick<Parameters<typeof buildDeploymentAttestationInstruction>[0],
    "credential" | "schema" | "nonce" | "expiry" | "deployment">,
) {
  const built = await buildDeploymentAttestationInstruction({ ...dependencies, ...input });
  return { ...built, transaction: constructTransaction(dependencies, built.instruction) };
}

/** Returns three separate unsigned messages in dependency order; never executes them. */
export async function buildDeploymentV1TransactionSequence(
  dependencies: SasTransactionDependencies,
  input: Pick<Parameters<typeof buildDeploymentAttestationInstruction>[0], "nonce" | "expiry" | "deployment">,
) {
  const credential = await buildCreateCredentialTransaction(dependencies);
  const schema = await buildCreateDeploymentSchemaTransaction(dependencies, {
    credential: credential.credential,
  });
  const attestation = await buildCreateDeploymentAttestationTransaction(dependencies, {
    ...input, credential: credential.credential, schema: schema.schema,
  });
  return { credential, schema, attestation };
}
