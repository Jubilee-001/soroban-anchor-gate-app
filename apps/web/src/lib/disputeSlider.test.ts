import assert from "node:assert";
import { describe, test } from "node:test";
import {
  computeSplit,
  validateSplit,
  formatBps,
  disputeReducer,
  initialDisputeState,
  MAX_BPS,
  type DisputeState,
} from "../components/DisputeSlider";

const baseState: DisputeState = initialDisputeState();

describe("DisputeSlider split math", () => {
  test("computeSplit converts basis points to percentages", () => {
    assert.deepStrictEqual(computeSplit(6000), { payerPct: 60, beneficiaryPct: 40 });
    assert.deepStrictEqual(computeSplit(0), { payerPct: 0, beneficiaryPct: 100 });
    assert.deepStrictEqual(computeSplit(10000), { payerPct: 100, beneficiaryPct: 0 });
    assert.deepStrictEqual(computeSplit(2500), { payerPct: 25, beneficiaryPct: 75 });
  });

  test("computeSplit clamps out-of-range values", () => {
    assert.deepStrictEqual(computeSplit(-100), { payerPct: 0, beneficiaryPct: 100 });
    assert.deepStrictEqual(computeSplit(20000), { payerPct: 100, beneficiaryPct: 0 });
  });

  test("validateSplit accepts splits summing to 100%", () => {
    assert.strictEqual(validateSplit(6000, 4000).valid, true);
    assert.strictEqual(validateSplit(0, 10000).valid, true);
    assert.strictEqual(validateSplit(5000, 5000).valid, true);
  });

  test("validateSplit rejects negative or non-100-percent splits", () => {
    assert.strictEqual(validateSplit(-100, 10100).valid, false);
    assert.strictEqual(validateSplit(6000, 5000).valid, false);
    assert.strictEqual(validateSplit(6000, 4001).valid, false);
    assert.ok(validateSplit(6000, 5000).error?.includes("100%"));
  });

  test("formatBps renders basis points as percent", () => {
    assert.strictEqual(formatBps(6000), "60.00%");
    assert.strictEqual(formatBps(0), "0.00%");
    assert.strictEqual(formatBps(10000), "100.00%");
    assert.strictEqual(formatBps(3333), "33.33%");
  });
});

describe("Arbiter dispute interface state logic", () => {
  test("initialDisputeState starts at 60/40 with idle status and evidence", () => {
    assert.strictEqual(baseState.payerBps, 6000);
    assert.strictEqual(baseState.beneficiaryBps, 4000);
    assert.strictEqual(baseState.status, "idle");
    assert.strictEqual(baseState.error, null);
    assert.strictEqual(baseState.txHash, null);
    assert.strictEqual(baseState.evidence.length, 2);
    assert.ok(baseState.evidence.some((e) => e.description === "Milestone invoice"));
    assert.ok(baseState.evidence.some((e) => e.url.startsWith("https://")));
  });

  test("setRatio updates the split and resets submission state", () => {
    let s = disputeReducer(baseState, { type: "setRatio", payerBps: 3000 });
    assert.strictEqual(s.payerBps, 3000);
    assert.strictEqual(s.beneficiaryBps, 7000);
    assert.strictEqual(s.status, "idle");
    assert.strictEqual(s.error, null);

    s = disputeReducer(s, { type: "setRatio", payerBps: 7000 });
    assert.strictEqual(s.payerBps, 7000);
    assert.strictEqual(s.beneficiaryBps, 3000);
  });

  test("setRatio clamps to valid basis point range", () => {
    const low = disputeReducer(baseState, { type: "setRatio", payerBps: -500 });
    assert.strictEqual(low.payerBps, 0);
    assert.strictEqual(low.beneficiaryBps, MAX_BPS);
    const high = disputeReducer(baseState, { type: "setRatio", payerBps: 20000 });
    assert.strictEqual(high.payerBps, MAX_BPS);
    assert.strictEqual(high.beneficiaryBps, 0);
  });

  test("submitRequest transitions to submitting", () => {
    const s = disputeReducer(baseState, { type: "submitRequest" });
    assert.strictEqual(s.status, "submitting");
    assert.strictEqual(s.error, null);
    assert.strictEqual(s.txHash, null);
  });

  test("submitSuccess records the transaction hash", () => {
    const submitting = disputeReducer(baseState, { type: "submitRequest" });
    const s = disputeReducer(submitting, { type: "submitSuccess", txHash: "resolve_dispute_3" });
    assert.strictEqual(s.status, "success");
    assert.strictEqual(s.txHash, "resolve_dispute_3");
    assert.strictEqual(s.error, null);
  });

  test("submitFailure records the error", () => {
    const submitting = disputeReducer(baseState, { type: "submitRequest" });
    const s = disputeReducer(submitting, { type: "submitFailure", error: "Insufficient balance" });
    assert.strictEqual(s.status, "error");
    assert.strictEqual(s.error, "Insufficient balance");
    assert.strictEqual(s.txHash, null);
  });

  test("reset returns to initial state", () => {
    const edited = disputeReducer(baseState, { type: "setRatio", payerBps: 1000 });
    const reset = disputeReducer(edited, { type: "reset" });
    assert.deepStrictEqual(reset, initialDisputeState());
    assert.strictEqual(reset.payerBps, 6000);
    assert.strictEqual(reset.status, "idle");
  });

  test("overrides are applied to initial state", () => {
    const s = initialDisputeState({ escrowId: "9", payerBps: 2000 });
    assert.strictEqual(s.escrowId, "9");
    assert.strictEqual(s.payerBps, 2000);
    assert.strictEqual(s.beneficiaryBps, 8000);
  });
});
