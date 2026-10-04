import type { EncodedAccount } from "gill";
import { decodeCredential, decodeSchema, SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS } from "sas-lib";
import { attenodeCredentialName } from "../attestations/sas-onchain.js";
import { deploymentSasSchema } from "../attestations/sas.js";

export const expectedIdentity = "GisnMiKvJUJfjCejzMbVCRpjcWvWWaFNUMokHaJmpr75";
export const expectedCredential = "JDdC4E6CXqcz3YWsCrzswFsTZe1Q29wGz9QEsZPtqiCY";
export class DiagnosticError extends Error {}
const credentialAccountDiscriminator = 0;
// Rust AccountSerialize::to_bytes prefixes Self::DISCRIMINATOR.
// Schema implements Discriminator using SchemaDiscriminator = 1:
// https://github.com/solana-foundation/solana-attestation-service/blob/master/program/src/state/discriminator.rs
// https://github.com/solana-foundation/solana-attestation-service/blob/master/program/src/state/schema.rs
// sas-lib@1.0.10's generated Schema enum ordinal is 2, and its u8 decoder
// does not validate the tag. Neither that ordinal nor instruction tags apply.
export const schemaAccountDiscriminator = 1;

export function verifyCredential(account: EncodedAccount): void {
  // Only explicitly selected public account fields may enter diagnostics.
  const mismatches: string[] = [];
  const check = (field: string, matches: boolean, actual: unknown, expected: unknown): void => {
    if (!matches) {
      mismatches.push(`${field}: decoded=${JSON.stringify(actual)}; expected=${JSON.stringify(expected)}`);
    }
  };
  check("owner", account.programAddress === SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,
    account.programAddress, SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS);
  check("executable", account.executable === false, account.executable, false);
  if (mismatches.length) {
    throw new DiagnosticError(`Credential verification failed: ${mismatches.join("; ")}`);
  }
  if (account.data[0] !== credentialAccountDiscriminator) {
    throw new DiagnosticError("Credential verification failed: invalid account discriminator");
  }
  const { data } = decodeCredential(account);
  check("discriminator", data.discriminator === credentialAccountDiscriminator,
    data.discriminator, credentialAccountDiscriminator);
  check("authority", data.authority === expectedIdentity, data.authority, expectedIdentity);
  // SAS decodes name as bytes. Keep exact byte equality, without trimming,
  // removing padding, or accepting replacement characters from UTF-8 decoding.
  const nameBytes = Buffer.from(data.name);
  const expectedNameBytes = Buffer.from(attenodeCredentialName, "utf8");
  check("name", nameBytes.equals(expectedNameBytes),
    { utf8: nameBytes.toString("utf8"), hex: nameBytes.toString("hex"), byteLength: nameBytes.length },
    { utf8: attenodeCredentialName, hex: expectedNameBytes.toString("hex"), byteLength: expectedNameBytes.length });
  check("authorizedSigners.length", data.authorizedSigners.length === 1,
    data.authorizedSigners.length, 1);
  check("authorizedSigners", data.authorizedSigners.length === 1 && data.authorizedSigners[0] === expectedIdentity,
    data.authorizedSigners, [expectedIdentity]);
  if (mismatches.length) {
    throw new DiagnosticError(`Credential verification failed: ${mismatches.join("; ")}`);
  }
}

export function verifySchema(account: EncodedAccount): void {
  if (account.programAddress !== SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS || account.executable !== false) {
    throw new DiagnosticError("Schema verification failed: incorrect owner or executable account");
  }
  if (account.data[0] !== schemaAccountDiscriminator) {
    throw new DiagnosticError("Schema verification failed: invalid account discriminator");
  }
  const { data } = decodeSchema(account);
  const mismatches: string[] = [];
  const check = (field: string, matches: boolean): void => {
    if (!matches) mismatches.push(field);
  };
  check("discriminator", data.discriminator === schemaAccountDiscriminator);
  check("Credential reference", data.credential === expectedCredential);
  for (const field of ["name", "description", "layout", "fieldNames"] as const) {
    check(field, Buffer.from(data[field]).equals(Buffer.from(deploymentSasSchema[field])));
  }
  check("version", data.version === deploymentSasSchema.version);
  check("isPaused", data.isPaused === false);
  if (mismatches.length) {
    throw new DiagnosticError(`Schema verification failed: mismatched ${mismatches.join(", ")}`);
  }
}
