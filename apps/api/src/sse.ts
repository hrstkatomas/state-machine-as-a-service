import type pg from "pg";
import { listen, listEvents, RUN_EVENTS_CHANNEL, type Listener } from "@flow/storage";

type Subscriber = { runId: string; send: (seq: string, data: string) => void };

/** One LISTEN connection fanned out to all SSE clients, filtered per run. */
export class EventHub {
  private readonly subscribers = new Set<Subscriber>();
  private listener?: Listener;

  constructor(
    private readonly pool: pg.Pool,
    private readonly databaseUrl: string,
  ) {}

  async start(): Promise<void> {
    this.listener = await listen(this.databaseUrl, RUN_EVENTS_CHANNEL, (payload) => {
      const { runId } = JSON.parse(payload) as { seq: number; runId: string };
      for (const sub of this.subscribers) {
        if (sub.runId === runId) void this.flush(sub);
      }
    });
  }

  async stop(): Promise<void> {
    await this.listener?.close();
  }

  /** Sends history after `lastSeq`, then live updates until the returned unsubscribe is called. */
  async subscribe(runId: string, lastSeq: string, send: Subscriber["send"]): Promise<() => void> {
    const sub: Subscriber & { cursor: bigint } = { runId, send, cursor: BigInt(lastSeq || 0) };
    this.subscribers.add(sub);
    await this.flush(sub);
    return () => this.subscribers.delete(sub);
  }

  private async flush(sub: Subscriber & { cursor?: bigint }): Promise<void> {
    const cursor = sub.cursor ?? 0n;
    const rows = await listEvents(this.pool, sub.runId, cursor).catch(() => []);
    for (const row of rows) {
      sub.send(row.seq, JSON.stringify(row.data));
      sub.cursor = BigInt(row.seq);
    }
  }
}
