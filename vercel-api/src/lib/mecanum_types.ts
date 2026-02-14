export type MecanumCmd = "F" | "B" | "L" | "R" | "Q" | "E" | "S";

export interface MecanumPlanStep {
  cmd: MecanumCmd;
  duration_ms: number;
}

export interface MecanumPlanRequest {
  instruction: string;
  default_duration_ms?: number;
  max_steps?: number;
}

export interface MecanumPlanResponse {
  explanation: string;
  plan: MecanumPlanStep[];
}

