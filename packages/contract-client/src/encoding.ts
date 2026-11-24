/**
 * Strict, type-safe Soroban `ScVal` codecs for escrow-domain structs.
 *
 * Soroban's generic `nativeToScVal`/`scValToNative` helpers convert JavaScript
 * values structurally: a string becomes an `scvString` (not an `Address`), a
 * `number` becomes the smallest integer type that fits, and a plain object
 * becomes a map without any schema validation. Contract clients therefore have
 * to encode every field explicitly, or invalid input silently reaches the RPC
 * layer and fails later with a cryptic `HostError`.
 *
 * This module provides the explicit codecs instead:
 *
 * - {@link escrowToScVal} / {@link scValToEscrow} — the contract's
 *   `EscrowRecord` (`payer`, `beneficiary`, `token`, `amount`, `profile_hash`,
 *   `status`, `unlock_timestamp`).
 * - {@link feeConfigToScVal} / {@link scValToFeeConfig} — protocol fee
 *   configuration (`fee_bps`, `treasury`, `max_fee`, optional `min_fee`).
 * - {@link disputeRecordToScVal} / {@link scValToDisputeRecord} — dispute
 *   records (`escrow_id`, `raised_by`, `reason_hash`, shares, optional
 *   resolution metadata, and a `Vec<BytesN<32>>` of evidence hashes).
 *
 * Every encoder validates before it serializes:
 *
 * - Addresses must be canonical `G...` account or `C...` contract StrKeys with
 *   no surrounding whitespace.
 * - `BytesN<32>` fields must be exactly 64 hexadecimal characters; anything
 *   else (short values, `0x` prefixes, separators, non-hex text) is rejected.
 * - Integers must be JavaScript `bigint`s inside the field's declared width
 *   (`i128`, `u128`, `u64`) or an integer `number` for `u32`.
 * - Basis points must lie in `0..=10_000`, and fee basis points in
 *   `0..=1_000` to match the contract's `init` validation.
 * - Unknown fields are rejected so typos fail fast instead of being dropped.
 *
 * Encoders emit canonical maps: symbol keys sorted lexicographically, which
 * matches the XDR key ordering Soroban requires for `ScMap` values. Decoders
 * are deliberately tolerant of unknown keys so a contract that adds a field
 * cannot break existing clients, while still validating every field they read.
 *
 * @packageDocumentation
 */

