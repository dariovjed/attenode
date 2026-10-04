import type { Address, TransactionSigner } from "gill";
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  getCreateAttestationInstruction,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
  type CreateAttestationInstructionDataArgs,
} from "sas-lib";

import type { DeploymentAttestation } from "./deployment.js";
import {
  deploymentSasFieldNames,
  deploymentSasSchema,
  serializeDeploymentSasAttestation,
} from "./sas.js";

export const attenodeCredentialName = "Attenode";

const textDecoder = new TextDecoder();
const schemaName = textDecoder.decode(deploymentSasSchema.name);
const schemaDescription = textDecoder.decode(deploymentSasSchema.description);

/** Offline derivation using the installed SAS program ID. */
export function deriveAttenodeCredentialPda(authority: Address) {
  return deriveCredentialPda({ authority, name: attenodeCredentialName });
}

/** The authority is also an authorized issuer; payer defaults to that signer. */
export async function buildAttenodeCredentialInstruction(input: {
  authority: TransactionSigner;
  payer?: TransactionSigner;
}) {
  const [credential, bump] = await deriveAttenodeCredentialPda(input.authority.address);
  const instruction = getCreateCredentialInstruction({
    payer: input.payer ?? input.authority,
    authority: input.authority,
    credential,
    name: attenodeCredentialName,
    signers: [input.authority.address],
  });
  return { credential, bump, instruction };
}

export function deriveDeploymentSchemaPda(input: {
  credential: Address;
  version: number;
}) {
  // The installed helper silently wraps numbers into a single seed byte.
  if (!Number.isInteger(input.version) || input.version < 0 || input.version > 255) {
    throw new RangeError("Schema version must be an integer from 0 to 255");
  }
  return deriveSchemaPda({ ...input, name: schemaName });
}

/**
 * version selects the PDA seed only: SAS 1.0.10 createSchema has no version arg.
 * The current initial V1 flow uses version 1; this helper keeps the seed explicit.
 */
export async function buildDeploymentSchemaInstruction(input: {
  authority: TransactionSigner;
  payer?: TransactionSigner;
  credential: Address;
  version: number;
}) {
  const [schema, bump] = await deriveDeploymentSchemaPda(input);
  const instruction = getCreateSchemaInstruction({
    payer: input.payer ?? input.authority,
    authority: input.authority,
    credential: input.credential,
    schema,
    name: schemaName,
    description: schemaDescription,
    layout: deploymentSasSchema.layout,
    fieldNames: [...deploymentSasFieldNames],
  });
  return { schema, bump, instruction };
}

export function deriveDeploymentAttestationPda(input: {
  credential: Address;
  schema: Address;
  nonce: Address;
}) {
  return deriveAttestationPda(input);
}

/** Constructs instruction data only; expiry semantics are supplied by the caller. */
export async function buildDeploymentAttestationInstruction(input: {
  authority: TransactionSigner;
  payer?: TransactionSigner;
  credential: Address;
  schema: Address;
  nonce: Address;
  expiry: CreateAttestationInstructionDataArgs["expiry"];
  deployment: DeploymentAttestation;
}) {
  const [attestation, bump] = await deriveDeploymentAttestationPda(input);
  const instruction = getCreateAttestationInstruction({
    payer: input.payer ?? input.authority,
    authority: input.authority,
    credential: input.credential,
    schema: input.schema,
    attestation,
    nonce: input.nonce,
    expiry: input.expiry,
    data: serializeDeploymentSasAttestation(input.deployment),
  });
  return { attestation, bump, instruction };
}
