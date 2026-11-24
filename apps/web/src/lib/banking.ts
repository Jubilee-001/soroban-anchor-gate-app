import { hashRoutingInfo } from "./crypto";

export type BankCorridor = "SEPA" | "NGN" | "BRL";

export interface BankingProfile {
  countryCode: string;
  corridor?: BankCorridor;
  iban?: string;
  bic?: string;
  accountNumber?: string;
  accountHolderName?: string;
  bankName?: string;
}

export interface IbanValidationResult {
  valid: boolean;
  normalized?: string;
  countryCode?: string;
  corridor?: BankCorridor;
  error?: string;
}

export interface BankingCommitment {
  profileHash: string;
  countryCode: string;
  corridor?: BankCorridor;
  iban?: string;
  bic?: string;
  maskedAccountNumber?: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

const SEPA_COUNTRY_CODES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "ES", "FI", "FR", "DE",
  "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO",
  "SK", "SI", "SE", "GB", "CH", "LI", "MC", "SM", "AD", "GI", "IS", "ME",
  "AL", "NC", "PM", "BL", "GF", "TF", "YT", "MF", "RE",
]);

const SUPPORTED_COUNTRY_CODES = new Set([...SEPA_COUNTRY_CODES, "NG", "BR"]);

export function normalizeIban(iban: string): string {
  return iban.replace(/\s/g, "").toUpperCase();
}

export function corridorForCountry(countryCode: string): BankCorridor | undefined {
  const cc = countryCode.toUpperCase();
  if (cc === "NG") return "NGN";
  if (cc === "BR") return "BRL";
  if (SEPA_COUNTRY_CODES.has(cc)) return "SEPA";
  return undefined;
}

export function isSupportedCountry(countryCode: string): boolean {
  return SUPPORTED_COUNTRY_CODES.has(countryCode.toUpperCase());
}

export function ibanToNumeric(iban: string): string {
  return iban.replace(/[A-Z]/g, (ch) =>
    (ch.charCodeAt(0) - "A".charCodeAt(0) + 10).toString()
  );
}

export function validateIban(iban: string): IbanValidationResult {
  if (!iban || typeof iban !== "string") {
    return { valid: false, error: "IBAN is required" };
  }
  const normalized = normalizeIban(iban);
  if (normalized.length < 5) {
    return { valid: false, error: "IBAN is too short" };
  }
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(normalized)) {
    return {
      valid: false,
      error: "IBAN must begin with a 2-letter country code and 2 check digits",
    };
  }
  const countryCode = normalized.slice(0, 2);
  if (!isSupportedCountry(countryCode)) {
    return { valid: false, countryCode, error: `Unsupported country code: ${countryCode}` };
  }
  const corridor = corridorForCountry(countryCode);
  const rearranged = normalized.slice(4) + normalized.slice(0, 4);
  const numeric = ibanToNumeric(rearranged);
  let remainder = 0;
  for (let i = 0; i < numeric.length; i++) {
    remainder = (remainder * 10 + Number(numeric[i])) % 97;
  }
  if (remainder !== 1) {
    return { valid: false, normalized, countryCode, corridor, error: "IBAN check digits failed mod-97 validation" };
  }
  return { valid: true, normalized, countryCode, corridor };
}

export function validateBic(bic: string): ValidationResult {
  if (!bic || typeof bic !== "string") {
    return { valid: false, error: "BIC is required" };
  }
  const upper = bic.trim().toUpperCase();
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(upper)) {
    return { valid: false, error: "BIC must be 8 or 11 alphanumeric characters" };
  }
  return { valid: true };
}

export function validateAccountNumber(
  accountNumber: string,
  countryCode?: string
): ValidationResult {
  if (!accountNumber || typeof accountNumber !== "string") {
    return { valid: false, error: "Account number is required" };
  }
  const trimmed = accountNumber.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "Account number is required" };
  }
  if (!/^[A-Z0-9]+$/i.test(trimmed)) {
    return { valid: false, error: "Account number must be alphanumeric" };
  }
  if (trimmed.length > 34) {
    return { valid: false, error: "Account number must not exceed 34 characters" };
  }
  const cc = (countryCode || "").toUpperCase();
  if (cc === "NG" && !/^\d{10}$/.test(trimmed)) {
    return {
      valid: false,
      error: "NGN account number (NUBAN) must be exactly 10 digits",
    };
  }
  return { valid: true };
}

export function validateBankingProfile(profile: BankingProfile): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const cc = (profile.countryCode || "").trim().toUpperCase();

  if (!cc) {
    errors.push("Country code is required");
  } else if (!isSupportedCountry(cc)) {
    errors.push(`Unsupported country code: ${cc}`);
  }

  if (profile.iban) {
    const result = validateIban(profile.iban);
    if (!result.valid) {
      errors.push(result.error || "Invalid IBAN");
    } else if (cc && result.countryCode && result.countryCode !== cc) {
      errors.push(
        `IBAN country code ${result.countryCode} does not match profile country code ${cc}`
      );
    }
  }

  if (profile.bic) {
    const result = validateBic(profile.bic);
    if (!result.valid) {
      errors.push(result.error || "Invalid BIC");
    }
  }

  if (profile.accountNumber) {
    const result = validateAccountNumber(profile.accountNumber, cc);
    if (!result.valid) {
      errors.push(result.error || "Invalid account number");
    }
  }

  if (!profile.iban && !profile.accountNumber) {
    errors.push("Either IBAN or account number is required");
  }

  return { valid: errors.length === 0, errors };
}

export async function generateBankingProfileHash(
  profile: BankingProfile
): Promise<string> {
  const accountNumberHash = profile.accountNumber
    ? await hashRoutingInfo(`ACCOUNT_NUMBER:${profile.accountNumber.trim()}`)
    : undefined;
  const canonical = {
    countryCode: (profile.countryCode || "").toUpperCase(),
    corridor: profile.corridor,
    iban: profile.iban ? normalizeIban(profile.iban) : undefined,
    bic: profile.bic ? profile.bic.trim().toUpperCase() : undefined,
    accountNumberPresent: !!profile.accountNumber,
    accountNumberHash,
    accountHolderName: profile.accountHolderName
      ? profile.accountHolderName.trim()
      : undefined,
    bankName: profile.bankName ? profile.bankName.trim() : undefined,
  };
  return hashRoutingInfo(JSON.stringify(canonical));
}

export function maskAccountNumber(accountNumber: string): string {
  if (!accountNumber) return "";
  const trimmed = accountNumber.trim();
  if (trimmed.length <= 4) return trimmed;
  return "*".repeat(trimmed.length - 4) + trimmed.slice(-4);
}

export async function generateBankingProfileCommitment(
  profile: BankingProfile
): Promise<BankingCommitment> {
  const profileHash = await generateBankingProfileHash(profile);
  return {
    profileHash,
    countryCode: (profile.countryCode || "").toUpperCase(),
    corridor: profile.corridor,
    iban: profile.iban ? normalizeIban(profile.iban) : undefined,
    bic: profile.bic ? profile.bic.trim().toUpperCase() : undefined,
    maskedAccountNumber: maskAccountNumber(profile.accountNumber ?? ""),
  };
}
