/**
 * Client-side banking-profile commitment hashing.
 *
 * The escrow contract stores only a 32-byte `profile_hash: BytesN<32>`
 * commitment to a beneficiary's banking coordinates. This module turns an
 * off-chain {@link BankingProfile} into that commitment locally, so raw IBANs
 * and account numbers never reach a Soroban RPC endpoint or the ledger.
 *
 * ## Canonical serialization
 *
 * Profiles are serialized with fixed-order, labelled fields separated by
 * `" / "`:
 *
 * ```text
 * IBAN: DE89370400440532013000 / BIC: COBADEFFXXX
 * ```
 *
 * Fields absent from the profile are omitted, and only the identifying fields
 * that are present appear. The order is always `IBAN`, `BIC`, `ACCOUNT`,
 * `BANK_CODE`, independent of property order on the input object. Text is
 * trimmed, whitespace inside each value is removed, and values are uppercased
 * before hashing, so `"de89 3704 0044 0532 0130 00"` and
 * `"DE89370400440532013000"` produce the same commitment.
 *
 * The serialization is deliberately stable: the pinned vector
 * `IBAN: DE89370400440532013000 / BIC: COBADEFFXXX` reproduces the on-chain
 * `profile_hash` `e0a9e37d…` recorded for escrow #3 on Stellar Testnet (see
 * `evidence/testnet-verified-2026-10-05.md`). Any change to field ordering,
 * labels, or normalization breaks reconciliation with existing on-chain
 * commitments, so treat this format as frozen.
 *
 * @packageDocumentation
 */

import { createHash } from "crypto";

/**
 * Beneficiary banking coordinates committed to on-chain.
 *
 * At least one of {@link BankingProfile.iban} or
 * {@link BankingProfile.accountNumber} is required. Every supplied value is
 * normalized and validated by {@link canonicalizeBankingProfile} before it is
 * hashed.
 */
export interface BankingProfile {
  /** International Bank Account Number, such as `DE89370400440532013000`. */
  iban?: string;
  /** Bank Identifier Code (SWIFT/BIC) for the IBAN's bank, such as `COBADEFFXXX`. */
  bic?: string;
  /** Domestic bank account number, used when no IBAN is available. */
  accountNumber?: string;
  /** Domestic bank or branch code that routes {@link BankingProfile.accountNumber}. */
  bankCode?: string;
}

/** Length of a SHA-256 digest in bytes, matching the contract's `BytesN<32>`. */
const PROFILE_HASH_BYTES = 32;

/** Fixed field order used by the canonical serialization. */
const FIELD_ORDER = ["iban", "bic", "accountNumber", "bankCode"] as const;

type BankingProfileField = (typeof FIELD_ORDER)[number];

/** Labels emitted for each field in the canonical serialization. */
const FIELD_LABELS: Record<BankingProfileField, string> = {
  iban: "IBAN",
  bic: "BIC",
  accountNumber: "ACCOUNT",
  bankCode: "BANK_CODE",
};

/**
 * Matches a normalized IBAN: two country letters, two check digits, then 11 to
 * 30 alphanumeric characters (15 to 34 characters total).
 */
const IBAN_PATTERN = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/;

/**
 * Matches a normalized BIC: four bank letters, two country letters, two
 * location characters, and an optional three-character branch suffix.
 */
const BIC_PATTERN = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;

/** Matches a normalized domestic account number of 1 to 34 characters. */
const ACCOUNT_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,33}$/;

/** Matches a normalized domestic bank or branch code of 1 to 16 characters. */
const BANK_CODE_PATTERN = /^[A-Z0-9]{1,16}$/;

/**
 * Removes all whitespace from a value.
 *
 * @param value - Value to compact.
 * @returns The value without any whitespace characters.
 */
function compact(value: string): string {
  return value.replace(/\s+/g, "");
}

/**
 * Validates that an optional profile field is a non-empty string.
 *
 * @param value - Field value supplied by the caller.
 * @param field - Human-readable field name used in error messages.
 * @returns The trimmed, non-empty value.
 * @throws {Error} If the value is not a string or contains only whitespace.
 */
function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Banking profile field "${field}" must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error(`Banking profile field "${field}" cannot be empty`);
  }
  return trimmed;
}

