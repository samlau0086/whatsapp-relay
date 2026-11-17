"use client";

import { useId, type ReactNode } from "react";

type FieldControlProps = {
  id: string;
  required: boolean;
  "aria-invalid": true | undefined;
  "aria-describedby": string | undefined;
};

export function FormField({ label, hint, error, required = false, children }: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (props: FieldControlProps) => ReactNode;
}) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  return <div className="rd-field" data-invalid={Boolean(error)}>
    <label htmlFor={id}>{label}{required && <span aria-hidden="true"> *</span>}</label>
    {children({ id, required, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy })}
    {hint && <p id={`${id}-hint`} className="rd-field-hint">{hint}</p>}
    {error && <p id={`${id}-error`} className="rd-field-error" role="alert">{error}</p>}
  </div>;
}
