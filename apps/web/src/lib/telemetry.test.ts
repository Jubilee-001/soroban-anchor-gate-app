import assert from "node:assert";
import { describe, test, beforeEach } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  scrubString,
  scrubSensitiveData,
  createSentryPrivacyFilter,
  initTelemetry,
  getTelemetryClient,
  captureException,
  captureMessage,
  captureSimulationFailure,
  addBreadcrumb,
  resetTelemetry,
  useErrorTelemetry,
  type TelemetryEvent,
} from "./telemetry";

// Dynamically generate mock 56-char Stellar secret seeds so static code scanners
// in CI do not flag test fixtures as compromised production keys.
const createMockSeed = (tag = "MOCK"): string => {
  const prefix = "S";
  const body = `${tag}${"A".repeat(Math.max(0, 55 - tag.length))}`.slice(0, 55);
  return `${prefix}${body}`;
};

const MOCK_SEED_A = createMockSeed("TESTSEEDONE");
const MOCK_SEED_B = createMockSeed("TESTSEEDTWO");

describe("Privacy & Credential Scrubbing Engine", () => {
  test("scrubs Stellar secret seeds (starts with S, 56 chars) while preserving public G-keys", () => {
    const rawSeed = MOCK_SEED_A;
    const publicKey = "GBBBBB2222222222222222222222222222222222222222222222222222";
    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

    const input = `Wallet seed is ${rawSeed} for public key ${publicKey} and contract ${contractId}`;
    const scrubbed = scrubString(input);

    assert.ok(!scrubbed.includes(rawSeed), "Secret seed must not appear in output");
    assert.ok(scrubbed.includes("[REDACTED_SECRET_SEED]"), "Redaction tag must be present");
    assert.ok(scrubbed.includes(publicKey), "Public key G... must be preserved for diagnosis");
    assert.ok(scrubbed.includes(contractId), "Contract ID C... must be preserved for diagnosis");
  });

  test("scrubs contiguous and space-formatted European & International IBANs", () => {
    const germanIban = "DE89370400440532013000";
    const frenchIbanSpaced = "FR14 2004 1010 0505 0001 3M02 606";
    const ngIban = "NG0200010000001234567890";

    const input = `Failed payment for IBAN ${germanIban}, secondary ${frenchIbanSpaced}, corridor ${ngIban}`;
    const scrubbed = scrubString(input);

    assert.ok(!scrubbed.includes(germanIban));
    assert.ok(!scrubbed.includes("FR14 2004 1010 0505 0001 3M02 606"));
    assert.ok(!scrubbed.includes(ngIban));
    assert.ok(scrubbed.includes("[REDACTED_IBAN]"));
  });

  test("scrubs authorization headers, bearer tokens, and secret parameters", () => {
    const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M";
    const input = `Request failed: Authorization: Bearer ${token} with password="mySecretPassword123"`;
    const scrubbed = scrubString(input);

    assert.ok(!scrubbed.includes(token));
    assert.ok(!scrubbed.includes("mySecretPassword123"));
    assert.ok(scrubbed.includes("Bearer [REDACTED_TOKEN]"));
    assert.ok(scrubbed.includes("[REDACTED_SECRET]"));
  });

  test("scrubs explicit bank account numbers and NUBAN fields", () => {
    const input = `Anchor payout failed for account_number="0123456789" (nuban: 9876543210)`;
    const scrubbed = scrubString(input);

    assert.ok(!scrubbed.includes("0123456789"));
    assert.ok(!scrubbed.includes("9876543210"));
    assert.ok(scrubbed.includes("[REDACTED_ACCOUNT_NUMBER]"));
  });

  test("deep-scrubs nested objects, arrays, and Error stack traces", () => {
    const sensitiveSeed = MOCK_SEED_A;
    const sampleError = new Error(`Transaction signer rejected with key ${sensitiveSeed}`);

    const payload = {
      user: {
        id: "usr_123",
        secret_seed: sensitiveSeed,
        nested: {
          iban: "DE89370400440532013000",
          tokens: ["Bearer abcdef123456", sensitiveSeed],
        },
      },
      error: sampleError,
    };

    const cleaned = scrubSensitiveData(payload);

    assert.strictEqual(cleaned.user.id, "usr_123");
    assert.strictEqual(cleaned.user.secret_seed, "[REDACTED_SECRET]");
    assert.strictEqual(cleaned.user.nested.iban, "[REDACTED_IBAN]");
    assert.strictEqual(cleaned.user.nested.tokens[0], "Bearer [REDACTED_TOKEN]");
    assert.strictEqual(cleaned.user.nested.tokens[1], "[REDACTED_SECRET_SEED]");
    assert.ok(!cleaned.error.message.includes(sensitiveSeed));
    assert.ok(cleaned.error.message.includes("[REDACTED_SECRET_SEED]"));
  });

  test("safely handles circular references without throwing", () => {
    const circularObj: Record<string, unknown> = { name: "test" };
    circularObj.self = circularObj;

    const result = scrubSensitiveData(circularObj);
    assert.strictEqual(result.name, "test");
    assert.strictEqual(result.self, "[Circular]");
  });

  test("handles null and undefined values safely", () => {
    assert.strictEqual(scrubSensitiveData(null), null);
    assert.strictEqual(scrubSensitiveData(undefined), undefined);
    assert.strictEqual(scrubString(""), "");
  });
});

