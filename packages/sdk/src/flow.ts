import { END, type EndNode, type FlowManifest, type RetryPolicy, type TriggerDef } from "@flow/contracts";
import { channelSpec, type ChannelMap, type StateOf } from "./channels.js";
import type { NodeCtx } from "./context.js";

export type NodeHandler<S> = (state: Readonly<S>, ctx: NodeCtx) => Promise<Partial<S>>;

export type Edge<S, N extends string> =
  | { kind: "static"; to: N | EndNode }
  | { kind: "conditional"; targets: readonly (N | EndNode)[]; route: (state: Readonly<S>) => N | EndNode }
  | { kind: "fanOut"; targets: readonly N[]; route: (state: Readonly<S>) => readonly N[] };

export interface NodeOpts {
  retry?: Partial<RetryPolicy>;
}

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1000 };

export interface FlowDefinition<S = Record<string, unknown>> {
  id: string;
  channels: ChannelMap;
  nodes: Map<string, { handler: NodeHandler<S>; retry: RetryPolicy }>;
  edges: Map<string, Edge<S, string>>;
  entry: string;
  triggers: TriggerDef[];
  toManifest: () => FlowManifest;
}

export class FlowBuilder<S, N extends string = never> {
  private readonly nodes = new Map<string, { handler: NodeHandler<S>; retry: RetryPolicy }>();
  private readonly edges = new Map<string, Edge<S, string>>();
  private readonly triggers: TriggerDef[] = [];
  private entry?: string;

  constructor(
    private readonly id: string,
    private readonly channels: ChannelMap,
  ) {}

  addNode<Name extends string>(name: Name, handler: NodeHandler<S>, opts?: NodeOpts): FlowBuilder<S, N | Name> {
    if (this.nodes.has(name)) throw new Error(`Duplicate node "${name}" in flow "${this.id}"`);
    this.nodes.set(name, { handler, retry: { ...DEFAULT_RETRY, ...opts?.retry } });
    return this as FlowBuilder<S, N | Name>;
  }

  addEdge(from: N, edge: Edge<S, N>): this {
    this.edges.set(from, edge as Edge<S, string>);
    return this;
  }

  setEntry(node: N): this {
    this.entry = node;
    return this;
  }

  addTrigger(trigger: TriggerDef): this {
    this.triggers.push(trigger);
    return this;
  }

  build(): FlowDefinition<S> {
    const { id, channels, nodes, edges, triggers, entry } = this;
    if (!entry) throw new Error(`Flow "${id}" has no entry node`);
    for (const [from, edge] of edges) {
      if (!nodes.has(from)) throw new Error(`Edge from unknown node "${from}" in flow "${id}"`);
      const targets = edge.kind === "static" ? [edge.to] : edge.targets;
      for (const target of targets) {
        if (target !== END && !nodes.has(target)) {
          throw new Error(`Edge "${from}" points to unknown node "${target}" in flow "${id}"`);
        }
      }
    }
    for (const name of nodes.keys()) {
      if (!edges.has(name)) throw new Error(`Node "${name}" has no outgoing edge in flow "${id}" (use END)`);
    }
    return {
      id,
      channels,
      nodes,
      edges,
      entry,
      triggers: triggers.length ? triggers : [{ kind: "manual" }],
      toManifest: () => ({
        id,
        entry,
        nodes: [...nodes.entries()].map(([name, n]) => ({ name, retry: n.retry })),
        edges: Object.fromEntries(
          [...edges.entries()].map(([from, edge]) => [
            from,
            edge.kind === "static"
              ? ({ kind: "static", to: edge.to } as const)
              : ({ kind: edge.kind, targets: edge.targets } as const),
          ]),
        ),
        channels: Object.fromEntries(
          Object.entries(channels).map(([key, c]) => [key, channelSpec(c)]),
        ),
        triggers: triggers.length ? triggers : [{ kind: "manual" }],
      }),
    };
  }
}

export const defineFlow = <C extends ChannelMap>(id: string, channels: C): FlowBuilder<StateOf<C>> =>
  new FlowBuilder<StateOf<C>>(id, channels);

export { END };
