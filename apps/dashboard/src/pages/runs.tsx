import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api, type RunStatus } from "../api.ts";
import { StatusBadge } from "../ui.tsx";

const STATUSES: RunStatus[] = ["queued", "running", "interrupted", "waiting_event", "completed", "failed", "cancelled"];

export function RunsPage() {
  const [status, setStatus] = useState<RunStatus | "">("");
  const { data: runs = [] } = useQuery({
    queryKey: ["runs", status],
    queryFn: () => api.runs(status ? { status } : {}),
    refetchInterval: 3000,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Runs</h1>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as RunStatus | "")}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
        >
          <option value="">all statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left text-zinc-500">
            <th className="py-2 pr-4">Run</th>
            <th className="py-2 pr-4">Flow</th>
            <th className="py-2 pr-4">Status</th>
            <th className="py-2 pr-4">Step</th>
            <th className="py-2 pr-4">Started</th>
            <th className="py-2">Finished</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} className="border-b border-zinc-900 hover:bg-zinc-900">
              <td className="py-2 pr-4">
                <Link to="/runs/$runId" params={{ runId: run.id }} className="font-mono text-blue-400 hover:underline">
                  {run.id.slice(0, 8)}
                </Link>
              </td>
              <td className="py-2 pr-4">{run.flowId} <span className="text-zinc-500">v{run.flowVersion}</span></td>
              <td className="py-2 pr-4"><StatusBadge status={run.status} /></td>
              <td className="py-2 pr-4">{run.currentStep}</td>
              <td className="py-2 pr-4 text-zinc-400">{new Date(run.createdAt).toLocaleString()}</td>
              <td className="py-2 text-zinc-400">{run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "—"}</td>
            </tr>
          ))}
          {!runs.length && (
            <tr><td colSpan={6} className="py-8 text-center text-zinc-500">No runs yet</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