import {
  Address,
  StrKey,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

/** Lifecycle states of an escrow, matching the contract's `EscrowStatus`. */
export type EscrowStatusName = "Funded" | "Disbursed" | "Refunded" | "Disputed";

/** Numeric limits and shared constants used by the codecs. */
const U64_MAX = (1n << 64n) - 1n;
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const U32_MAX = 0xffff_ffff;

/** Basis points that represent 100%. */
const BPS_DENOMINATOR = 10_000;

/** Highest fee the contract's `init` accepts, matching `EscrowGateClient`. */
const MAX_FEE_BPS = 1_000;

/** Exactly 32 bytes expressed as 64 hexadecimal characters. */
const HEX_32_PATTERN = /^[0-9a-fA-F]{64}$/;

/** All accepted escrow lifecycle states. */
const ESCROW_STATUSES: readonly EscrowStatusName[] = [
  "Funded",
  "Disbursed",
  "Refunded",
  "Disputed",
];

/**
 * Escrow record exchanged with the contract's `get_escrow` method.
 *
 * Mirrors the contract's `EscrowRecord` struct field-for-field. Amounts are
 * `bigint` because a Soroban `i128` cannot be represented exactly by a
 * JavaScript `number`.
 */
export interface Escrow {
  /** Stellar account that funded the escrow. */
  payer: string;
  /** Stellar account that can receive the escrowed funds. */
  beneficiary: string;
  /** Token contract address used for the escrow amount. */
  token: string;
  /** Escrowed amount in the token's smallest unit, encoded as `i128`. */
  amount: bigint;
  /** SHA-256 commitment to the beneficiary profile, 64 hexadecimal characters. */
  profileHashHex: string;
  /** Current lifecycle state of the escrow. */
  status: EscrowStatusName;
  /** Unix timestamp, in seconds, when the escrow becomes refundable (`u64`). */
  unlockTimestamp: bigint;
}

/**
 * Protocol fee configuration committed alongside an escrow programme.
 *
 * `maxFee` is a `u128` ceiling on the fee charged per release; `minFee` is an
 * optional `i128` floor. `feeBps` follows the contract's `init` validation and
 * is capped at 1,000 basis points (10%).
 */
export interface FeeConfig {
  /** Protocol fee in basis points, from `0` to `1_000` inclusive (`u32`). */
  feeBps: number;
  /** Stellar account that receives protocol fees. */
  treasury: string;
  /** Maximum fee charged per release, in token stroops (`u128`). */
  maxFee: bigint;
  /** Optional minimum fee charged per release, in token stroops (`i128`). */
  minFee?: bigint;
}

/**
 * On-chain record of a dispute raised against an escrow.
 *
 * `evidenceHashesHex` is a `Vec<BytesN<32>>`; an empty array is valid. The
 * resolution metadata is optional: unresolved disputes omit `resolvedAt` and
 * `resolutionNote`, which are encoded as `scvVoid` (`Option::None`).
 */
export interface DisputeRecord {
  /** Identifier of the disputed escrow (`u64`). */
  escrowId: bigint;
  /** Stellar account that raised the dispute. */
  raisedBy: string;
  /** Commitment to the dispute reason, 64 hexadecimal characters (`BytesN<32>`). */
  reasonHashHex: string;
  /** Share awarded to the payer if the dispute resolves this way (`u32`). */
  payerBps: number;
  /** Share awarded to the beneficiary if the dispute resolves this way (`u32`). */
  beneficiaryBps: number;
  /** Whether the dispute has been resolved on-chain. */
  resolved: boolean;
  /** Evidence commitments, each 64 hexadecimal characters; may be empty. */
  evidenceHashesHex: string[];
  /** Unix timestamp, in seconds, when the dispute was resolved (`Option<u64>`). */
  resolvedAt?: bigint;
  /** Free-form resolution note (`Option<String>`). */
  resolutionNote?: string;
}

/**
 * Validates that a value is a plain record suitable for field access.
 *
 * @param value - Value supplied by the caller.
 * @param label - Type name used in error messages.
 * @throws {Error} If the value is not a non-array object.
 */
function assertRecord(
  value: unknown,
  label: string
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

/**
 * Rejects fields the codec does not understand, catching typos early.
 *
 * @param record - Record being encoded.
 * @param allowed - Field names the struct supports.
 * @param label - Type name used in error messages.
 * @throws {Error} If the record contains an unsupported field.
 */
function assertKnownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const unsupported = Object.keys(record).filter(
    (key) => !allowed.includes(key)
  );
  if (unsupported.length > 0) {
    throw new Error(
      `${label} contains unsupported field(s): ${unsupported.sort().join(", ")}`
    );
  }
}

/**
 * Checks whether a string is a canonical Stellar account or contract address.
 *
 * @param address - Candidate `G...` or `C...` StrKey.
 * @returns `true` when the StrKey is valid and has no surrounding whitespace.
 */
function isFormattedAddress(address: unknown): address is string {
  return (
    typeof address === "string" &&
    address.trim() === address &&
    address !== "" &&
    (StrKey.isValidEd25519PublicKey(address) ||
      StrKey.isValidContract(address))
  );
}

/**
 * Encodes a Stellar address as an `scvAddress`.
 *
 * @param address - `G...` account or `C...` contract address.
 * @param field - Field name used in error messages.
 * @returns The address as an `scvAddress`.
 * @throws {Error} If the address is not a formatted Stellar StrKey.
 */
function toAddressScVal(address: unknown, field: string): xdr.ScVal {
  if (!isFormattedAddress(address)) {
    throw new Error(`${field} must be a formatted Stellar address: ${String(address)}`);
  }
  return new Address(address).toScVal();
}

/**
 * Decodes an `scvAddress` into its `G...`/`C...` string form.
 *
 * @param val - ScVal expected to hold an address.
 * @param field - Field name used in error messages.
 * @returns The canonical StrKey representation.
 * @throws {Error} If the ScVal is not an address.
 */
function addressFromScVal(val: xdr.ScVal, field: string): string {
  if (!(val instanceof xdr.ScVal) || val.type !== "scvAddress") {
    throw new Error(`${field} must be a Soroban address ScVal`);
  }
  return Address.fromScVal(val).toString();
}

/**
 * Validates and normalizes a 32-byte hexadecimal value.
 *
 * @param hex - Candidate 64-character hexadecimal string.
 * @param field - Field name used in error messages.
 * @returns Lowercase hexadecimal text.
 * @throws {Error} If the value is not exactly 32 bytes of hexadecimal text.
 */
function requireHex32(hex: unknown, field: string): string {
  if (typeof hex !== "string" || !HEX_32_PATTERN.test(hex)) {
    throw new Error(
      `${field} must be exactly 32 bytes of hexadecimal (64 hex characters): ${String(hex)}`
    );
  }
  return hex.toLowerCase();
}

/**
 * Encodes a 32-byte hexadecimal value as `BytesN<32>` (`scvBytes`).
 *
 * @param hex - 64 hexadecimal characters.
 * @param field - Field name used in error messages.
 * @returns The bytes as an `scvBytes` value.
 * @throws {Error} If the value is not exactly 32 bytes of hexadecimal text.
 */
function toBytesN32ScVal(hex: unknown, field: string): xdr.ScVal {
  const normalized = requireHex32(hex, field);
  return xdr.ScVal.scvBytes(Buffer.from(normalized, "hex"));
}

/**
 * Decodes `BytesN<32>` into lowercase hexadecimal text.
 *
 * @param val - ScVal expected to hold exactly 32 bytes.
 * @param field - Field name used in error messages.
 * @returns 64 lowercase hexadecimal characters.
 * @throws {Error} If the ScVal is not 32 bytes.
 */
function bytesN32FromScVal(val: xdr.ScVal, field: string): string {
  if (!(val instanceof xdr.ScVal) || val.type !== "scvBytes") {
    throw new Error(`${field} must be a Soroban bytes ScVal`);
  }
  const bytes = val.bytes.value;
  if (bytes.length !== 32) {
    throw new Error(`${field} must be exactly 32 bytes (got ${bytes.length})`);
  }
  return Buffer.from(bytes).toString("hex");
}

/**
 * Validates an integer and encodes it with an explicit Soroban width.
 *
 * @param value - Caller-supplied integer.
 * @param type - Soroban integer width to emit.
 * @param field - Field name used in error messages.
 * @returns The integer as the requested `ScVal`.
 * @throws {Error} If the value is not a `bigint` or is outside `type`'s range.
 */
function toWideIntScVal(
  value: unknown,
  type: "i128" | "u128" | "u64",
  field: string
): xdr.ScVal {
  if (typeof value !== "bigint") {
    throw new Error(`${field} must be a bigint`);
  }
  const bounds: Record<typeof type, [bigint, bigint]> = {
    i128: [I128_MIN, I128_MAX],
    u128: [0n, U128_MAX],
    u64: [0n, U64_MAX],
  };
  const [min, max] = bounds[type];
  if (value < min || value > max) {
    throw new Error(`${field} is out of range for ${type}: ${value}`);
  }
  return nativeToScVal(value, { type });
}

/**
 * Decodes an integer `ScVal`, enforcing the expected XDR width.
 *
 * @param val - ScVal to decode.
 * @param type - Expected Soroban integer width.
 * @param field - Field name used in error messages.
 * @returns The decoded integer.
 * @throws {Error} If the ScVal has a different width or an invalid value.
 */
function wideIntFromScVal(
  val: xdr.ScVal,
  type: "i128" | "u128" | "u64",
  field: string
): bigint {
  const expected = {
    i128: "scvI128",
    u128: "scvU128",
    u64: "scvU64",
  }[type];
  if (!(val instanceof xdr.ScVal) || val.type !== expected) {
    throw new Error(`${field} must be a Soroban ${expected} ScVal`);
  }
  return scValToNative(val) as bigint;
}

/**
 * Validates and encodes a `u32` field.
 *
 * @param value - Caller-supplied integer.
 * @param field - Field name used in error messages.
 * @param max - Inclusive upper bound, defaulting to `2^32 - 1`.
 * @returns The value as an `scvU32`.
 * @throws {Error} If the value is not an integer in `0..=max`.
 */
function toU32ScVal(value: unknown, field: string, max = U32_MAX): xdr.ScVal {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  if (value < 0 || value > max) {
    throw new Error(`${field} must be between 0 and ${max} (got ${value})`);
  }
  return nativeToScVal(value, { type: "u32" });
}

/**
 * Decodes an `scvU32` field.
 *
 * @param val - ScVal to decode.
 * @param field - Field name used in error messages.
 * @returns The decoded unsigned 32-bit integer.
 * @throws {Error} If the ScVal is not an `scvU32`.
 */
function u32FromScVal(val: xdr.ScVal, field: string): number {
  if (!(val instanceof xdr.ScVal) || val.type !== "scvU32") {
    throw new Error(`${field} must be a Soroban u32 ScVal`);
  }
  return val.value;
}

/**
 * Encodes a boolean field as `scvBool`.
 *
 * @param value - Caller-supplied boolean.
 * @param field - Field name used in error messages.
 * @returns The value as an `scvBool`.
 * @throws {Error} If the value is not a boolean.
 */
function toBoolScVal(value: unknown, field: string): xdr.ScVal {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return xdr.ScVal.scvBool(value);
}

/**
 * Decodes an `scvBool` field.
 *
 * @param val - ScVal to decode.
 * @param field - Field name used in error messages.
 * @returns The decoded boolean.
 * @throws {Error} If the ScVal is not an `scvBool`.
 */
function boolFromScVal(val: xdr.ScVal, field: string): boolean {
  if (!(val instanceof xdr.ScVal) || val.type !== "scvBool") {
    throw new Error(`${field} must be a Soroban bool ScVal`);
  }
  return val.b;
}

/**
 * Encodes a unit-variant enum as Soroban's `Vec<Symbol>` representation.
 *
 * @param status - Escrow lifecycle state.
 * @returns The enum as a single-element symbol vector.
 * @throws {Error} If the status is not a known `EscrowStatus` variant.
 */
function statusToScVal(status: unknown): xdr.ScVal {
  if (
    typeof status !== "string" ||
    !(ESCROW_STATUSES as readonly string[]).includes(status)
  ) {
    throw new Error(
      `status must be one of ${ESCROW_STATUSES.join(", ")} (got ${String(status)})`
    );
  }
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(status)]);
}

