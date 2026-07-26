"use client";

import { AlertTriangle, Pencil, ShieldAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type ConfirmationOptions = {
  title?: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "warning" | "danger";
};

type PendingConfirmation = ConfirmationOptions & { resolve: (confirmed: boolean) => void };

export type PromptOptions = {
  title: string;
  label: string;
  defaultValue?: string;
  description?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  multiline?: boolean;
  maxLength?: number;
  required?: boolean;
};

type PendingPrompt = PromptOptions & { resolve: (value: string | null) => void };

let showConfirmation: ((request: PendingConfirmation) => void) | null = null;
let showPrompt: ((request: PendingPrompt) => void) | null = null;

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

export function promptAction(options: PromptOptions): Promise<string | null> {
  return new Promise(resolve => {
    if (!showPrompt) {
      resolve(null);
      return;
    }
    showPrompt({ required: true, ...options, resolve });
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

export function PromptHost() {
  const [dialog, setDialog] = useState<{request: PendingPrompt; value: string; error: string} | null>(null);
  const queue = useRef<PendingPrompt[]>([]);
  const activeRequest = useRef<PendingPrompt | null>(null);
  const input = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    showPrompt = next => {
      setDialog(current => {
        if (current) {
          queue.current.push(next);
          return current;
        }
        return {request: next, value: next.defaultValue ?? "", error: ""};
      });
    };
    return () => {
      showPrompt = null;
      if (activeRequest.current) activeRequest.current.resolve(null);
      for (const pending of queue.current) pending.resolve(null);
      queue.current = [];
    };
  }, []);

  useEffect(() => {
    activeRequest.current = dialog?.request ?? null;
    if (!dialog) return;
    input.current?.focus();
    input.current?.select();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialog?.request]);

  function finish(value: string | null) {
    if (!dialog) return;
    if (value !== null && dialog.request.required !== false && !value.trim()) {
      setDialog(current => current ? {...current, error: "请输入内容后再继续"} : current);
      input.current?.focus();
      return;
    }
    dialog.request.resolve(value);
    const next = queue.current.shift();
    setDialog(next ? {request: next, value: next.defaultValue ?? "", error: ""} : null);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.key === "Enter" && (!dialog?.request.multiline || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      finish(dialog?.value.trim() ?? "");
    }
  }

  if (!dialog) return null;
  const {request, value, error} = dialog;
  const updateValue = (next: string) =>
    setDialog(current => current ? {...current, value: next, error: ""} : current);

  return (
    <div className="confirmation-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) finish(null);
    }}>
      <section
        className="confirmation-dialog prompt-dialog warning"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-title"
      >
        <button className="confirmation-close" onClick={() => finish(null)} aria-label="关闭输入框">
          <X size={17} />
        </button>
        <span className="confirmation-icon"><Pencil size={20} /></span>
        <div className="confirmation-copy">
          <h2 id="prompt-title">{request.title}</h2>
          {request.description && <p>{request.description}</p>}
        </div>
        <label className="prompt-field">
          <span>{request.label}</span>
          {request.multiline
            ? <textarea ref={input as React.Ref<HTMLTextAreaElement>} value={value} placeholder={request.placeholder} maxLength={request.maxLength} rows={5} onChange={event => updateValue(event.target.value)} onKeyDown={handleKeyDown}/>
            : <input ref={input as React.Ref<HTMLInputElement>} value={value} placeholder={request.placeholder} maxLength={request.maxLength} onChange={event => updateValue(event.target.value)} onKeyDown={handleKeyDown}/>}
          <small className={error ? "prompt-error" : ""}>{error || (request.multiline ? "Ctrl / Cmd + Enter 保存" : "按 Enter 保存")}</small>
        </label>
        <footer>
          <button className="confirmation-cancel" onClick={() => finish(null)}>
            {request.cancelLabel ?? "取消"}
          </button>
          <button className="confirmation-submit" onClick={() => finish(value.trim())}>
            {request.confirmLabel ?? "保存"}
          </button>
        </footer>
      </section>
    </div>
  );
}
