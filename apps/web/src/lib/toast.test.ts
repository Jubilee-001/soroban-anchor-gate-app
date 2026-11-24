import assert from "node:assert";
import { describe, test, beforeEach, afterEach } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Toast,
  ToastContainer,
  toast,
  toastManager,
  getStellarExpertUrl,
  formatTxHash,
  type ToastItem,
} from "../components/ui/Toast";

describe("Toast Notification System — Manager & Core Logic", () => {
  beforeEach(() => {
    toastManager.clear();
  });

  afterEach(() => {
    toastManager.clear();
  });

  test("1. adds info, success, error, and loading toast notifications", () => {
    const infoId = toast.info("Information Notice", { message: "System maintenance at midnight" });
    const successId = toast.success("Escrow Created", {
      message: "Funds successfully locked",
      txHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    });
    const errorId = toast.error("Transaction Rejected", { message: "User denied signing" });
    const loadingId = toast.loading("Submitting to Network...", { message: "Awaiting ledger close" });

    const snapshot = toastManager.getSnapshot();
    assert.strictEqual(snapshot.length, 4);

    const [infoToast, successToast, errorToast, loadingToast] = snapshot;

    assert.strictEqual(infoToast.id, infoId);
    assert.strictEqual(infoToast.type, "info");
    assert.strictEqual(infoToast.title, "Information Notice");
    assert.strictEqual(infoToast.duration, 6000);

    assert.strictEqual(successToast.id, successId);
    assert.strictEqual(successToast.type, "success");
    assert.strictEqual(successToast.title, "Escrow Created");
    assert.strictEqual(
      successToast.txHash,
      "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
    );
    assert.strictEqual(successToast.duration, 6000);

    assert.strictEqual(errorToast.id, errorId);
    assert.strictEqual(errorToast.type, "error");
    assert.strictEqual(errorToast.title, "Transaction Rejected");
    assert.strictEqual(errorToast.duration, 6000);

    assert.strictEqual(loadingToast.id, loadingId);
    assert.strictEqual(loadingToast.type, "loading");
    assert.strictEqual(loadingToast.title, "Submitting to Network...");
    assert.strictEqual(loadingToast.duration, 0, "Loading toast defaults to 0 (no auto-dismiss)");
  });

  test("2. auto-dismiss timing defaults to 6000ms (6 seconds)", () => {
    const id = toast.info("Standard Toast");
    const item = toastManager.getSnapshot().find((t) => t.id === id);
    assert.ok(item);
    assert.strictEqual(item.duration, 6000);

    const customId = toast.info("Custom Duration", { duration: 10000 });
    const customItem = toastManager.getSnapshot().find((t) => t.id === customId);
    assert.ok(customItem);
    assert.strictEqual(customItem.duration, 10000);
  });

  test("3. manual dismiss removes toast and executes onDismiss callback", () => {
    let dismissed = false;
    const id = toast.success("Payment Received", {
      onDismiss: () => {
        dismissed = true;
      },
    });

    assert.strictEqual(toastManager.getSnapshot().length, 1);
    toast.dismiss(id);

    assert.strictEqual(toastManager.getSnapshot().length, 0);
    assert.strictEqual(dismissed, true);
  });

  test("4. update transitions loading toast to success with transaction hash and duration reset", () => {
    const id = toast.loading("Executing Soroban Call...");
    const initial = toastManager.getSnapshot().find((t) => t.id === id);
    assert.ok(initial);
    assert.strictEqual(initial.type, "loading");
    assert.strictEqual(initial.duration, 0);

    const txHash = "f9e8d7c6b5a4f9e8d7c6b5a4f9e8d7c6b5a4f9e8d7c6b5a4f9e8d7c6b5a4f9e8";
    const ok = toast.update(id, {
      type: "success",
      title: "Contract Invocation Confirmed",
      message: "Included in ledger 5069999",
      txHash,
    });

    assert.strictEqual(ok, true);
    const updated = toastManager.getSnapshot().find((t) => t.id === id);
    assert.ok(updated);
    assert.strictEqual(updated.type, "success");
    assert.strictEqual(updated.title, "Contract Invocation Confirmed");
    assert.strictEqual(updated.message, "Included in ledger 5069999");
    assert.strictEqual(updated.txHash, txHash);
    assert.strictEqual(updated.duration, 6000, "Reset to standard 6s auto-dismiss upon completion");
  });

  test("5. clear removes all active notifications and cancels timers", () => {
    toast.info("Notice 1");
    toast.success("Notice 2");
    toast.error("Notice 3");

    assert.strictEqual(toastManager.getSnapshot().length, 3);
    toast.clear();
    assert.strictEqual(toastManager.getSnapshot().length, 0);
  });

  test("6. subscriber notification lifecycle", () => {
    let calls = 0;
    const unsubscribe = toastManager.subscribe(() => {
      calls++;
    });

    toast.info("Test Notification");
    assert.strictEqual(calls, 1);

    toast.clear();
    assert.strictEqual(calls, 2);

    unsubscribe();
    toast.info("Post-unsubscription notice");
    assert.strictEqual(calls, 2, "Unsubscribed listener should not receive updates");
  });

  test("7. toast.promise helper manages loading, success, and error flows", async () => {
    // Successful Promise Flow
    const successResult = await toast.promise(
      Promise.resolve({ hash: "tx_12345" }),
      {
        loading: "Simulating transaction...",
        success: (data) => ({
          title: "Simulation Passed",
          txHash: data.hash,
        }),
        error: "Simulation failed",
      }
    );

    assert.deepStrictEqual(successResult, { hash: "tx_12345" });
    const current = toastManager.getSnapshot();
    assert.strictEqual(current.length, 1);
    assert.strictEqual(current[0].type, "success");
    assert.strictEqual(current[0].title, "Simulation Passed");
    assert.strictEqual(current[0].txHash, "tx_12345");

    toastManager.clear();

    // Rejected Promise Flow
    await assert.rejects(
      async () => {
        await toast.promise(
          Promise.reject(new Error("Host simulation resource limit exceeded")),
          {
            loading: "Simulating transaction...",
            success: "Simulation passed",
            error: (err) => ({
              title: "Simulation Failed",
              message: (err as Error).message,
            }),
          }
        );
      },
      /Host simulation resource limit exceeded/
    );

    const errorToasts = toastManager.getSnapshot();
    assert.strictEqual(errorToasts.length, 1);
    assert.strictEqual(errorToasts[0].type, "error");
    assert.strictEqual(errorToasts[0].title, "Simulation Failed");
    assert.strictEqual(errorToasts[0].message, "Host simulation resource limit exceeded");
  });
});