/**
 * Decodes an escrow status enum.
 *
 * Accepts the raw Soroban representation (`["Funded"]`), the flattened string
 * form used by the Stellar SDK spec layer, and `{ name }`/`{ tag }` wrappers so
 * records from RPC, events, and hand-built fixtures all decode.
 *
 * @param val - ScVal holding the enum.
 * @param field - Field name used in error messages.
 * @returns The lifecycle state.
 * @throws {Error} If the ScVal is not a known `EscrowStatus` variant.
 */
function statusFromScVal(val: xdr.ScVal, field: string): EscrowStatusName {
  let candidate: unknown;
  if (val instanceof xdr.ScVal && val.type === "scvVec") {
    const items = val.vec ?? [];
    if (items.length === 1) {
      const item = items[0];
      if (item.type === "scvSymbol" || item.type === "scvString") {
        candidate = scValToNative(item);
      }
    }
  } else if (
    val instanceof xdr.ScVal &&
    (val.type === "scvSymbol" || val.type === "scvString")
  ) {
    candidate = scValToNative(val);
  }

  if (
    typeof candidate !== "string" ||
    !(ESCROW_STATUSES as readonly string[]).includes(candidate)
  ) {
    throw new Error(
      `${field} must be one of ${ESCROW_STATUSES.join(", ")} (got ${String(candidate)})`
    );
  }
  return candidate as EscrowStatusName;
}

