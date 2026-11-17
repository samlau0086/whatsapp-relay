"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, type ButtonProps } from "./button";

export function Popover({ label, icon, children }: {
  label: string;
  icon?: ButtonProps["icon"];
  children: (close: () => void) => ReactNode;
}) {
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    const element = document.getElementById(id);
    if (element instanceof HTMLElement) element.hidePopover();
    element?.parentElement?.querySelector("button")?.focus();
  }, [id]);

  useEffect(() => {
    if (!open) return;
    const element = panel.current!, anchor = trigger.current!;
    function position() {
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const below = Math.max(0, top + height - rect.bottom - 16);
      const above = Math.max(0, rect.top - top - 16);
      element.style.maxHeight = `${Math.max(below, above)}px`;
      element.style.maxWidth = `${Math.max(0, width - 24)}px`;
      element.style.left = `${Math.max(left + 12, Math.min(rect.left, left + width - element.offsetWidth - 12))}px`;
      element.style.top = `${below >= element.offsetHeight || below >= above ? rect.bottom + 8 : Math.max(top + 8, rect.top - element.offsetHeight - 8)}px`;
    }
    position();
    const observer = new ResizeObserver(position);
    observer.observe(anchor);
    observer.observe(element);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [open]);

  return <span className="rd-popover-anchor" ref={trigger}>
    <Button popoverTarget={id} icon={icon} aria-expanded={open} aria-controls={id}>{label}</Button>
    <div id={id} ref={panel} popover="auto" role="region" aria-label={label}
      className="rd-popover" onToggle={event => setOpen(event.newState === "open")}>
      {children(close)}
    </div>
  </span>;
}
