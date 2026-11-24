import assert from "node:assert";
import { describe, test } from "node:test";
import { createHash } from "node:crypto";
import {
  validateIban,
  validateBic,
  validateAccountNumber,
  validateBankingProfile,
  generateBankingProfileHash,
  generateBankingProfileCommitment,
  maskAccountNumber,
  normalizeIban,
  corridorForCountry,
  isSupportedCountry,
  BankingProfile,
  IbanValidationResult,
} from "./banking";

function computeIbanCheckDigits(countryCode: string, bban: string): string {
  const rearranged = `${bban}${countryCode}00`;
  const numeric = rearranged.replace(/[A-Z]/g, (ch) =>
    (ch.charCodeAt(0) - "A".charCodeAt(0) + 10).toString()
  );
  let remainder = 0;
  for (let i = 0; i < numeric.length; i++) {
    remainder = (remainder * 10 + Number(numeric[i])) % 97;
  }
  return String(98 - remainder).padStart(2, "0");
}

function makeValidIban(countryCode: string, bban: string): string {
  const check = computeIbanCheckDigits(countryCode, bban);
  return `${countryCode}${check}${bban}`;
}

const BASE_PROFILE: BankingProfile = {
  countryCode: "DE",
  corridor: "SEPA",
  iban: "DE89370400440532013000",
  bic: "COBADEFFXXX",
  accountNumber: "1234567890",
  accountHolderName: "Alice Remitter",
  bankName: "Anchor Bank",
};

describe("Banking IBAN validation (SEPA / NGN / BRL)", () => {
  test("normalizeIban strips spaces and uppercases", () => {
    assert.strictEqual(normalizeIban("de 89 3704 0044 0532 0130 00"), "DE89370400440532013000");
  });

  test("accepts a valid SEPA IBAN (DE)", () => {
    const result = validateIban("DE89370400440532013000") as IbanValidationResult;
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.countryCode, "DE");
    assert.strictEqual(result.corridor, "SEPA");
  });

  test("detects NG corridor as NGN", () => {
    assert.strictEqual(corridorForCountry("NG"), "NGN");
    assert.strictEqual(corridorForCountry("BR"), "BRL");
    assert.strictEqual(corridorForCountry("DE"), "SEPA");
    assert.strictEqual(corridorForCountry("XX"), undefined);
  });

  test("rejects unsupported country codes", () => {
    const result = validateIban("XX000000000000000000");
    assert.strictEqual(result.valid, false);
    assert.match(result.error || "", /Unsupported country code/);
  });

  test("rejects IBAN with invalid mod-97 check digits", () => {
    const bad = "DE00000000000000000000";
    const result = validateIban(bad);
    assert.strictEqual(result.valid, false);
    assert.match(result.error || "", /mod-97/);
  });

  test("rejects malformed IBAN structures", () => {
    assert.strictEqual(validateIban("").valid, false);
    assert.strictEqual(validateIban("DE").valid, false);
    assert.strictEqual(validateIban("DEXX370400440532013000").valid, false);
    assert.strictEqual(validateIban(undefined as unknown as string).valid, false);
  });

  test("computes and accepts a valid NGN IBAN", () => {
    const iban = makeValidIban("NG", "00123456789012345678");
    const result = validateIban(iban);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.corridor, "NGN");
  });

  test("computes and accepts a valid BRL IBAN", () => {
    const iban = makeValidIban("BR", "00000000000000000000123");
    const result = validateIban(iban);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.corridor, "BRL");
  });

  test("isSupportedCountry covers SEPA plus NG and BR", () => {
    assert.strictEqual(isSupportedCountry("DE"), true);
    assert.strictEqual(isSupportedCountry("NG"), true);
    assert.strictEqual(isSupportedCountry("BR"), true);
    assert.strictEqual(isSupportedCountry("XX"), false);
  });
});

describe("Banking BIC validation", () => {
  test("accepts valid 8-character BIC", () => {
    assert.strictEqual(validateBic("COBADEFF").valid, true);
  });
  test("accepts valid 11-character BIC", () => {
    assert.strictEqual(validateBic("COBADEFFXXX").valid, true);
  });
  test("rejects empty, short, and invalid BIC", () => {
    assert.strictEqual(validateBic("").valid, false);
    assert.strictEqual(validateBic("COBADE").valid, false);
    assert.strictEqual(validateBic("COBADEFFXX!").valid, false);
    assert.strictEqual(validateBic("cobadeffxxx").valid, true);
  });
});