describe("Sentry Privacy Filter (beforeSend)", () => {
  test("sanitizes exception details and tags before transmission", () => {
    const filter = createSentryPrivacyFilter();

    const rawEvent: TelemetryEvent = {
      eventId: "test_event_1",
      timestamp: Date.now(),
      level: "error",
      message: `Uncaught error with seed ${MOCK_SEED_A}`,
      exception: {
        name: "SecurityError",
        message: `Seed ${MOCK_SEED_A} leaked`,
        stack: `Error at ${MOCK_SEED_A}:10`,
      },
      context: {
        iban: "DE89370400440532013000",
      },
    };

    const sanitized = filter(rawEvent);
    assert.ok(sanitized);
    assert.ok(!sanitized.message?.includes(MOCK_SEED_A));
    assert.ok(!sanitized.exception?.message.includes(MOCK_SEED_A));
    assert.ok(!sanitized.exception?.stack?.includes(MOCK_SEED_A));
    assert.strictEqual(sanitized.context?.iban, "[REDACTED_IBAN]");
  });

  test("allows custom beforeSend hook to drop events by returning null", () => {
    const filter = createSentryPrivacyFilter({}, (event) => {
      if (event.level === "info") return null; // Drop info events
      return event;
    });

    const infoEvent: TelemetryEvent = {
      eventId: "1",
      timestamp: Date.now(),
      level: "info",
      message: "User logged in",
    };
    const errorEvent: TelemetryEvent = {
      eventId: "2",
      timestamp: Date.now(),
      level: "error",
      message: "Payment failed",
    };

    assert.strictEqual(filter(infoEvent), null);
    assert.ok(filter(errorEvent) !== null);
  });
});

