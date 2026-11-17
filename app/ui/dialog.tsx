"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { IconButton } from "./button";

export type CloseReason = "escape" | "backdrop" | "close-button";
export type DialogProps = {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  busy?: boolean;
  dismissOnBackdrop?: boolean;
  role?: "dialog" | "alertdialog";
  initialFocus?: RefObject<HTMLElement | null>;
  onRequestClose: (reason: CloseReason) => void;
};

function Overlay({ open, title, description, children, footer, busy = false,
  dismissOnBackdrop = false, role = "dialog", initialFocus, onRequestClose, drawer = false,
}: DialogProps & { drawer?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pointerStartedOutside = useRef(false);
  const id = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    const previouslyFocused = document.activeElement;
    element.showModal();
    initialFocus?.current?.focus();
    return () => {
      element.close();
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus();
    };
  }, [open, initialFocus]);

  if (!open) return null;
  const outside = (x: number, y: number) => {
    const rect = dialog.current!.getBoundingClientRect();
    return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
  };

  return <dialog ref={dialog} role={role} aria-modal="true" aria-labelledby={`${id}-title`}
    aria-describedby={description ? `${id}-description` : undefined} aria-busy={busy || undefined}
    className={`rd-overlay${drawer ? " rd-overlay--drawer" : ""}`} tabIndex={-1}
    onCancel={event => {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onRequestClose("escape");
    }}
    onPointerDown={event => {
      pointerStartedOutside.current = event.target === event.currentTarget && outside(event.clientX, event.clientY);
    }}
    onClick={event => {
      if (event.target === event.currentTarget && pointerStartedOutside.current && outside(event.clientX, event.clientY)
        && dismissOnBackdrop && !busy) onRequestClose("backdrop");
      pointerStartedOutside.current = false;
    }}
    onKeyDown={event => {
      if (event.key !== "Tab" || (event.target as Element).closest("dialog") !== event.currentTarget) return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
        'button,input,textarea,select,a[href],[tabindex]',
      )).filter(element => element.tabIndex >= 0 && !element.matches(":disabled,[inert],[hidden]")
        && element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); event.currentTarget.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
        event.preventDefault(); first.focus();
      }
    }}>
    <header className="rd-overlay-header">
      <div><h2 id={`${id}-title`}>{title}</h2>
        {description && <p id={`${id}-description`}>{description}</p>}</div>
      <IconButton icon={X} label="关闭" variant="ghost" disabled={busy} onClick={() => onRequestClose("close-button")} />
    </header>
    <div className="rd-overlay-body"><fieldset className="rd-overlay-fields" disabled={busy}>{children}</fieldset></div>
    {footer && <footer className="rd-overlay-footer">{footer}</footer>}
  </dialog>;
}

export function Dialog(props: DialogProps) { return <Overlay {...props} />; }
export function Drawer(props: DialogProps) { return <Overlay {...props} drawer />; }
