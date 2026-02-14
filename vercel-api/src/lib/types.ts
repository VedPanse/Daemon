export type PrimitiveArgType = "number" | "string" | "boolean";

export interface SystemNode {
  name: string;
  node_id: string;
  commands: unknown[];
  telemetry?: Record<string, unknown>;
}

export interface SystemManifest {
  daemon_version: string;
  nodes: SystemNode[];
}

export interface PlanRequest {
  instruction: string;
  system_manifest: SystemManifest;
  telemetry_snapshot: Record<string, unknown>;
}

export interface RunStep {
  type: "RUN";
  target: string;
  token: string;
  args: unknown[];
  duration_ms?: number;
}

export interface StopStep {
  type: "STOP";
}

export type PlanStep = RunStep | StopStep;

export interface PlanResponse {
  plan: PlanStep[];
  explanation: string;
}

export interface NormalizedArgSpec {
  type: PrimitiveArgType;
  min?: number;
  max?: number;
  optional?: boolean;
  enum?: unknown[];
}

export interface NormalizedCommandSpec {
  token: string;
  args: NormalizedArgSpec[];
}

export type CommandCatalog = Map<string, Map<string, NormalizedCommandSpec>>;
