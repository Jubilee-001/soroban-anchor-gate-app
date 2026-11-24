import assert from "node:assert";
import { describe, test } from "node:test";
import { createHash } from "node:crypto";
import {
  BankingProfile,
  canonicalizeBankingProfile,
  formatBankingProfileHash,
  hashBankingProfile,
  hashBankingProfileHex,
} from "./crypto";

/**
 * A pinned commitment vector.
 *
 * `digestHex` values were produced independently with OpenSSL (`sha256sum`)
 * over the canonical preimage and are asserted against the SDK output, so the
 * SDK can never silently drift to a different preimage and still pass.
 */
interface ProfileVector {
  name: string;
  profile: BankingProfile;
  canonical: string;
  digestHex: string;
}

const PROFILE_VECTORS: ProfileVector[] = [
  {
    // On-chain `profile_hash` for escrow #3 on Stellar Testnet.
    // See evidence/testnet-verified-2026-10-05.md.
    name: "IBAN + BIC (verified on-chain fixture)",
    profile: { iban: "DE89370400440532013000", bic: "COBADEFFXXX" },
    canonical: "IBAN: DE89370400440532013000 / BIC: COBADEFFXXX",
    digestHex:
      "e0a9e37d5cb17ded767cf3b2c5a6b12b58403f1a92c909f8555f9c93e18d91e4",
  },
  {
    name: "IBAN only",
    profile: { iban: "DE89370400440532013000" },
    canonical: "IBAN: DE89370400440532013000",
    digestHex:
      "24c294836d22e6e751d223ceb2e983f9dbf2214a0af1e476d6fe860ea91907c1",
  },
  {
    name: "domestic account number + bank code",
    profile: { accountNumber: "0123456789", bankCode: "058" },
    canonical: "ACCOUNT: 0123456789 / BANK_CODE: 058",
    digestHex:
      "492f56a6f750d11e9037d0bf5dd6ebb9ac25195752fa18260bf5b4c1f7a8fabd",
  },
  {
    name: "all four fields",
    profile: {
      bankCode: "058",
      accountNumber: "0123456789",
      bic: "COBADEFFXXX",
      iban: "DE89370400440532013000",
    },
    canonical:
      "IBAN: DE89370400440532013000 / BIC: COBADEFFXXX / ACCOUNT: 0123456789 / BANK_CODE: 058",
    digestHex:
      "fae3e6063e6eb5c0b6e93f43894cbf4c2d4cfd0975bc6d60185e9a24d840cd5f",
  },
];

