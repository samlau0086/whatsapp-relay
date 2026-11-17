"use client";

import { AlertCircle, Inbox, LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";

export type AsyncStatus = "ready" | "loading" | "refreshing" | "empty" | "error" | "partial";

export function AsyncState({ status, children, message, onRetry }: {
  status: AsyncStatus;
  children?: ReactNode;
  message?: string;
  onRetry?: () => void;
}) {
  const failed = status === "error" || status === "partial";
  const pending = status === "loading" || status === "refreshing";
  const keepContent = status === "ready" || status === "refreshing" || status === "partial";
  const Icon = pending ? LoaderCircle : failed ? AlertCircle : Inbox;
  const text = message ?? ({ loading: "正在加载", refreshing: "正在更新", empty: "暂无记录",
    error: "加载失败，请重试", partial: "部分内容更新失败，已保留现有记录", ready: "" })[status];
  return <div className="rd-async" aria-busy={pending || undefined}>
    {status !== "ready" && <div className={`rd-async-notice${keepContent ? " rd-async-notice--inline" : ""}`}
      role={failed ? "alert" : "status"}>
      <Icon size={18} aria-hidden="true" className={pending ? "rd-spin" : undefined} />
      <span>{text}</span>
      {failed && onRetry && <Button size="compact" icon={RefreshCw} onClick={onRetry}>重试</Button>}
    </div>}
    {keepContent && children}
  </div>;
}