/**
 * Encodes an optional field, using `scvVoid` for `None`.
 *
 * @param value - Optional value.
 * @param encode - Encoder for a present value.
 * @returns `scvVoid` when absent, otherwise the encoded value.
 */
function optionalToScVal(
  value: unknown,
  encode: () => xdr.ScVal
): xdr.ScVal {
  return value === undefined || value === null
    ? xdr.ScVal.scvVoid()
    : encode();
}

/**
 * Decodes an optional field, mapping `scvVoid` to `undefined`.
 *
 * @param val - ScVal that may be `scvVoid`.
 * @param decode - Decoder for a present value.
 * @returns `undefined` for `None`, otherwise the decoded value.
 */
function optionalFromScVal<T>(
  val: xdr.ScVal,
  decode: (present: xdr.ScVal) => T
): T | undefined {
  return val instanceof xdr.ScVal && val.type === "scvVoid"
    ? undefined
    : decode(val);
}

/**
 * Builds a canonical `scvMap` from named fields.
 *
 * Keys are emitted as symbols in lexicographic order, which is the ordering
 * Soroban's XDR canonical form expects for maps whose keys are all symbols.
 *
 * @param fields - Field name/ScVal pairs in any order.
 * @returns The sorted `scvMap`.
 */
function structToScVal(fields: Array<[string, xdr.ScVal]>): xdr.ScVal {
  const entries = fields
    .slice()
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, val]) =>
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
    );
  return xdr.ScVal.scvMap(entries);
}