describe("Stellar Expert Link & Tx Hash Formatting", () => {
  const sampleHash = "3cf68db8b00eff2368f979044537c9ef481c063eb8b00eff2368f979044537c9";

  test("1. getStellarExpertUrl generates correct testnet explorer URL by default", () => {
    const url = getStellarExpertUrl(sampleHash);
    assert.strictEqual(
      url,
      `https://stellar.expert/explorer/testnet/tx/${sampleHash}`
    );
  });

  test("2. getStellarExpertUrl generates correct public (mainnet) explorer URL", () => {
    const url = getStellarExpertUrl(sampleHash, "public");
    assert.strictEqual(
      url,
      `https://stellar.expert/explorer/public/tx/${sampleHash}`
    );
  });

  test("3. getStellarExpertUrl trims whitespace from txHash", () => {
    const url = getStellarExpertUrl(`  ${sampleHash}  `);
    assert.strictEqual(
      url,
      `https://stellar.expert/explorer/testnet/tx/${sampleHash}`
    );
  });

  test("4. formatTxHash shortens 64-character hash cleanly", () => {
    const formatted = formatTxHash(sampleHash);
    assert.strictEqual(formatted, "3cf68d...4537c9");
  });

  test("5. formatTxHash handles custom prefix and suffix lengths", () => {
    const formatted = formatTxHash(sampleHash, 4, 4);
    assert.strictEqual(formatted, "3cf6...37c9");
  });

  test("6. formatTxHash preserves short strings without truncation", () => {
    assert.strictEqual(formatTxHash("short"), "short");
    assert.strictEqual(formatTxHash(""), "");
  });
});