/**
 * Normalizes and validates an IBAN.
 *
 * @param value - Raw IBAN, possibly lowercase or grouped with spaces.
 * @param field - Human-readable field name used in error messages.
 * @returns Uppercase IBAN without whitespace.
 * @throws {Error} If the IBAN does not match the canonical format.
 */
function normalizeIban(value: unknown, field: string): string {
  const iban = compact(requireNonEmptyString(value, field)).toUpperCase();
  if (!IBAN_PATTERN.test(iban)) {
    throw new Error(
      `Banking profile field "${field}" is not a valid IBAN: ${String(value)}`
    );
  }
  return iban;
}

/**
 * Normalizes and validates a BIC (SWIFT code).
 *
 * @param value - Raw BIC, possibly lowercase or padded with spaces.
 * @param field - Human-readable field name used in error messages.
 * @returns Uppercase 8- or 11-character BIC.
 * @throws {Error} If the BIC is not 8 or 11 alphanumeric characters in the
 *   expected layout.
 */
function normalizeBic(value: unknown, field: string): string {
  const bic = compact(requireNonEmptyString(value, field)).toUpperCase();
  if (!BIC_PATTERN.test(bic)) {
    throw new Error(
      `Banking profile field "${field}" is not a valid BIC: ${String(value)}`
    );
  }
  return bic;
}

/**
 * Normalizes and validates a domestic bank account number.
 *
 * @param value - Raw account number, possibly lowercase or grouped with
 *   spaces.
 * @param field - Human-readable field name used in error messages.
 * @returns Uppercase account number without whitespace.
 * @throws {Error} If the account number contains unsupported characters or is
 *   longer than 34 characters.
 */
function normalizeAccountNumber(value: unknown, field: string): string {
  const accountNumber = compact(requireNonEmptyString(value, field)).toUpperCase();
  if (!ACCOUNT_NUMBER_PATTERN.test(accountNumber)) {
    throw new Error(
      `Banking profile field "${field}" is not a valid account number: ${String(value)}`
    );
  }
  return accountNumber;
}

/**
 * Normalizes and validates a domestic bank or branch code.
 *
 * @param value - Raw bank code, possibly lowercase or padded with spaces.
 * @param field - Human-readable field name used in error messages.
 * @returns Uppercase bank code without whitespace.
 * @throws {Error} If the bank code contains unsupported characters or is
 *   longer than 16 characters.
 */
function normalizeBankCode(value: unknown, field: string): string {
  const bankCode = compact(requireNonEmptyString(value, field)).toUpperCase();
  if (!BANK_CODE_PATTERN.test(bankCode)) {
    throw new Error(
      `Banking profile field "${field}" is not a valid bank code: ${String(value)}`
    );
  }
  return bankCode;
}

/**
 * Applies the normalizer for a single profile field.
 *
 * @param field - Field being normalized.
 * @param value - Raw field value.
 * @returns The normalized value.
 * @throws {Error} If the value is invalid for the field.
 */
function normalizeField(field: BankingProfileField, value: unknown): string {
  switch (field) {
    case "iban":
      return normalizeIban(value, field);
    case "bic":
      return normalizeBic(value, field);
    case "accountNumber":
      return normalizeAccountNumber(value, field);
    case "bankCode":
      return normalizeBankCode(value, field);
  }
}

/**
 * Serializes a banking profile into the canonical preimage that is hashed
 * on-chain.
 *
 * The returned string uses fixed-order, uppercase field labels separated by
 * `" / "`; absent fields are omitted. It must never be logged or persisted,
 * because it contains the raw banking coordinates it is meant to protect.
 *
 * @param profile - Banking coordinates to serialize.
 * @returns The canonical preimage, such as
 *   `"IBAN: DE89370400440532013000 / BIC: COBADEFFXXX"`.
 * @throws {Error} If the profile is not an object, contains unsupported
 *   fields, omits every identifying field, pairs a BIC with no IBAN, pairs a
 *   bank code with no account number, or contains a malformed value.
 *
 * @example
 * ```ts
 * const preimage = canonicalizeBankingProfile({
 *   iban: "de89 3704 0044 0532 0130 00",
 *   bic: "COBADEFFXXX",
 * });
 * // "IBAN: DE89370400440532013000 / BIC: COBADEFFXXX"
 * ```
 */