/**
 * Reads an `scvMap` into a field-name lookup keyed by symbol text.
 *
 * @param val - ScVal expected to hold a struct.
 * @param label - Type name used in error messages.
 * @returns Map of field names to `ScVal`s.
 * @throws {Error} If the ScVal is not a map or has non-symbol keys.
 */
function structFields(val: xdr.ScVal, label: string): Map<string, xdr.ScVal> {
  if (!(val instanceof xdr.ScVal) || val.type !== "scvMap" || !val.map) {
    throw new Error(`${label} must be a Soroban struct ScVal (scvMap)`);
  }
  const fields = new Map<string, xdr.ScVal>();
  for (const entry of val.map) {
    const key = scValToNative(entry.key);
    if (typeof key !== "string") {
      throw new Error(`${label} contains a non-symbol field name`);
    }
    fields.set(key, entry.val);
  }
  return fields;
}

/**
 * Reads a required field from a decoded struct.
 *
 * @param fields - Struct fields keyed by name.
 * @param name - Soroban field name.
 * @param label - Type name used in error messages.
 * @returns The field's `ScVal`.
 * @throws {Error} If the field is missing.
 */
function requireField(
  fields: Map<string, xdr.ScVal>,
  name: string,
  label: string
): xdr.ScVal {
  const val = fields.get(name);
  if (val === undefined) {
    throw new Error(`${label} is missing required field "${name}"`);
  }
  return val;
}

