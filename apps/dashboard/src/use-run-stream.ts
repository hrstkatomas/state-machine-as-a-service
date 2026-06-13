import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { EngineEvent } from "./api.ts";

export type NodeRunState = "running" | "succeeded" | "failed" | "interrupted" | "waiting_event";

/** Subscribes to the run's SSE stream; replays history, so the returned list is complete. */
export function useRunStream(runId: string): EngineEvent[] {
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const queryClient = useQueryClient();
  const invalidateTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setEvents([]);
    const source = new EventSource(`/v1/runs/${runId}/stream`);
    source.onmessage = (message) => {
      setEvents((prev) => [...prev, JSON.parse(message.data) as EngineEvent]);
      clearTimeout(invalidateTimer.current);
      invalidateTimer.current = setTimeout(
        () => void queryClient.invalidateQueries({ queryKey: ["run", runId] }),
        150,
      );
    };
    return () => {
      source.close();
      clearTimeout(invalidateTimer.current);
    };
  }, [runId, queryClient]);

  return events;
}

/** Latest known state per node, derived from the event log. */
export function nodeStates(events: EngineEvent[]): Map<string, NodeRunState> {
  const states = new Map<string, NodeRunState>();
  for (const event of events) {
    switch (event.type) {
      case "node.started":
        states.set(event.node, "running");
        break;
      case "node.finished":
        states.set(event.node, "succeeded");
        break;
      case "node.failed":
        states.set(event.node, event.willRetry ? "running" : "failed");
        break;
      case "run.interrupted":
        states.set(event.node, "interrupted");
        break;
      case "run.waiting_event":
        states.set(event.node, "waiting_event");
        break;
      case "run.resumed":
        for (const [node, state] of states) {
          if (state === "interrupted" || state === "waiting_event") states.set(node, "running");
        }
        break;
    }
  }
  return states;
}
