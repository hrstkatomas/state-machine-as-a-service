import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, type Flow } from "../api.ts";
import { Button, Card } from "../ui.tsx";

export function FlowsPage() {
  const { data: flows = [] } = useQuery({ queryKey: ["flows"], queryFn: api.flows });
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Flows</h1>
      {flows.map((flow) => <FlowCard key={`${flow.id}@${flow.version}`} flow={flow} />)}
      {!flows.length && <div className="text-zinc-500">No flows deployed. Use `flowctl deploy &lt;entry&gt;`.</div>}
    </div>
  );
}

function FlowCard({ flow }: { flow: Flow }) {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const start = useMutation({
    mutationFn: () => api.startRun(flow.id, input.trim() ? JSON.parse(input) : undefined),
    onSuccess: ({ runId }) => void navigate({ to: "/runs/$runId", params: { runId } }),
  });

  return (
    <Card title={`${flow.id} — v${flow.version}`}>
      <div className="mb-3 text-sm text-zinc-400">
        <div>nodes: {flow.graph.nodes.map((n) => n.name).join(", ")}</div>
        <div>entry: {flow.graph.entry} · image: <span className="font-mono">{flow.imageRef ?? "—"}</span></div>
        <div>
          triggers:{" "}
          {flow.triggers.length
            ? flow.triggers.map((t) => (t.kind === "cron" ? `cron(${t.schedule})` : t.kind === "event" ? `event(${t.topic})` : "manual")).join(", ")
            : "manual only"}
        </div>
      </div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Input JSON (optional), e.g. {"repoUrl": "https://..."}'
          className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-sm"
        />
        <Button onClick={() => start.mutate()} disabled={start.isPending} className="bg-blue-700 hover:bg-blue-600">
          Start run
        </Button>
      </div>
      {start.isError && <div className="mt-2 text-xs text-red-400">{String(start.error)}</div>}
    </Card>
  );
}
