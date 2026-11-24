import { useState, useCallback } from "react";

/**
 * Configuration options for scrubbing sensitive credentials and PII.
 */
export interface ScrubOptions {
  scrubStellarSecrets?: boolean;
  scrubPrivateKeys?: boolean;
  scrubIbans?: boolean;
  scrubAccountNumbers?: boolean;
  scrubAuthTokens?: boolean;
}

export const DEFAULT_SCRUB_OPTIONS: Required<ScrubOptions> = {
  scrubStellarSecrets: true,
  scrubPrivateKeys: true,
  scrubIbans: true,
  scrubAccountNumbers: true,
  scrubAuthTokens: true,
};

/**
 * Telemetry log severity levels aligned with Sentry Next.js SDK.
 */
export type SeverityLevel = "fatal" | "error" | "warning" | "info" | "debug";

export interface TelemetryBreadcrumb {
  timestamp: number;
  category?: string;
  message: string;
  level?: SeverityLevel;
  data?: Record<string, unknown>;
}

export interface TelemetryExceptionDetails {
  name: string;
  message: string;
  stack?: string;
}

export interface TelemetryEvent {
  eventId: string;
  timestamp: number;
  level: SeverityLevel;
  message?: string;
  exception?: TelemetryExceptionDetails;
  context?: Record<string, unknown>;
  tags?: Record<string, string>;
  breadcrumbs?: TelemetryBreadcrumb[];
  user?: {
    id?: string;
    walletAddress?: string;
  };
  extra?: Record<string, unknown>;
}

export interface TelemetryConfig {
  dsn?: string;
  environment?: string;
  enabled?: boolean;
  release?: string;
  sampleRate?: number;
  scrubOptions?: ScrubOptions;
  beforeSend?: (event: TelemetryEvent) => TelemetryEvent | null;
  onCapture?: (event: TelemetryEvent) => void;
}

/**
 * Regex patterns for sensitive financial and cryptographic tokens.
 */
// Stellar Secret Seed: Starts with 'S', 50 to 65 alphanumeric characters
const STELLAR_SECRET_SEED_REGEX = /\bS[A-Za-z0-9]{50,65}\b/g;

// Standard IBAN pattern: 2 country letters, 2 check digits, followed by 11 to 30 alphanumeric characters
const IBAN_PATTERN_REGEX = /\b[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}\b/g;

// Spaced IBAN pattern (e.g. DE89 3704 0044 0532 0130 00)
const SPACED_IBAN_PATTERN_REGEX =
  /\b[A-Z]{2}[0-9]{2}(?:\s+[A-Z0-9]{4}){2,7}(?:\s+[A-Z0-9]{1,4})?\b/gi;