describe("Banking account number validation", () => {
  test("accepts alphanumeric account numbers", () => {
    assert.strictEqual(validateAccountNumber("1234567890").valid, true);
    assert.strictEqual(validateAccountNumber("SA123456789").valid, true);
  });
  test("rejects non-alphanumeric and over-long account numbers", () => {
    assert.strictEqual(validateAccountNumber("").valid, false);
    assert.strictEqual(validateAccountNumber("12-34").valid, false);
    assert.strictEqual(validateAccountNumber("A".repeat(35)).valid, false);
  });
  test("enforces NGN NUBAN as exactly 10 digits", () => {
    assert.strictEqual(validateAccountNumber("1234567890", "NG").valid, true);
    assert.strictEqual(validateAccountNumber("123456789", "NG").valid, false);
    assert.strictEqual(validateAccountNumber("12345678901", "NG").valid, false);
    assert.strictEqual(validateAccountNumber("ABCDEFGHIJ", "NG").valid, false);
  });
});

describe("Banking profile validation", () => {
  test("accepts a complete valid profile", () => {
    const result = validateBankingProfile(BASE_PROFILE);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
  });
  test("rejects missing country code", () => {
    const result = validateBankingProfile({ ...BASE_PROFILE, countryCode: "" });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => /Country code/.test(e)));
  });
  test("rejects unsupported country code", () => {
    const result = validateBankingProfile({ ...BASE_PROFILE, countryCode: "XX" });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => /Unsupported/.test(e)));
  });
  test("rejects IBAN whose country does not match the profile", () => {
    const result = validateBankingProfile({ ...BASE_PROFILE, countryCode: "FR" });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => /does not match/.test(e)));
  });
  test("rejects profile with neither IBAN nor account number", () => {
    const result = validateBankingProfile({
      ...BASE_PROFILE,
      iban: undefined,
      accountNumber: undefined,
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => /Either IBAN or account number/.test(e)));
  });
  test("rejects invalid IBAN and invalid BIC within a profile", () => {
    const result = validateBankingProfile({
      ...BASE_PROFILE,
      iban: "DE00000000000000000000",
      bic: "BAD!BIC",
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length >= 2);
  });
});

describe("Banking profile SHA-256 commitment", () => {
  test("generateBankingProfileHash is deterministic", async () => {
    const a = await generateBankingProfileHash(BASE_PROFILE);
    const b = await generateBankingProfileHash(BASE_PROFILE);
    assert.strictEqual(a, b);
    assert.strictEqual(a.length, 64);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  test("different profiles produce different hashes", async () => {
    const a = await generateBankingProfileHash(BASE_PROFILE);
    const b = await generateBankingProfileHash({ ...BASE_PROFILE, accountNumber: "0987654321" });
    assert.notStrictEqual(a, b);
  });

  test("hash matches an independent SHA-256 of the canonical payload", async () => {
    const accountNumberHash = createHash("sha256")
      .update("ACCOUNT_NUMBER:1234567890")
      .digest("hex");
    const canonical = {
      countryCode: "DE",
      corridor: "SEPA",
      iban: "DE89370400440532013000",
      bic: "COBADEFFXXX",
      accountNumberPresent: true,
      accountNumberHash,
      accountHolderName: "Alice Remitter",
      bankName: "Anchor Bank",
    };
    // The commitment must never embed the plaintext account number.
    assert.ok(!JSON.stringify(canonical).includes("1234567890"));
    const expected = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
    const actual = await generateBankingProfileHash(BASE_PROFILE);
    assert.strictEqual(actual, expected);
  });

  test("generateBankingProfileCommitment excludes plaintext account number", async () => {
    const commitment = await generateBankingProfileCommitment(BASE_PROFILE);
    assert.strictEqual(commitment.profileHash.length, 64);
    assert.strictEqual(commitment.countryCode, "DE");
    assert.strictEqual(commitment.corridor, "SEPA");
    assert.strictEqual(commitment.maskedAccountNumber, "******7890");
    assert.strictEqual(commitment.iban, "DE89370400440532013000");
    assert.strictEqual(commitment.bic, "COBADEFFXXX");
    const serialized = JSON.stringify(commitment);
    assert.ok(!serialized.includes("1234567890"), "raw account number must not be in the commitment payload");
  });

  test("maskAccountNumber reveals only the last four digits", () => {
    assert.strictEqual(maskAccountNumber("1234567890"), "******7890");
    assert.strictEqual(maskAccountNumber("1234"), "1234");
    assert.strictEqual(maskAccountNumber(""), "");
    assert.strictEqual(maskAccountNumber("X"), "X");
  });
});