/**
 * Reads an optional field from a decoded struct; missing equals `None`.
 *
 * @param fields - Struct fields keyed by name.
 * @param name - Soroban field name.
 * @returns The field's `ScVal`, or `undefined` when absent.
 */
function optionalField(
  fields: Map<string, xdr.ScVal>,
  name: string
): xdr.ScVal | undefined {
  return fields.get(name);
}

/**
 * Encodes an {@link Escrow} as the contract's `EscrowRecord` struct.
 *
 * @param escrow - Escrow record to validate and encode.
 * @returns The canonical `scvMap` in contract field order.
 * @throws {Error} If any field is malformed or outside its Soroban width.
 *
 * @example
 * ```ts
 * const scVal = escrowToScVal({
 *   payer: "G...",
 *   beneficiary: "G...",
 *   token: "C...",
 *   amount: 10_000_000n,
 *   profileHashHex: "e0a9e37d5cb17ded767cf3b2c5a6b12b58403f1a92c909f8555f9c93e18d91e4",
 *   status: "Funded",
 *   unlockTimestamp: 1_760_000_000n,
 * });
 * ```
 */
export function escrowToScVal(escrow: Escrow): xdr.ScVal {
  const label = "Escrow";
  assertRecord(escrow, label);
  assertKnownFields(
    escrow,
    [
      "payer",
      "beneficiary",
      "token",
      "amount",
      "profileHashHex",
      "status",
      "unlockTimestamp",
    ],
    label
  );

  return structToScVal([
    ["payer", toAddressScVal(escrow.payer, "payer")],
    ["beneficiary", toAddressScVal(escrow.beneficiary, "beneficiary")],
    ["token", toAddressScVal(escrow.token, "token")],
    ["amount", toWideIntScVal(escrow.amount, "i128", "amount")],
    ["profile_hash", toBytesN32ScVal(escrow.profileHashHex, "profileHashHex")],
    ["status", statusToScVal(escrow.status)],
    [
      "unlock_timestamp",
      toWideIntScVal(escrow.unlockTimestamp, "u64", "unlockTimestamp"),
    ],
  ]);
}

/**
 * Decodes the contract's `EscrowRecord` struct into an {@link Escrow}.
 *
 * @param scVal - Struct returned by `get_escrow` or read from contract storage.
 * @returns The validated escrow record.
 * @throws {Error} If the value is not an escrow struct or a field is malformed.
 */
export function scValToEscrow(scVal: xdr.ScVal): Escrow {
  const label = "Escrow";
  const fields = structFields(scVal, label);

  return {
    payer: addressFromScVal(requireField(fields, "payer", label), "payer"),
    beneficiary: addressFromScVal(
      requireField(fields, "beneficiary", label),
      "beneficiary"
    ),
    token: addressFromScVal(requireField(fields, "token", label), "token"),
    amount: wideIntFromScVal(
      requireField(fields, "amount", label),
      "i128",
      "amount"
    ),
    profileHashHex: bytesN32FromScVal(
      requireField(fields, "profile_hash", label),
      "profile_hash"
    ),
    status: statusFromScVal(
      requireField(fields, "status", label),
      "status"
    ),
    unlockTimestamp: wideIntFromScVal(
      requireField(fields, "unlock_timestamp", label),
      "u64",
      "unlockTimestamp"
    ),
  };
}

/**
 * Encodes a {@link FeeConfig} as a Soroban struct.
 *
 * Field mapping: `feeBps` → `fee_bps` (`u32`), `treasury` → `treasury`
 * (`Address`), `maxFee` → `max_fee` (`u128`), `minFee` → `min_fee`
 * (`Option<i128>`, `scvVoid` when omitted).
 *
 * @param config - Fee configuration to validate and encode.
 * @returns The canonical `scvMap`.
 * @throws {Error} If basis points, addresses, or fee amounts are invalid, or
 *   `minFee` exceeds `maxFee`.
 */
