declare const brand: unique symbol;
type Branded<T, B extends string> = T & { readonly [brand]: B };

export type RunId = Branded<string, "RunId">;
export type TaskId = Branded<string, "TaskId">;
export type InterruptId = Branded<string, "InterruptId">;
export type FlowId = Branded<string, "FlowId">;

export const runId = (value: string): RunId => value as RunId;
export const taskId = (value: string): TaskId => value as TaskId;
export const interruptId = (value: string): InterruptId => value as InterruptId;
export const flowId = (value: string): FlowId => value as FlowId;