// Bank account numbers / NUBAN patterns
const ACCOUNT_NUMBER_FIELD_REGEX =
  /(?:account[_-]?number|nuban|acc[_-]?no|accountnum)\s*[:=]\s*["']?([0-9]{8,18})["']?/gi;

// Authorization tokens (Bearer, Basic, API keys)
const BEARER_TOKEN_REGEX = /Bearer\s+[a-zA-Z0-9._~+/-]+/gi;
const AUTH_SECRET_FIELD_REGEX =
  /(?:password|auth[_-]?token|secret[_-]?key|secret[_-]?seed|private[_-]?key|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?([^"'&\s]+)["']?/gi;

/**
 * Scrubs secret seeds, private keys, IBANs, and credentials from a string.
 */
export function scrubString(
  input: string,
  options: ScrubOptions = DEFAULT_SCRUB_OPTIONS
): string {
  if (!input || typeof input !== "string") {
    return input;
  }

  const opts = { ...DEFAULT_SCRUB_OPTIONS, ...options };
  let result = input;

  // 1. Scrub Stellar Secret Seeds (starts with S, 56 chars)
  if (opts.scrubStellarSecrets) {
    result = result.replace(STELLAR_SECRET_SEED_REGEX, "[REDACTED_SECRET_SEED]");
  }

  // 2. Scrub Auth secrets & Bearer tokens
  if (opts.scrubAuthTokens) {
    result = result.replace(BEARER_TOKEN_REGEX, "Bearer [REDACTED_TOKEN]");
    result = result.replace(
      AUTH_SECRET_FIELD_REGEX,
      (match, val) => match.replace(val, "[REDACTED_SECRET]")
    );
  }

  // 3. Scrub IBANs (both contiguous and spaced)
  if (opts.scrubIbans) {
    result = result.replace(SPACED_IBAN_PATTERN_REGEX, "[REDACTED_IBAN]");
    result = result.replace(IBAN_PATTERN_REGEX, "[REDACTED_IBAN]");
  }

  // 4. Scrub explicit account numbers
  if (opts.scrubAccountNumbers) {
    result = result.replace(
      ACCOUNT_NUMBER_FIELD_REGEX,
      (match, num) => match.replace(num, "[REDACTED_ACCOUNT_NUMBER]")
    );
  }

  // 5. Scrub standalone 64-char hex private keys (only if explicitly enabled)
  if (opts.scrubPrivateKeys) {
    result = result.replace(
      /(?:private[_-]?key|secret)\s*[:=]\s*["']?([a-fA-F0-9]{64})["']?/gi,
      (match, key) => match.replace(key, "[REDACTED_PRIVATE_KEY]")
    );
  }

  return result;
}

/**
 * Recursively deep-scrubs data structures (objects, arrays, errors, primitives).
 */
export function scrubSensitiveData<T>(
  data: T,
  options: ScrubOptions = DEFAULT_SCRUB_OPTIONS,
  visited = new WeakSet()
): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === "string") {
    return scrubString(data, options) as unknown as T;
  }

  if (typeof data !== "object") {
    return data;
  }

  // Prevent circular references
  if (visited.has(data as object)) {
    return "[Circular]" as unknown as T;
  }
  visited.add(data as object);

  // Handle Error instances
  if (data instanceof Error) {
    const sanitizedError = new Error(scrubString(data.message, options));
    sanitizedError.name = data.name;
    if (data.stack) {
      sanitizedError.stack = scrubString(data.stack, options);
    }
    return sanitizedError as unknown as T;
  }

  // Handle Arrays
  if (Array.isArray(data)) {
    return data.map((item) =>
      scrubSensitiveData(item, options, visited)
    ) as unknown as T;
  }

  // Handle plain objects and dictionaries
  const sanitizedObj: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    // Immediate scrubbing for known sensitive property names
    if (
      lowerKey.includes("secret") ||
      lowerKey.includes("seed") ||
      lowerKey.includes("privatekey") ||
      lowerKey.includes("password") ||
      lowerKey.includes("authtoken")
    ) {
      sanitizedObj[key] = "[REDACTED_SECRET]";
    } else if (lowerKey.includes("iban")) {
      sanitizedObj[key] = "[REDACTED_IBAN]";
    } else if (
      lowerKey === "accountnumber" ||
      lowerKey === "nuban" ||
      lowerKey === "bankaccount"
    ) {
      sanitizedObj[key] = "[REDACTED_ACCOUNT_NUMBER]";
    } else {
      sanitizedObj[key] = scrubSensitiveData(val, options, visited);
    }
  }

  return sanitizedObj as T;
}

/**
 * Creates Sentry Next.js SDK compatible `beforeSend` privacy filter.
 */
export function createSentryPrivacyFilter(
  customOptions?: ScrubOptions,
  customBeforeSend?: (event: TelemetryEvent) => TelemetryEvent | null
) {
  return (event: TelemetryEvent): TelemetryEvent | null => {
    if (!event) return null;

    // Apply strict PII & secret scrubbing
    const scrubbed = scrubSensitiveData(event, customOptions);

    // Apply any secondary custom beforeSend filters
    if (customBeforeSend) {
      return customBeforeSend(scrubbed);
    }

    return scrubbed;
  };
}

/**
 * In-memory telemetry engine and event bus.
 */
class TelemetryClient {
  private config: TelemetryConfig;
  private breadcrumbs: TelemetryBreadcrumb[] = [];
  private capturedEvents: TelemetryEvent[] = [];
  private maxBreadcrumbs: number = 50;

  constructor(config: TelemetryConfig = {}) {
    this.config = {
      enabled: true,
      environment: process.env.NODE_ENV || "development",
      ...config,
    };
  }

  public updateConfig(config: Partial<TelemetryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  public getConfig(): TelemetryConfig {
    return { ...this.config };
  }

  public addBreadcrumb(
    breadcrumb: Omit<TelemetryBreadcrumb, "timestamp"> & { timestamp?: number }
  ): void {
    const entry: TelemetryBreadcrumb = {
      timestamp: breadcrumb.timestamp || Date.now(),
      category: breadcrumb.category || "ui",
      message: scrubString(breadcrumb.message, this.config.scrubOptions),
      level: breadcrumb.level || "info",
      data: breadcrumb.data
        ? scrubSensitiveData(breadcrumb.data, this.config.scrubOptions)
        : undefined,
    };

    this.breadcrumbs.push(entry);
    if (this.breadcrumbs.length > this.maxBreadcrumbs) {
      this.breadcrumbs.shift();
    }
  }

  public getBreadcrumbs(): TelemetryBreadcrumb[] {
    return [...this.breadcrumbs];
  }

  public clearBreadcrumbs(): void {
    this.breadcrumbs = [];
  }

  public getCapturedEvents(): TelemetryEvent[] {
    return [...this.capturedEvents];
  }

  public clearCapturedEvents(): void {
    this.capturedEvents = [];
  }

  public captureException(
    error: unknown,
    context?: Record<string, unknown>
  ): string {
    const eventId = `err_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    let exceptionDetails: TelemetryExceptionDetails;
    if (error instanceof Error) {
      exceptionDetails = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    } else {
      exceptionDetails = {
        name: "NonErrorThrown",
        message: String(error),
      };
    }

    const event: TelemetryEvent = {
      eventId,
      timestamp: Date.now(),
      level: "error",
      message: exceptionDetails.message,
      exception: exceptionDetails,
      context,
      breadcrumbs: [...this.breadcrumbs],
    };

    // Apply Sentry privacy filter
    const privacyFilter = createSentryPrivacyFilter(
      this.config.scrubOptions,
      this.config.beforeSend
    );
    const scrubbedEvent = privacyFilter(event);

    if (!scrubbedEvent) {
      return eventId;
    }

    this.capturedEvents.push(scrubbedEvent);
    this.config.onCapture?.(scrubbedEvent);

    return eventId;
  }

  public captureMessage(
    message: string,
    level: SeverityLevel = "info",
    context?: Record<string, unknown>
  ): string {
    const eventId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const event: TelemetryEvent = {
      eventId,
      timestamp: Date.now(),
      level,
      message,
      context,
      breadcrumbs: [...this.breadcrumbs],
    };

    const privacyFilter = createSentryPrivacyFilter(
      this.config.scrubOptions,
      this.config.beforeSend
    );
    const scrubbedEvent = privacyFilter(event);

    if (!scrubbedEvent) {
      return eventId;
    }

    this.capturedEvents.push(scrubbedEvent);
    this.config.onCapture?.(scrubbedEvent);

    return eventId;
  }

  /**
   * Captures Soroban smart contract simulation failures with method and arg context.
   */
  public captureSimulationFailure(params: {
    contractId: string;
    method: string;
    error: unknown;
    args?: Record<string, unknown>;
  }): string {
    this.addBreadcrumb({
      category: "contract.simulation",
      message: `Simulation failed on ${params.contractId}::${params.method}`,
      level: "warning",
      data: {
        contractId: params.contractId,
        method: params.method,
      },
    });

    return this.captureException(params.error, {
      type: "CONTRACT_SIMULATION_FAILURE",
      contractId: params.contractId,
      method: params.method,
      args: params.args,
    });
  }

  public reset(): void {
    this.breadcrumbs = [];
    this.capturedEvents = [];
    this.config = {
      enabled: true,
      environment: process.env.NODE_ENV || "development",
    };
  }
}

// Global Singleton Telemetry Instance
let globalTelemetryInstance: TelemetryClient | null = null;

export function getTelemetryClient(): TelemetryClient {
  if (!globalTelemetryInstance) {
    globalTelemetryInstance = new TelemetryClient();
  }
  return globalTelemetryInstance;
}

/**
 * Initializes Sentry-compatible telemetry with configuration options.
 */
export function initTelemetry(config: TelemetryConfig = {}): TelemetryClient {
  const client = getTelemetryClient();
  client.updateConfig(config);
  return client;
}

export function captureException(
  error: unknown,
  context?: Record<string, unknown>
): string {
  return getTelemetryClient().captureException(error, context);
}

export function captureMessage(
  message: string,
  level: SeverityLevel = "info",
  context?: Record<string, unknown>
): string {
  return getTelemetryClient().captureMessage(message, level, context);
}

export function captureSimulationFailure(params: {
  contractId: string;
  method: string;
  error: unknown;
  args?: Record<string, unknown>;
}): string {
  return getTelemetryClient().captureSimulationFailure(params);
}

export function addBreadcrumb(
  breadcrumb: Omit<TelemetryBreadcrumb, "timestamp"> & { timestamp?: number }
): void {
  getTelemetryClient().addBreadcrumb(breadcrumb);
}

export function resetTelemetry(): void {
  getTelemetryClient().reset();
}

/**
 * React hook for component-level error tracking and Sentry exception capture.
 */
export function useErrorTelemetry() {
  const [lastError, setLastError] = useState<Error | null>(null);
  const [lastEventId, setLastEventId] = useState<string | null>(null);
  const [errorCount, setErrorCount] = useState<number>(0);

  const captureError = useCallback(
    (error: unknown, context?: Record<string, unknown>): string => {
      const err = error instanceof Error ? error : new Error(String(error));
      const eventId = captureException(err, context);

      setLastError(err);
      setLastEventId(eventId);
      setErrorCount((prev) => prev + 1);

      return eventId;
    },
    []
  );

  const reset = useCallback(() => {
    setLastError(null);
    setLastEventId(null);
    setErrorCount(0);
  }, []);

  return {
    captureError,
    lastError,
    lastEventId,
    errorCount,
    reset,
    addBreadcrumb,
  };
}