describe("Client-side banking profile commitment hashing", () => {
  test("reproduces the pinned contract/on-chain profile hash vectors", () => {
    for (const vector of PROFILE_VECTORS) {
      assert.strictEqual(
        canonicalizeBankingProfile(vector.profile),
        vector.canonical,
        `${vector.name}: canonical preimage mismatch`
      );

      const digest = hashBankingProfile(vector.profile);
      assert.strictEqual(digest.length, 32, `${vector.name}: digest length`);
      assert.strictEqual(
        Buffer.from(digest).toString("hex"),
        vector.digestHex,
        `${vector.name}: digest mismatch`
      );
      assert.strictEqual(
        hashBankingProfileHex(vector.profile),
        vector.digestHex,
        `${vector.name}: hex digest mismatch`
      );
    }
  });

  test("matches an independent SHA-256 implementation over the canonical preimage", () => {
    for (const vector of PROFILE_VECTORS) {
      const reference = createHash("sha256")
        .update(vector.canonical, "utf8")
        .digest("hex");
      assert.strictEqual(hashBankingProfileHex(vector.profile), reference);
    }
  });

  test("returns a plain 32-byte Uint8Array that formats to canonical hex", () => {
    const digest = hashBankingProfile({
      iban: "DE89370400440532013000",
      bic: "COBADEFFXXX",
    });

    assert.ok(digest instanceof Uint8Array);
    assert.strictEqual(digest.constructor, Uint8Array);
    assert.ok(!Buffer.isBuffer(digest));
    assert.strictEqual(digest.length, 32);

    const hex = formatBankingProfileHash(digest);
    assert.strictEqual(hex.length, 64);
    assert.match(hex, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual(Array.from(digest), Array.from(Buffer.from(hex, "hex")));
  });

  test("is deterministic across calls and property insertion order", () => {
    const first = hashBankingProfileHex({
      iban: "DE89370400440532013000",
      bic: "COBADEFFXXX",
    });
    const second = hashBankingProfileHex({
      bic: "COBADEFFXXX",
      iban: "DE89370400440532013000",
    });

    assert.strictEqual(first, second);
    assert.strictEqual(canonicalizeBankingProfile({ bic: "COBADEFFXXX", iban: "DE89370400440532013000" }),
      "IBAN: DE89370400440532013000 / BIC: COBADEFFXXX");
  });

  test("normalizes whitespace, grouping, and case before hashing", () => {
    const expected = PROFILE_VECTORS[0].digestHex;

    assert.strictEqual(
      hashBankingProfileHex({
        iban: "  de89 3704 0044 0532 0130 00  ",
        bic: "cobadeffxxx",
      }),
      expected
    );
    assert.strictEqual(
      hashBankingProfileHex({
        iban: "DE89\t3704 0044 0532 0130 00",
        bic: " COBADEFFXXX ",
      }),
      expected
    );
  });

  test("does not mutate the caller's profile", () => {
    const profile: BankingProfile = {
      iban: "de89 3704 0044 0532 0130 00",
      bic: "cobadeffxxx",
    };
    const snapshot = { ...profile };

    hashBankingProfile(profile);

    assert.deepStrictEqual(profile, snapshot);
  });

  test("distinct profiles yield distinct commitments", () => {
    const ibanOnly = hashBankingProfileHex({ iban: "DE89370400440532013000" });
    const withBic = hashBankingProfileHex({
      iban: "DE89370400440532013000",
      bic: "COBADEFFXXX",
    });
    const otherIban = hashBankingProfileHex({
      iban: "DE89370400440532013001",
    });

    assert.notStrictEqual(ibanOnly, withBic);
    assert.notStrictEqual(ibanOnly, otherIban);
    assert.notStrictEqual(withBic, otherIban);
  });

  test("accounts for every provided field in the commitment", () => {
    const base = {
      iban: "DE89370400440532013000",
      bic: "COBADEFFXXX",
    };

    assert.notStrictEqual(
      hashBankingProfileHex(base),
      hashBankingProfileHex({ ...base, accountNumber: "0123456789" })
    );
    assert.notStrictEqual(
      hashBankingProfileHex({ ...base, accountNumber: "0123456789" }),
      hashBankingProfileHex({
        ...base,
        accountNumber: "0123456789",
        bankCode: "058",
      })
    );
  });

  test("accepts IBAN and BIC boundary lengths", () => {
    const minIban = `DE00${"1".repeat(11)}`;
    const maxIban = `DE00${"1".repeat(30)}`;
    assert.strictEqual(minIban.length, 15);
    assert.strictEqual(maxIban.length, 34);

    assert.strictEqual(
      canonicalizeBankingProfile({ iban: minIban }),
      `IBAN: ${minIban}`
    );
    assert.strictEqual(
      Buffer.from(hashBankingProfile({ iban: maxIban })).toString("hex").length,
      64
    );

    assert.doesNotThrow(() =>
      hashBankingProfile({ iban: "DE89370400440532013000", bic: "COBADEFF" })
    );
    assert.doesNotThrow(() =>
      hashBankingProfile({ iban: "DE89370400440532013000", bic: "COBADEFFXXX" })
    );
  });

  test("rejects non-object and structurally invalid profiles", () => {
    assert.throws(
      () => canonicalizeBankingProfile(null as unknown as BankingProfile),
      /must be an object/
    );
    assert.throws(
      () => canonicalizeBankingProfile([] as unknown as BankingProfile),
      /must be an object/
    );
    assert.throws(
      () => canonicalizeBankingProfile({} as BankingProfile),
      /must include an iban or an accountNumber/
    );
    assert.throws(
      () => canonicalizeBankingProfile({ bic: "COBADEFFXXX" } as BankingProfile),
      /must include an iban or an accountNumber/
    );
    assert.throws(
      () => canonicalizeBankingProfile({ bankCode: "058" } as BankingProfile),
      /must include an iban or an accountNumber/
    );
  });

  test("rejects BIC without IBAN and bank code without account number", () => {
    assert.throws(
      () =>
        canonicalizeBankingProfile({
          accountNumber: "0123456789",
          bic: "COBADEFFXXX",
        } as BankingProfile),
      /"bic" requires an iban/
    );
    assert.throws(
      () =>
        canonicalizeBankingProfile({
          iban: "DE89370400440532013000",
          bankCode: "058",
        } as BankingProfile),
      /"bankCode" requires an accountNumber/
    );
  });

  test("rejects malformed IBAN values", () => {
    const invalidIbans = [
      `DE00${"1".repeat(10)}`, // 14 characters, too short
      `DE00${"1".repeat(31)}`, // 35 characters, too long
      "DE89-3704-0044-0532-0130-00", // unsupported punctuation
      "1E89370400440532013000", // country code must be letters
      "DEA9370400440532013000", // check digits must be numeric
      "DE893704004405320130@0", // unsupported character
    ];

    for (const iban of invalidIbans) {
      assert.throws(
        () => canonicalizeBankingProfile({ iban }),
        /not a valid IBAN/,
        `expected rejection for ${iban}`
      );
    }
  });

  test("rejects malformed BIC values", () => {
    for (const bic of ["COBADEF", "COBADEFFXX", "COBAD3FFXXX", "COBA-EFFXXX"]) {
      assert.throws(
        () =>
          canonicalizeBankingProfile({
            iban: "DE89370400440532013000",
            bic,
          }),
        /not a valid BIC/,
        `expected rejection for ${bic}`
      );
    }
  });

  test("rejects malformed account numbers and bank codes", () => {
    assert.throws(
      () => canonicalizeBankingProfile({ accountNumber: "0123/456789" }),
      /not a valid account number/
    );
    assert.throws(
      () => canonicalizeBankingProfile({ accountNumber: "1".repeat(35) }),
      /not a valid account number/
    );
    assert.throws(
      () =>
        canonicalizeBankingProfile({
          accountNumber: "0123456789",
          bankCode: "05/8",
        }),
      /not a valid bank code/
    );
    assert.throws(
      () =>
        canonicalizeBankingProfile({
          accountNumber: "0123456789",
          bankCode: "0".repeat(17),
        }),
      /not a valid bank code/
    );
  });

  test("rejects blank, non-string, and unsupported fields", () => {
    assert.throws(
      () => canonicalizeBankingProfile({ iban: "   " }),
      /cannot be empty/
    );
    assert.throws(
      () => canonicalizeBankingProfile({ accountNumber: "" }),
      /cannot be empty/
    );
    assert.throws(
      () => canonicalizeBankingProfile({ iban: 123 as unknown as string }),
      /must be a string/
    );
    assert.throws(
      () =>
        canonicalizeBankingProfile({
          iban: "DE89370400440532013000",
          ibann: "DE89370400440532013000",
        } as unknown as BankingProfile),
      /Unsupported banking profile field\(s\): ibann/
    );
  });

  test("formatBankingProfileHash enforces the 32-byte contract width", () => {
    assert.strictEqual(formatBankingProfileHash(new Uint8Array(32)), "0".repeat(64));
    assert.strictEqual(
      formatBankingProfileHash(new Uint8Array(32).fill(0xff)),
      "f".repeat(64)
    );

    assert.throws(
      () => formatBankingProfileHash(new Uint8Array(31)),
      /must be exactly 32 bytes \(got 31\)/
    );
    assert.throws(
      () => formatBankingProfileHash(new Uint8Array(33)),
      /must be exactly 32 bytes \(got 33\)/
    );
    assert.throws(
      () =>
        formatBankingProfileHash(
          [0, 1, 2] as unknown as Uint8Array
        ),
      /must be a Uint8Array/
    );
  });
});
