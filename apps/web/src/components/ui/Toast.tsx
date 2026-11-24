"use client";

import React, { useState, useEffect, useSyncExternalStore, useCallback } from "react";
import {
  Info,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Copy,
  Check,
  ExternalLink,
  X,
} from "lucide-react";

export type ToastType = "info" | "success" | "error" | "loading";

export type StellarNetwork = "testnet" | "public";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  id?: string;
  type?: ToastType;
  title: string;
  message?: string;
  txHash?: string;
  network?: StellarNetwork;
  duration?: number; // Duration in ms. Default is 6000ms. 0 or Infinity = permanent until manual dismiss.
  onDismiss?: () => void;
  action?: ToastAction;
}

export interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  txHash?: string;
  network: StellarNetwork;
  duration: number;
  onDismiss?: () => void;
  action?: ToastAction;
  createdAt: number;
}

/**
 * Builds the authoritative Stellar Expert block explorer URL for a given transaction hash.
 */
export function getStellarExpertUrl(
  txHash: string,
  network: StellarNetwork = "testnet"
): string {
  const cleanHash = (txHash || "").trim();
  const net = network === "public" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${net}/tx/${cleanHash}`;
}

/**
 * Formats a 64-character Stellar transaction hash into a clean, truncated representation.
 */
export function formatTxHash(txHash: string, prefixLen = 6, suffixLen = 6): string {
  const clean = (txHash || "").trim();
  if (!clean || clean.length <= prefixLen + suffixLen) {
    return clean;
  }
  return `${clean.slice(0, prefixLen)}...${clean.slice(-suffixLen)}`;
}

/**
 * Singleton Toast Manager providing an observable external store compatible with React 19 useSyncExternalStore.
 */
export class ToastManager {
  private toasts: ToastItem[] = [];
  private listeners = new Set<() => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private counter = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ToastItem[] => {
    return this.toasts;
  };

  getServerSnapshot = (): ToastItem[] => {
    return this.toasts;
  };

  private notify() {
    this.listeners.forEach((listener) => listener());
  }

  add = (options: ToastOptions): string => {
    const id = options.id || `toast-${++this.counter}-${Date.now()}`;
    const type = options.type || "info";
    // Loading toasts default to 0 (persist until resolved), all others default to 6000ms (6 seconds)
    const duration =
      options.duration !== undefined
        ? options.duration
        : type === "loading"
          ? 0
          : 6000;

    const existingIndex = this.toasts.findIndex((t) => t.id === id);
    const toastItem: ToastItem = {
      id,
      type,
      title: options.title,
      message: options.message,
      txHash: options.txHash?.trim(),
      network: options.network || "testnet",
      duration,
      onDismiss: options.onDismiss,
      action: options.action,
      createdAt: Date.now(),
    };

    if (existingIndex >= 0) {
      this.clearTimer(id);
      this.toasts = [
        ...this.toasts.slice(0, existingIndex),
        toastItem,
        ...this.toasts.slice(existingIndex + 1),
      ];
    } else {
      this.toasts = [...this.toasts, toastItem];
    }

    if (duration > 0 && typeof window !== "undefined") {
      this.scheduleDismiss(id, duration);
    }

    this.notify();
    return id;
  };

  dismiss = (id: string): void => {
    this.clearTimer(id);
    const toast = this.toasts.find((t) => t.id === id);
    if (!toast) return;

    this.toasts = this.toasts.filter((t) => t.id !== id);
    try {
      toast.onDismiss?.();
    } catch {
      // Guard against callback exceptions
    }
    this.notify();
  };

  update = (id: string, updates: Partial<ToastOptions>): boolean => {
    const existing = this.toasts.find((t) => t.id === id);
    if (!existing) return false;

    this.clearTimer(id);
    const updatedType = updates.type || existing.type;
    // If transitioning from loading to a resolved state without explicit duration, reset to standard 6s auto-dismiss
    const duration =
      updates.duration !== undefined
        ? updates.duration
        : updates.type && updates.type !== "loading" && existing.duration === 0
          ? 6000
          : existing.duration;

    const updatedToast: ToastItem = {
      ...existing,
      ...updates,
      id,
      type: updatedType,
      title: updates.title !== undefined ? updates.title : existing.title,
      duration,
      network: updates.network || existing.network,
      txHash: updates.txHash !== undefined ? updates.txHash?.trim() : existing.txHash,
    };

    this.toasts = this.toasts.map((t) => (t.id === id ? updatedToast : t));

    if (duration > 0 && typeof window !== "undefined") {
      this.scheduleDismiss(id, duration);
    }

    this.notify();
    return true;
  };

  clear = (): void => {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    this.toasts = [];
    this.notify();
  };

  private scheduleDismiss(id: string, duration: number) {
    this.clearTimer(id);
    const timer = setTimeout(() => {
      this.dismiss(id);
    }, duration);
    this.timers.set(id, timer);
  }

  private clearTimer(id: string) {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  getActiveTimerCount = (): number => {
    return this.timers.size;
  };
}

export const toastManager = new ToastManager();

/**
 * Global toast dispatch helper.
 */
export const toast = (options: ToastOptions) => toastManager.add(options);
toast.info = (title: string, options?: Omit<ToastOptions, "title" | "type">) =>
  toastManager.add({ ...options, title, type: "info" });
toast.success = (title: string, options?: Omit<ToastOptions, "title" | "type">) =>
  toastManager.add({ ...options, title, type: "success" });
toast.error = (title: string, options?: Omit<ToastOptions, "title" | "type">) =>
  toastManager.add({ ...options, title, type: "error" });
toast.loading = (title: string, options?: Omit<ToastOptions, "title" | "type">) =>
  toastManager.add({ ...options, title, type: "loading" });
toast.dismiss = (id: string) => toastManager.dismiss(id);
toast.update = (id: string, updates: Partial<ToastOptions>) => toastManager.update(id, updates);
toast.clear = () => toastManager.clear();

/**
 * Async promise wrapper for Stellar transaction lifecycles.
 */
toast.promise = async <T,>(
  promise: Promise<T>,
  messages: {
    loading: string;
    success: string | ((data: T) => { title: string; message?: string; txHash?: string });
    error: string | ((err: unknown) => { title: string; message?: string });
  },
  options?: Omit<ToastOptions, "title" | "type">
): Promise<T> => {
  const id = toast.loading(messages.loading, options);
  try {
    const result = await promise;
    if (typeof messages.success === "function") {
      const resolved = messages.success(result);
      toast.update(id, { ...resolved, type: "success" });
    } else {
      toast.update(id, { title: messages.success, type: "success" });
    }
    return result;
  } catch (err) {
    if (typeof messages.error === "function") {
      const resolved = messages.error(err);
      toast.update(id, { ...resolved, type: "error" });
    } else {
      toast.update(id, { title: messages.error, type: "error" });
    }
    throw err;
  }
};

/**
 * React hook accessing current active toasts and dispatch actions.
 */
export function useToast() {
  const toasts = useSyncExternalStore(
    toastManager.subscribe,
    toastManager.getSnapshot,
    toastManager.getServerSnapshot
  );

  return {
    toasts,
    toast,
    dismiss: toastManager.dismiss,
    update: toastManager.update,
    clear: toastManager.clear,
  };
}

export interface ToastProps {
  toast: ToastItem;
  onDismiss: (id: string) => void;
  className?: string;
}

/**
 * Individual Toast Component.
 */
export function Toast({ toast: item, onDismiss, className = "" }: ToastProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = useCallback(async () => {
    if (!item.txHash) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(item.txHash);
        setCopied(true);
      }
    } catch {
      // Clipboard write failed or disallowed
    }
  }, [item.txHash]);

  const typeConfig = {
    info: {
      icon: <Info className="w-5 h-5 text-sky-400 shrink-0" aria-hidden="true" />,
      border: "border-sky-500/30",
      accent: "bg-sky-500/10 text-sky-300",
      badge: "border-sky-500/20",
    },
    success: {
      icon: <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" aria-hidden="true" />,
      border: "border-emerald-500/30",
      accent: "bg-emerald-500/10 text-emerald-300",
      badge: "border-emerald-500/20",
    },
    error: {
      icon: <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" aria-hidden="true" />,
      border: "border-rose-500/30",
      accent: "bg-rose-500/10 text-rose-300",
      badge: "border-rose-500/20",
    },
    loading: {
      icon: (
        <Loader2
          className="w-5 h-5 text-amber-400 animate-spin shrink-0"
          aria-hidden="true"
        />
      ),
      border: "border-amber-500/30",
      accent: "bg-amber-500/10 text-amber-300",
      badge: "border-amber-500/20",
    },
  };

  const config = typeConfig[item.type] || typeConfig.info;
  const isAlert = item.type === "error";

  return (
    <div
      role={isAlert ? "alert" : "status"}
      aria-live={isAlert ? "assertive" : "polite"}
      aria-atomic="true"
      data-testid={`toast-${item.type}`}
      data-toast-id={item.id}
      className={`pointer-events-auto relative w-full max-w-sm rounded-xl border bg-card/95 backdrop-blur-md p-4 shadow-xl shadow-black/40 transition-all duration-200 ${config.border} ${className}`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5">{config.icon}</div>

        <div className="flex-1 min-w-0 pr-2">
          <div className="text-sm font-semibold text-foreground tracking-tight">
            {item.title}
          </div>

          {item.message && (
            <div className="mt-1 text-xs text-muted-foreground leading-relaxed break-words">
              {item.message}
            </div>
          )}

          {/* Embedded Stellar Explorer & Copyable Transaction Hash */}
          {item.txHash && (
            <div
              className="mt-2.5 pt-2 border-t border-border/60 flex flex-col gap-1.5"
              data-testid="toast-tx-section"
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                  Tx Hash
                </span>
                <a
                  href={getStellarExpertUrl(item.txHash, item.network)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:text-primary/80 transition-colors underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded"
                  aria-label="View transaction on Stellar Expert (opens in new tab)"
                  title="View transaction on Stellar Expert"
                >
                  <span>Stellar Expert</span>
                  <ExternalLink className="w-3 h-3" aria-hidden="true" />
                </a>
              </div>

              <div className="flex items-center justify-between gap-2 px-2 py-1 rounded-lg bg-input/80 border border-border font-mono text-[11px] text-foreground">
                <span
                  className="truncate select-all"
                  title={item.txHash}
                  data-testid="toast-tx-hash"
                >
                  {formatTxHash(item.txHash)}
                </span>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  aria-label={copied ? "Copied transaction hash" : "Copy transaction hash"}
                  title={copied ? "Copied!" : "Copy transaction hash"}
                  data-testid="toast-copy-btn"
                >
                  {copied ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Optional Action Button */}
          {item.action && (
            <div className="mt-2.5">
              <button
                type="button"
                onClick={() => {
                  item.action?.onClick();
                  onDismiss(item.id);
                }}
                className="text-xs font-medium text-primary hover:text-primary/80 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded px-2 py-1 bg-primary/10 hover:bg-primary/20"
              >
                {item.action.label}
              </button>
            </div>
          )}
        </div>

        {/* Manual Dismiss Button */}
        <button
          type="button"
          onClick={() => onDismiss(item.id)}
          className="text-muted-foreground hover:text-foreground p-1 rounded-lg hover:bg-muted transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label="Close notification"
          title="Close notification"
          data-testid="toast-close-btn"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export interface ToastContainerProps {
  className?: string;
  position?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
}

/**
 * Toast Container rendering live stacked notifications.
 */
export function ToastContainer({
  className = "",
  position = "bottom-right",
}: ToastContainerProps) {
  const { toasts, dismiss } = useToast();

  const positionClasses = {
    "top-right": "top-4 right-4",
    "top-left": "top-4 left-4",
    "bottom-right": "bottom-4 right-4",
    "bottom-left": "bottom-4 left-4",
  };

  if (!toasts || toasts.length === 0) {
    return null;
  }

  return (
    <div
      aria-label="Notifications"
      className={`fixed z-50 pointer-events-none flex flex-col gap-2.5 max-w-sm w-full transition-all duration-300 ${positionClasses[position]} ${className}`}
      data-testid="toast-container"
    >
      {toasts.map((item) => (
        <Toast key={item.id} toast={item} onDismiss={dismiss} />
      ))}
    </div>
  );
}