describe("Toast Component Rendering & Accessibility", () => {
  const dummyDismiss = () => {};

  test("1. renders info notification with accessible role and attributes", () => {
    const item: ToastItem = {
      id: "toast-1",
      type: "info",
      title: "Network Notice",
      message: "Soroban RPC latency nominal",
      network: "testnet",
      duration: 6000,
      createdAt: Date.now(),
    };

    const html = renderToStaticMarkup(
      React.createElement(Toast, { toast: item, onDismiss: dummyDismiss })
    );

    assert.ok(html.includes('role="status"'), "Info toast must have role='status'");
    assert.ok(html.includes('aria-live="polite"'), "Info toast must be polite");
    assert.ok(html.includes("Network Notice"));
    assert.ok(html.includes("Soroban RPC latency nominal"));
    assert.ok(html.includes('data-testid="toast-info"'));
    assert.ok(html.includes('aria-label="Close notification"'));
  });

  test("2. renders error notification with assertive alert role", () => {
    const item: ToastItem = {
      id: "toast-2",
      type: "error",
      title: "Wallet Signing Failed",
      message: "User canceled Freighter prompt",
      network: "testnet",
      duration: 6000,
      createdAt: Date.now(),
    };

    const html = renderToStaticMarkup(
      React.createElement(Toast, { toast: item, onDismiss: dummyDismiss })
    );

    assert.ok(html.includes('role="alert"'), "Error toast must have role='alert'");
    assert.ok(html.includes('aria-live="assertive"'), "Error toast must be assertive");
    assert.ok(html.includes("Wallet Signing Failed"));
    assert.ok(html.includes("User canceled Freighter prompt"));
    assert.ok(html.includes('data-testid="toast-error"'));
  });

  test("3. renders success notification with copyable txHash and Stellar Expert link", () => {
    const txHash = "e0b574826b1c8f00123456789abcdef0123456789abcdef0123456789abcdef0";
    const item: ToastItem = {
      id: "toast-3",
      type: "success",
      title: "Escrow Deposit Complete",
      message: "1,500 USDC locked",
      txHash,
      network: "testnet",
      duration: 6000,
      createdAt: Date.now(),
    };

    const html = renderToStaticMarkup(
      React.createElement(Toast, { toast: item, onDismiss: dummyDismiss })
    );

    assert.ok(html.includes('data-testid="toast-success"'));
    assert.ok(html.includes('data-testid="toast-tx-section"'));
    assert.ok(html.includes("e0b574...bcdef0"));
    assert.ok(html.includes('data-testid="toast-copy-btn"'));
    assert.ok(html.includes('aria-label="Copy transaction hash"'));

    // Verify Stellar Expert Anchor Link
    assert.ok(
      html.includes(
        `href="https://stellar.expert/explorer/testnet/tx/${txHash}"`
      ),
      "Must contain direct Stellar Expert explorer link"
    );
    assert.ok(html.includes('target="_blank"'), "External link must open in new tab");
    assert.ok(
      html.includes('rel="noopener noreferrer"'),
      "External link must secure opener context"
    );
    assert.ok(html.includes("Stellar Expert"));
  });

  test("4. renders loading notification with animated spinner", () => {
    const item: ToastItem = {
      id: "toast-4",
      type: "loading",
      title: "Polling Ledger Inclusion",
      message: "Attempt 3 of 10...",
      network: "testnet",
      duration: 0,
      createdAt: Date.now(),
    };

    const html = renderToStaticMarkup(
      React.createElement(Toast, { toast: item, onDismiss: dummyDismiss })
    );

    assert.ok(html.includes('data-testid="toast-loading"'));
    assert.ok(html.includes("animate-spin"));
    assert.ok(html.includes("Polling Ledger Inclusion"));
    assert.ok(html.includes("Attempt 3 of 10..."));
  });

  test("5. ToastContainer returns null when no toasts are present", () => {
    toastManager.clear();
    const html = renderToStaticMarkup(React.createElement(ToastContainer));
    assert.strictEqual(html, "");
  });

  test("6. ToastContainer renders active stacked toasts", () => {
    toastManager.clear();
    toast.info("Notice Alpha");
    toast.success("Notice Beta");

    const html = renderToStaticMarkup(React.createElement(ToastContainer));
    assert.ok(html.includes('data-testid="toast-container"'));
    assert.ok(html.includes("Notice Alpha"));
    assert.ok(html.includes("Notice Beta"));
    assert.ok(html.includes("bottom-4 right-4"), "Defaults to bottom-right positioning");
  });

  test("7. renders action button when provided", () => {
    const item: ToastItem = {
      id: "toast-action",
      type: "info",
      title: "Update Available",
      message: "Reload to apply latest patch",
      network: "testnet",
      duration: 6000,
      createdAt: Date.now(),
      action: {
        label: "Reload Now",
        onClick: () => {},
      },
    };

    const html = renderToStaticMarkup(
      React.createElement(Toast, { toast: item, onDismiss: dummyDismiss })
    );

    assert.ok(html.includes("Reload Now"));
  });
});
