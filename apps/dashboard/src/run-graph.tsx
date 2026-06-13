import { useEffect, useState } from "react";
import { Background, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import type { FlowManifest } from "@flow/contracts";
import { NODE_COLORS } from "./ui.tsx";
import type { NodeRunState } from "./use-run-stream.ts";

const START = "__start__";
const END = "__end__";
const elk = new ELK();

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  conditional: boolean;
}

function manifestEdges(manifest: FlowManifest): GraphEdge[] {
  const fromNodes = Object.entries(manifest.edges).flatMap(([source, spec]) =>
    (spec.kind === "static" ? [spec.to] : spec.targets).map((target) => ({
      id: `${source}->${target}`,
      source,
      target,
      conditional: spec.kind !== "static",
    })),
  );
  return [{ id: `${START}->${manifest.entry}`, source: START, target: manifest.entry, conditional: false }, ...fromNodes];
}

const isPill = (id: string) => id === START || id === END;

async function layout(manifest: FlowManifest): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const edges = manifestEdges(manifest);
  const nodeIds = [START, ...manifest.nodes.map((n) => n.name), ...(edges.some((e) => e.target === END) ? [END] : [])];
  const graph = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "50",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      "elk.edgeRouting": "SPLINES",
    },
    children: nodeIds.map((id) => ({ id, width: isPill(id) ? 90 : 170, height: 42 })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });
  return {
    nodes: (graph.children ?? []).map((child) => ({
      id: child.id,
      position: { x: child.x ?? 0, y: child.y ?? 0 },
      data: { label: child.id === START ? "start" : child.id === END ? "end" : child.id },
      width: isPill(child.id) ? 90 : 170,
      height: 42,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      animated: e.conditional,
      markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: "#a1a1aa" },
      style: { stroke: "#a1a1aa", ...(e.conditional && { strokeDasharray: "6 4" }) },
    })),
  };
}

function nodeStyle(id: string, state: NodeRunState | undefined, onFrontier: boolean) {
  const base = {
    color: "#e4e4e7",
    fontSize: 13,
    fontWeight: 500,
    borderRadius: isPill(id) ? 21 : 10,
    border: "1.5px solid #6d6a8f",
    background: "#2a2839",
  };
  if (id === START) return { ...base, background: "#1f1d2b" };
  if (id === END) return { ...base, background: "#6d28d9", borderColor: "#8b5cf6" };
  if (state) {
    return {
      ...base,
      background: NODE_COLORS[state],
      borderColor: NODE_COLORS[state],
      color: "white",
      ...(state === "running" && { boxShadow: `0 0 16px ${NODE_COLORS.running}` }),
      ...(state === "interrupted" && { boxShadow: `0 0 16px ${NODE_COLORS.interrupted}`, color: "black" }),
      ...(state === "waiting_event" && { boxShadow: `0 0 16px ${NODE_COLORS.waiting_event}` }),
    };
  }
  if (onFrontier) return { ...base, border: "2px dashed #60a5fa" };
  return base;
}

const LEGEND: { label: string; state: NodeRunState }[] = [
  { label: "running", state: "running" },
  { label: "succeeded", state: "succeeded" },
  { label: "failed", state: "failed" },
  { label: "interrupted", state: "interrupted" },
  { label: "waiting event", state: "waiting_event" },
];

export function RunGraph({
  manifest,
  states,
  frontier = [],
}: {
  manifest: FlowManifest;
  states: Map<string, NodeRunState>;
  frontier?: string[];
}) {
  const [graph, setGraph] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });

  useEffect(() => {
    let stale = false;
    void layout(manifest).then((result) => !stale && setGraph(result));
    return () => {
      stale = true;
    };
  }, [manifest]);

  const styled = graph.nodes.map((node) => ({
    ...node,
    style: nodeStyle(node.id, states.get(node.id), frontier.includes(node.id)),
  }));

  return (
    <div className="flex h-full min-h-80 w-full flex-col">
      <ReactFlow
        nodes={styled}
        edges={graph.edges}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background gap={20} />
      </ReactFlow>
      <div className="flex flex-wrap items-center gap-4 border-t border-zinc-800 px-2 pt-2 text-xs text-zinc-400">
        {LEGEND.map(({ label, state }) => (
          <span key={state} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: NODE_COLORS[state] }} />
            {label}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm border-2 border-dashed border-blue-400" />
          next up
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="#a1a1aa" strokeDasharray="5 3" /></svg>
          conditional
        </span>
      </div>
    </div>
  );
}