export function feeConfigToScVal(config: FeeConfig): xdr.ScVal {
  const label = "FeeConfig";
  assertRecord(config, label);
  assertKnownFields(
    config,
    ["feeBps", "treasury", "maxFee", "minFee"],
    label
  );

  if (
    typeof config.minFee === "bigint" &&
    typeof config.maxFee === "bigint" &&
    config.minFee > config.maxFee
  ) {
    throw new Error("minFee cannot exceed maxFee");
  }

  return structToScVal([
    ["fee_bps", toU32ScVal(config.feeBps, "feeBps", MAX_FEE_BPS)],
    ["treasury", toAddressScVal(config.treasury, "treasury")],
    ["max_fee", toWideIntScVal(config.maxFee, "u128", "maxFee")],
    [
      "min_fee",
      optionalToScVal(config.minFee, () =>
        toWideIntScVal(config.minFee, "i128", "minFee")
      ),
    ],
  ]);
}

/**
 * Decodes a Soroban fee-configuration struct into a {@link FeeConfig}.
 *
 * Unknown fields are ignored for forward compatibility.
 *
 * @param scVal - Struct to decode.
 * @returns The validated fee configuration.
 * @throws {Error} If the value is not a struct or a field is malformed.
 */
export function scValToFeeConfig(scVal: xdr.ScVal): FeeConfig {
  const label = "FeeConfig";
  const fields = structFields(scVal, label);

  const feeBps = u32FromScVal(requireField(fields, "fee_bps", label), "fee_bps");
  if (feeBps > MAX_FEE_BPS) {
    throw new Error(`fee_bps must be between 0 and ${MAX_FEE_BPS} (got ${feeBps})`);
  }

  const minFeeVal = optionalField(fields, "min_fee");
  const minFee =
    minFeeVal === undefined
      ? undefined
      : optionalFromScVal(minFeeVal, (present) =>
          wideIntFromScVal(present, "i128", "min_fee")
        );

  const maxFee = wideIntFromScVal(
    requireField(fields, "max_fee", label),
    "u128",
    "max_fee"
  );
  if (minFee !== undefined && minFee > maxFee) {
    throw new Error(`min_fee (${minFee}) cannot exceed max_fee (${maxFee})`);
  }

  return {
    feeBps,
    treasury: addressFromScVal(
      requireField(fields, "treasury", label),
      "treasury"
    ),
    maxFee,
    minFee,
  };
}

/**
 * Encodes a {@link DisputeRecord} as a Soroban struct.
 *
 * `evidenceHashesHex` is encoded as `Vec<BytesN<32>>` and may be empty.
 * `resolvedAt` and `resolutionNote` are encoded as `Option` values, using
 * `scvVoid` when omitted.
 *
 * @param record - Dispute record to validate and encode.
 * @returns The canonical `scvMap`.
 * @throws {Error} If addresses, commitments, integers, or basis points are
 *   invalid.
 */
