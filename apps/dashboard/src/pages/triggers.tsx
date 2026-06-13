import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.ts";
import { Button } from "../ui.tsx";

export function TriggersPage() {
  const queryClient = useQueryClient();
  const { data: triggers = [] } = useQuery({ queryKey: ["triggers"], queryFn: api.triggers, refetchInterval: 5000 });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setTriggerEnabled(id, enabled),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["triggers"] }),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Triggers</h1>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left text-zinc-500">
            <th className="py-2 pr-4">Flow</th>
            <th className="py-2 pr-4">Kind</th>
            <th className="py-2 pr-4">Schedule / Topic</th>
            <th className="py-2 pr-4">Next fire</th>
            <th className="py-2 pr-4">Enabled</th>
            <th className="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {triggers.map((trigger) => (
            <tr key={trigger.id} className="border-b border-zinc-900">
              <td className="py-2 pr-4">{trigger.flowId} <span className="text-zinc-500">v{trigger.flowVersion}</span></td>
              <td className="py-2 pr-4">{trigger.kind}</td>
              <td className="py-2 pr-4 font-mono">{trigger.schedule ?? trigger.topic}</td>
              <td className="py-2 pr-4 text-zinc-400">
                {trigger.nextFireAt ? new Date(trigger.nextFireAt).toLocaleString() : "—"}
              </td>
              <td className="py-2 pr-4">{trigger.enabled ? "✓" : "✗"}</td>
              <td className="py-2">
                <Button onClick={() => toggle.mutate({ id: trigger.id, enabled: !trigger.enabled })}>
                  {trigger.enabled ? "Disable" : "Enable"}
                </Button>
              </td>
            </tr>
          ))}
          {!triggers.length && (
            <tr><td colSpan={6} className="py-8 text-center text-zinc-500">No triggers configured</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
