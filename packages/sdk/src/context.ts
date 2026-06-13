import type { z } from "zod";
import type { Json, JsonObject, ResumeValue, RunId } from "@flow/contracts";

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface NodeLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface InterruptOpts {
  /** Schema of the expected human response; the dashboard renders a form from it. */
  responseSchema?: z.ZodType;
}

export interface NodeCtx {
  runId: RunId;
  step: number;
  attempt: number;
  signal: AbortSignal;
  logger: NodeLogger;
  /** Pauses the run for a human response. Code before this call re-runs on resume. */
  interrupt: <TResume = Json>(payload: Json, opts?: InterruptOpts) => Promise<TResume>;
  /** Pauses the run until an external event arrives on the topic (use dynamic topics for correlation). */
  waitForEvent: <TPayload = Json>(topic: string) => Promise<TPayload>;
  /** Runs a shell command in the run's workspace. */
  exec: (command: string, opts?: ExecOpts) => Promise<ExecResult>;
}

/** Control signal thrown by ctx.interrupt on first execution — never catch it in node logic. */
export class GraphInterrupt extends Error {
  constructor(
    readonly ordinal: number,
    readonly payload: Json,
    readonly responseSchema?: JsonObject,
    readonly eventTopic?: string,
  ) {
    super(`Interrupt #${ordinal}`);
    this.name = "GraphInterrupt";
  }
}

export interface ContextDeps {
  runId: RunId;
  step: number;
  attempt: number;
  signal: AbortSignal;
  logger: NodeLogger;
  resume: ResumeValue[];
  runShell: (command: string, opts: ExecOpts) => Promise<ExecResult>;
  toResponseSchema: (schema: z.ZodType) => JsonObject;
}

export function createNodeCtx(deps: ContextDeps): NodeCtx {
  let nextOrdinal = 0;
  const consumeResume = (ordinal: number) => deps.resume.find((r) => r.ordinal === ordinal);
  const pause = (payload: Json, responseSchema?: JsonObject, eventTopic?: string) => {
    const ordinal = nextOrdinal++;
    const resumed = consumeResume(ordinal);
    if (resumed) return Promise.resolve(resumed.value);
    throw new GraphInterrupt(ordinal, payload, responseSchema, eventTopic);
  };
  return {
    runId: deps.runId,
    step: deps.step,
    attempt: deps.attempt,
    signal: deps.signal,
    logger: deps.logger,
    interrupt: <TResume>(payload: Json, opts?: InterruptOpts) =>
      pause(payload, opts?.responseSchema && deps.toResponseSchema(opts.responseSchema)) as Promise<TResume>,
    waitForEvent: <TPayload>(topic: string) =>
      pause({ waitingFor: topic }, undefined, topic) as Promise<TPayload>,
    exec: (command, opts = {}) => deps.runShell(command, opts),
  };
}
