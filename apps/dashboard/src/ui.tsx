import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { RunStatus } from "./api.ts";
import type { NodeRunState } from "./use-run-stream.ts";

export const STATUS_COLORS: Record<RunStatus, string> = {
  queued: "bg-zinc-700 text-zinc-200",
  running: "bg-blue-600 text-white",
  interrupted: "bg-amber-500 text-black",
  waiting_event: "bg-purple-500 text-white",
  completed: "bg-emerald-600 text-white",
  failed: "bg-red-600 text-white",
  cancelled: "bg-zinc-500 text-white",
};

export const NODE_COLORS: Record<NodeRunState, string> = {
  running: "#2563eb",
  succeeded: "#059669",
  failed: "#dc2626",
  interrupted: "#f59e0b",
  waiting_event: "#a855f7",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[status]}`}>
      {status}
    </span>
  );
}

export function Button({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}

export function Card({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col rounded-lg border border-zinc-800 bg-zinc-900 ${className}`}>
      {title && <div className="border-b border-zinc-800 px-4 py-2 text-sm font-semibold text-zinc-400">{title}</div>}
      <div className="min-h-0 flex-1 p-4">{children}</div>
    </div>
  );
}

export function JsonView({ value }: { value: unknown }) {
  return (
    <pre className="overflow-auto rounded bg-zinc-950 p-2 text-xs leading-relaxed text-zinc-300">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
