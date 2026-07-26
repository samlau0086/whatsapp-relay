"use client";

import { AlertTriangle, ShieldAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type ConfirmationOptions = {
  title?: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "warning" | "danger";
};

type PendingConfirmation = ConfirmationOptions & { resolve: (confirmed: boolean) => void };

let showConfirmation: ((request: PendingConfirmation) => void) | null = null;

export function confirmAction(
  description: string,
  options: Omit<ConfirmationOptions, "description"> = {},
): Promise<boolean> {
  return new Promise(resolve => {
    if (!showConfirmation) {
      resolve(false);
      return;
    }
    showConfirmation({ description, tone: "danger", ...options, resolve });
  });
}

export function ConfirmationHost() {
  const [request, setRequest] = useState<PendingConfirmation | null>(null);
  const queue = useRef<PendingConfirmation[]>([]);
  const activeRequest = useRef<PendingConfirmation | null>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    showConfirmation = next => {
      setRequest(current => {
        if (current) {
          queue.current.push(next);
          return current;
        }
        return next;
      });
    };
    return () => {
      showConfirmation = null;
      if (activeRequest.current) activeRequest.current.resolve(false);
      for (const pending of queue.current) pending.resolve(false);
      queue.current = [];
    };
  }, []);

  useEffect(() => {
    activeRequest.current = request;
    if (!request) return;
    confirmButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [request]);

  function finish(confirmed: boolean) {
    if (!request) return;
    request.resolve(confirmed);
    setRequest(queue.current.shift() ?? null);
  }

  if (!request) return null;
  const danger = request.tone === "danger";
  const Icon = danger ? ShieldAlert : AlertTriangle;

  return (
    <div className="confirmation-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) finish(false);
    }}>
      <section
        className={`confirmation-dialog ${danger ? "danger" : "warning"}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
        aria-describedby="confirmation-description"
      >
        <button className="confirmation-close" onClick={() => finish(false)} aria-label="关闭确认框">
          <X size={17} />
        </button>
        <span className="confirmation-icon"><Icon size={21} /></span>
        <div className="confirmation-copy">
          <h2 id="confirmation-title">{request.title ?? "请确认此操作"}</h2>
          <p id="confirmation-description">{request.description}</p>
        </div>
        <footer>
          <button className="confirmation-cancel" onClick={() => finish(false)}>
            {request.cancelLabel ?? "取消"}
          </button>
          <button ref={confirmButton} className="confirmation-submit" onClick={() => finish(true)}>
            {request.confirmLabel ?? "确认"}
          </button>
        </footer>
      </section>
    </div>
  );
}