export function disputeRecordToScVal(record: DisputeRecord): xdr.ScVal {
  const label = "DisputeRecord";
  assertRecord(record, label);
  assertKnownFields(
    record,
    [
      "escrowId",
      "raisedBy",
      "reasonHashHex",
      "payerBps",
      "beneficiaryBps",
      "resolved",
      "evidenceHashesHex",
      "resolvedAt",
      "resolutionNote",
    ],
    label
  );

  if (!Array.isArray(record.evidenceHashesHex)) {
    throw new Error("evidenceHashesHex must be an array");
  }

  return structToScVal([
    ["escrow_id", toWideIntScVal(record.escrowId, "u64", "escrowId")],
    ["raised_by", toAddressScVal(record.raisedBy, "raisedBy")],
    ["reason_hash", toBytesN32ScVal(record.reasonHashHex, "reasonHashHex")],
    [
      "payer_bps",
      toU32ScVal(record.payerBps, "payerBps", BPS_DENOMINATOR),
    ],
    [
      "beneficiary_bps",
      toU32ScVal(record.beneficiaryBps, "beneficiaryBps", BPS_DENOMINATOR),
    ],
    ["resolved", toBoolScVal(record.resolved, "resolved")],
    [
      "evidence_hashes",
      xdr.ScVal.scvVec(
        record.evidenceHashesHex.map((hash, index) =>
          toBytesN32ScVal(hash, `evidenceHashesHex[${index}]`)
        )
      ),
    ],
    [
      "resolved_at",
      optionalToScVal(record.resolvedAt, () =>
        toWideIntScVal(record.resolvedAt, "u64", "resolvedAt")
      ),
    ],
    [
      "resolution_note",
      optionalToScVal(record.resolutionNote, () => {
        if (typeof record.resolutionNote !== "string") {
          throw new Error("resolutionNote must be a string");
        }
        return xdr.ScVal.scvString(record.resolutionNote);
      }),
    ],
  ]);
}

/**
 * Decodes a Soroban dispute struct into a {@link DisputeRecord}.
 *
 * Unknown fields are ignored for forward compatibility.
 *
 * @param scVal - Struct to decode.
 * @returns The validated dispute record.
 * @throws {Error} If the value is not a struct or a field is malformed.
 */
export function scValToDisputeRecord(scVal: xdr.ScVal): DisputeRecord {
  const label = "DisputeRecord";
  const fields = structFields(scVal, label);

  const evidenceVal = requireField(fields, "evidence_hashes", label);
  if (evidenceVal.type !== "scvVec" || !evidenceVal.vec) {
    throw new Error("evidence_hashes must be a Soroban vector ScVal");
  }
  const evidenceHashesHex = evidenceVal.vec.map((item, index) =>
    bytesN32FromScVal(item, `evidence_hashes[${index}]`)
  );

  const payerBps = u32FromScVal(
    requireField(fields, "payer_bps", label),
    "payer_bps"
  );
  const beneficiaryBps = u32FromScVal(
    requireField(fields, "beneficiary_bps", label),
    "beneficiary_bps"
  );
  if (payerBps > BPS_DENOMINATOR) {
    throw new Error(`payer_bps must be between 0 and ${BPS_DENOMINATOR} (got ${payerBps})`);
  }
  if (beneficiaryBps > BPS_DENOMINATOR) {
    throw new Error(
      `beneficiary_bps must be between 0 and ${BPS_DENOMINATOR} (got ${beneficiaryBps})`
    );
  }

  const resolvedAtVal = optionalField(fields, "resolved_at");
  const resolvedAt =
    resolvedAtVal === undefined
      ? undefined
      : optionalFromScVal(resolvedAtVal, (present) =>
          wideIntFromScVal(present, "u64", "resolved_at")
        );

  const noteVal = optionalField(fields, "resolution_note");
  const resolutionNote =
    noteVal === undefined
      ? undefined
      : optionalFromScVal(noteVal, (present) => {
          if (present.type !== "scvString") {
            throw new Error("resolution_note must be a Soroban string ScVal");
          }
          const note = scValToNative(present);
          if (typeof note !== "string") {
            throw new Error("resolution_note could not be decoded as UTF-8 text");
          }
          return note;
        });

  return {
    escrowId: wideIntFromScVal(
      requireField(fields, "escrow_id", label),
      "u64",
      "escrow_id"
    ),
    raisedBy: addressFromScVal(
      requireField(fields, "raised_by", label),
      "raised_by"
    ),
    reasonHashHex: bytesN32FromScVal(
      requireField(fields, "reason_hash", label),
      "reason_hash"
    ),
    payerBps,
    beneficiaryBps,
    resolved: boolFromScVal(
      requireField(fields, "resolved", label),
      "resolved"
    ),
    evidenceHashesHex,
    resolvedAt,
    resolutionNote,
  };
}