export function canonicalizeBankingProfile(profile: BankingProfile): string {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("Banking profile must be an object");
  }

  const unsupported = Object.keys(profile).filter(
    (key) => !(FIELD_ORDER as readonly string[]).includes(key)
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported banking profile field(s): ${unsupported.sort().join(", ")}`
    );
  }

  const parts: string[] = [];
  let hasIban = false;
  let hasAccountNumber = false;
  let hasBic = false;
  let hasBankCode = false;

  for (const field of FIELD_ORDER) {
    const value = profile[field];
    if (value === undefined) {
      continue;
    }
    const normalized = normalizeField(field, value);
    parts.push(`${FIELD_LABELS[field]}: ${normalized}`);
    if (field === "iban") hasIban = true;
    else if (field === "accountNumber") hasAccountNumber = true;
    else if (field === "bic") hasBic = true;
    else hasBankCode = true;
  }

  if (!hasIban && !hasAccountNumber) {
    throw new Error(
      "Banking profile must include an iban or an accountNumber"
    );
  }
  if (hasBic && !hasIban) {
    throw new Error("Banking profile field \"bic\" requires an iban");
  }
  if (hasBankCode && !hasAccountNumber) {
    throw new Error(
      "Banking profile field \"bankCode\" requires an accountNumber"
    );
  }

  return parts.join(" / ");
}

/**
 * Computes a 32-byte SHA-256 commitment to a beneficiary banking profile.
 *
 * The digest is what {@link EscrowGateClient.buildCreateEscrowTx} expects as
 * `profileHashHex`, encoded as `BytesN<32>`. Hashing happens entirely in the
 * caller's process; no network request is made.
 *
 * @param profile - Banking coordinates to commit to.
 * @returns The fresh 32-byte SHA-256 digest as a `Uint8Array`.
 * @throws {Error} If {@link canonicalizeBankingProfile} rejects the profile.
 *
 * @example
 * ```ts
 * const digest = hashBankingProfile({
 *   iban: "DE89370400440532013000",
 *   bic: "COBADEFFXXX",
 * });
 * // Uint8Array(32) [0xe0, 0xa9, 0xe3, ...]
 * ```
 */
export function hashBankingProfile(profile: BankingProfile): Uint8Array {
  const canonical = canonicalizeBankingProfile(profile);
  const digest = createHash("sha256").update(canonical, "utf8").digest();
  return new Uint8Array(digest);
}

/**
 * Formats a profile-hash digest as canonical lowercase hexadecimal.
 *
 * The contract and relay exchange `profile_hash` as a 64-character lowercase
 * hex string, so this helper is the boundary between the `Uint8Array` returned
 * by {@link hashBankingProfile} and the values consumed by
 * {@link EscrowCreateParams.profileHashHex} and decoded escrow records.
 *
 * @param hash - Digest to format, exactly 32 bytes.
 * @returns 64 lowercase hexadecimal characters.
 * @throws {Error} If the value is not a `Uint8Array` or is not 32 bytes long.
 */
export function formatBankingProfileHash(hash: Uint8Array): string {
  if (!(hash instanceof Uint8Array)) {
    throw new Error("Profile hash must be a Uint8Array");
  }
  if (hash.length !== PROFILE_HASH_BYTES) {
    throw new Error(
      `Profile hash must be exactly 32 bytes (got ${hash.length})`
    );
  }
  let hex = "";
  for (const byte of hash) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Computes a banking profile commitment as canonical 64-character hex.
 *
 * Convenience wrapper that combines {@link hashBankingProfile} with
 * {@link formatBankingProfileHash} for callers that pass the hash straight to
 * the contract client.
 *
 * @param profile - Banking coordinates to commit to.
 * @returns Lowercase SHA-256 digest, 64 hexadecimal characters.
 * @throws {Error} If the profile is invalid.
 *
 * @example
 * ```ts
 * const profileHashHex = hashBankingProfileHex({
 *   iban: "DE89370400440532013000",
 *   bic: "COBADEFFXXX",
 * });
 * // "e0a9e37d5cb17ded767cf3b2c5a6b12b58403f1a92c909f8555f9c93e18d91e4"
 * ```
 */
export function hashBankingProfileHex(profile: BankingProfile): string {
  return formatBankingProfileHash(hashBankingProfile(profile));
}
