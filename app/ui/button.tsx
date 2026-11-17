"use client";

import { LoaderCircle, type LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "normal" | "compact";
  loading?: boolean;
  icon?: LucideIcon;
};

export function Button({ variant = "secondary", size = "normal", loading = false, icon: Icon,
  disabled, className = "", children, type = "button", ...props }: ButtonProps) {
  return <button {...props} type={type} disabled={disabled || loading} aria-busy={loading || undefined}
    className={`rd-button rd-button--${variant} rd-button--${size} ${className}`}>
    {Icon && <Icon size={16} aria-hidden="true" className={loading ? "rd-button-icon-hidden" : undefined} />}
    <span className={loading ? "rd-button-content-hidden" : undefined}>{children}</span>
    {loading && <LoaderCircle size={16} aria-hidden="true" className="rd-button-spinner rd-spin" />}
  </button>;
}

export function IconButton({ label, icon, ...props }: Omit<ButtonProps, "children" | "icon" | "aria-label" | "title"> & {
  label: string;
  icon: LucideIcon;
}) {
  return <Button {...props} icon={icon} aria-label={label} title={label}
    className={`rd-icon-button ${props.className ?? ""}`} />;
}
