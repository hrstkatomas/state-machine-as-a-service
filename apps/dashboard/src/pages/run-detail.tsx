import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, type Checkpoint, type Interrupt } from "../api.ts";
import { RunGraph } from "../run-graph.tsx";
import { Button, Card, JsonView, StatusBadge } from "../ui.tsx";
import { nodeStates, useRunStream } from "../use-run-stream.ts";

export function RunDetailPage({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const events = useRunStream(runId);
  const { data: detail } = useQuery({ queryKey: ["run", runId], queryFn: () => api.run(runId) });
  const { data: checkpoints = [] } = useQuery({
    queryKey: ["run", runId, "checkpoints"],
    queryFn: () => api.checkpoints(runId),
  });
  const { data: flow } = useQuery({
    queryKey: ["flow", detail?.run.flowId, detail?.run.flowVersion],
    queryFn: () => api.flow(detail!.run.flowId),
    enabled: !!detail,
  });
  const { data: logs = [] } = useQuery({
    queryKey: ["run", runId, "logs"],
    queryFn: () => api.logs(runId),
    refetchInterval: detail?.run.status === "running" ? 2000 : false,
  });
  const cancel = useMutation({
    mutationFn: () => api.cancel(runId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["run", runId] }),
  });
  const replay = useMutation({
    mutationFn: () => api.replay(runId),
    onSuccess: ({ runId: forked }) => void navigate({ to: "/runs/$runId", params: { runId: forked } }),
  });

  if (!detail) return <div className="text-zinc-500">Loading…</div>;
  const { run, pendingInterrupts } = detail;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="font-mono text-lg">{run.id}</h1>
        <StatusBadge status={run.status} />
        <span className="text-sm text-zinc-500">{run.flowId} v{run.flowVersion} · step {run.currentStep}</span>
        <div className="ml-auto flex gap-2">
          <Button onClick={() => replay.mutate()}>Replay</Button>
          {["queued", "running", "interrupted", "waiting_event"].includes(run.status) && (
            <Button onClick={() => cancel.mutate()} className="bg-red-900 hover:bg-red-800">Cancel</Button>
          )}
        </div>
      </div>

      {run.error && (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-300">{run.error}</div>
      )}
      {pendingInterrupts.map((interrupt) => (
        <InterruptBanner key={interrupt.id} interrupt={interrupt} />
      ))}

      <div className="grid grid-cols-5 gap-4">
        <Card title="Graph" className="col-span-3 h-[28rem]">
          {flow ? (
            <RunGraph manifest={flow.graph} states={nodeStates(events)} frontier={detail.checkpoint?.frontier ?? []} />
          ) : (
            <div className="text-zinc-500">Loading flow…</div>
          )}
        </Card>
        <div className="col-span-2">
          <StateInspector checkpoints={checkpoints} />
        </div>
      </div>

      <Card title={`Logs (${logs.length})`}>
        <pre className="max-h-80 overflow-auto text-xs leading-relaxed">
          {logs.map((log) => (
            <div key={log.seq} className={log.stream === "stderr" ? "text-red-400" : "text-zinc-300"}>
              <span className="text-zinc-600">[{log.node}]</span> {log.line}
            </div>
          ))}
          {!logs.length && <span className="text-zinc-500">No logs</span>}
        </pre>
      </Card>
    </div>
  );
}

function InterruptBanner({ interrupt }: { interrupt: Interrupt }) {
  const queryClient = useQueryClient();
  const [response, setResponse] = useState("");
  const respond = useMutation({
    mutationFn: () => api.respond(interrupt.runId, interrupt.id, JSON.parse(response)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["run", interrupt.runId] }),
  });

  return (
    <div className="rounded border border-amber-700 bg-amber-950/40 p-4">
      <div className="mb-2 text-sm font-semibold text-amber-300">
        {interrupt.eventTopic
          ? `Waiting for event "${interrupt.eventTopic}" — node ${interrupt.node}, step ${interrupt.step}`
          : `Interrupt from node ${interrupt.node}, step ${interrupt.step}`}
      </div>
      <JsonView value={interrupt.payload} />
      {!interrupt.eventTopic && (
        <div className="mt-3 flex gap-2">
          <input
            value={response}
            onChange={(e) => setResponse(e.target.value)}
            placeholder='Response JSON, e.g. {"approve": true} or "retry"'
            className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-mono text-sm"
          />
          <Button
            onClick={() => respond.mutate()}
            disabled={respond.isPending}
            className="bg-amber-700 hover:bg-amber-600"
          >
            Respond &amp; resume
          </Button>
        </div>
      )}
      {respond.isError && <div className="mt-2 text-xs text-red-400">{String(respond.error)}</div>}
      {interrupt.responseSchema && (
        <details className="mt-2 text-xs text-zinc-400">
          <summary>Expected response schema</summary>
          <JsonView value={interrupt.responseSchema} />
        </details>
      )}
    </div>
  );
}

function StateInspector({ checkpoints }: { checkpoints: Checkpoint[] }) {
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const selected = checkpoints.find((c) => c.step === selectedStep) ?? checkpoints.at(-1);
  if (!selected) return <Card title="State">No checkpoints yet</Card>;
  const previous = checkpoints.find((c) => c.step === selected.step - 1);
  const changedKeys = new Set(
    Object.keys(selected.state).filter(
      (key) => previous && JSON.stringify(selected.state[key]) !== JSON.stringify(previous.state[key]),
    ),
  );

  return (
    <Card title="State" className="h-[28rem] overflow-auto">
      <div className="mb-3 flex flex-wrap gap-1">
        {checkpoints.map((checkpoint) => (
          <button
            key={checkpoint.step}
            onClick={() => setSelectedStep(checkpoint.step)}
            className={`rounded px-2 py-0.5 text-xs ${
              checkpoint.step === selected.step ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
            }`}
          >
            {checkpoint.step}
          </button>
        ))}
      </div>
      <div className="mb-2 text-xs text-zinc-500">
        step {selected.step} · frontier: {selected.frontier.join(", ") || "(empty — terminal)"}
      </div>
      <div className="space-y-2">
        {Object.entries(selected.state).map(([key, value]) => (
          <div key={key}>
            <div className={`text-xs font-semibold ${changedKeys.has(key) ? "text-amber-400" : "text-zinc-400"}`}>
              {key} {changedKeys.has(key) && "● changed"}
            </div>
            <JsonView value={value} />
          </div>
        ))}
      </div>
    </Card>
  );
}