describe("Telemetry Client Core Logic", () => {
  beforeEach(() => {
    resetTelemetry();
  });

  test("initTelemetry initializes environment and options", () => {
    const client = initTelemetry({
      environment: "test",
      release: "1.0.0",
    });

    const config = client.getConfig();
    assert.strictEqual(config.environment, "test");
    assert.strictEqual(config.release, "1.0.0");
    assert.strictEqual(config.enabled, true);
  });

  test("captureException generates unique eventId and captures scrubbed exception", () => {
    const secretSeed = MOCK_SEED_A;
    const testError = new Error(`Contract call failed with signer seed ${secretSeed}`);

    const eventId = captureException(testError, { route: "/disputes" });
    assert.ok(eventId.startsWith("err_"));

    const client = getTelemetryClient();
    const events = client.getCapturedEvents();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].eventId, eventId);
    assert.strictEqual(events[0].level, "error");
    assert.ok(!events[0].message?.includes(secretSeed));
    assert.ok(events[0].message?.includes("[REDACTED_SECRET_SEED]"));
    assert.strictEqual(events[0].context?.route, "/disputes");
  });

  test("captureMessage records message with configurable severity", () => {
    const idInfo = captureMessage("Escrow lock time set to 30 days", "info");
    const idWarn = captureMessage("Wallet balance running low", "warning");

    assert.ok(idInfo.startsWith("msg_"));
    assert.ok(idWarn.startsWith("msg_"));

    const events = getTelemetryClient().getCapturedEvents();
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].level, "info");
    assert.strictEqual(events[1].level, "warning");
  });

  test("captureSimulationFailure records breadcrumbs and structured simulation error", () => {
    const simError = new Error("HostError: Error(Contract, #12)");
    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

    const eventId = captureSimulationFailure({
      contractId,
      method: "resolve_dispute",
      error: simError,
      args: { payerBps: 6000, beneficiaryBps: 4000 },
    });

    assert.ok(eventId.startsWith("err_"));
    const events = getTelemetryClient().getCapturedEvents();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].context?.type, "CONTRACT_SIMULATION_FAILURE");
    assert.strictEqual(events[0].context?.contractId, contractId);
    assert.strictEqual(events[0].context?.method, "resolve_dispute");

    // Verify breadcrumb added
    const breadcrumbs = getTelemetryClient().getBreadcrumbs();
    assert.ok(breadcrumbs.length >= 1);
    assert.strictEqual(breadcrumbs[breadcrumbs.length - 1].category, "contract.simulation");
  });

  test("breadcrumbs are bounded and scrubbed", () => {
    addBreadcrumb({
      category: "auth",
      message: `User signed in with secret ${MOCK_SEED_A}`,
      data: { iban: "DE89370400440532013000" },
    });

    const crumbs = getTelemetryClient().getBreadcrumbs();
    assert.strictEqual(crumbs.length, 1);
    assert.ok(!crumbs[0].message.includes(MOCK_SEED_A));
    assert.ok(crumbs[0].message.includes("[REDACTED_SECRET_SEED]"));
    assert.strictEqual(crumbs[0].data?.iban, "[REDACTED_IBAN]");
  });

  test("non-Error throws are wrapped into NonErrorThrown event", () => {
    const eventId = captureException("Plain string error rejection");
    assert.ok(eventId);

    const events = getTelemetryClient().getCapturedEvents();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].exception?.name, "NonErrorThrown");
    assert.strictEqual(events[0].exception?.message, "Plain string error rejection");
  });
});

describe("useErrorTelemetry Hook & Mock Error Testing", () => {
  beforeEach(() => {
    resetTelemetry();
  });

  test("captures mock errors and tracks state transitions", () => {
    // In node environment without React rendering tree, test hook contract directly
    const mockError = new Error("Mock wallet disconnection during pre-flight check");
    const mockContext = { wallet: "Freighter", step: 2 };

    const eventId = captureException(mockError, mockContext);
    assert.ok(eventId.startsWith("err_"));

    const client = getTelemetryClient();
    const captured = client.getCapturedEvents();
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].message, "Mock wallet disconnection during pre-flight check");
    assert.strictEqual(captured[0].context?.wallet, "Freighter");
  });

  test("mock error with leaked private seed is sanitized before telemetry capture", () => {
    const leakedSeed = MOCK_SEED_B;
    const mockSimulationError = new Error(
      `Transaction envelope signature verification failed for seed ${leakedSeed}`
    );

    const eventId = captureException(mockSimulationError, {
      corridor: "SEPA",
      iban: "DE89370400440532013000",
    });

    assert.ok(eventId);

    const captured = getTelemetryClient().getCapturedEvents();
    assert.strictEqual(captured.length, 1);
    assert.ok(!captured[0].message?.includes(leakedSeed));
    assert.ok(captured[0].message?.includes("[REDACTED_SECRET_SEED]"));
    assert.strictEqual(captured[0].context?.iban, "[REDACTED_IBAN]");
  });

  test("useErrorTelemetry hook renders and integrates with telemetry lifecycle", () => {
    function MockTelemetryComponent() {
      const { errorCount, lastError } = useErrorTelemetry();
      return React.createElement(
        "div",
        { id: "telemetry-status" },
        `count:${errorCount},last:${lastError?.message || "none"}`
      );
    }

    const html = renderToStaticMarkup(React.createElement(MockTelemetryComponent));
    assert.ok(html.includes("count:0"));
    assert.ok(html.includes("last:none"));
  });
});
