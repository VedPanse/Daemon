import type { PlanResponse, RunStep, SystemManifest } from "@/lib/types";
import { buildCommandCatalog, getSupportingNodes, validatePlan } from "@/lib/validate";

interface TokenCandidate {
  token: string;
  args: unknown[];
  duration_ms?: number;
}

interface Intent {
  candidates: TokenCandidate[];
  explanation: string;
}

export class PlannerError extends Error {
  readonly code = "PLANNING_ERROR";
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.details = details;
  }
}

function parseInstruction(instruction: string): Intent[] {
  const clauses = instruction
    .toLowerCase()
    .split(/\bthen\b|,/gi)
    .map((part) => part.trim())
    .filter(Boolean);

  const intents: Intent[] = [];

  for (const clause of clauses.length ? clauses : [instruction.toLowerCase().trim()]) {
    if (!clause) {
      continue;
    }

    if (/\bforward\b/.test(clause)) {
      intents.push({
        candidates: [{ token: "FWD", args: [0.6], duration_ms: 1200 }],
        explanation: "move forward"
      });
    }

    if (/\bback(?:ward)?\b/.test(clause)) {
      intents.push({
        candidates: [{ token: "BWD", args: [0.6], duration_ms: 1200 }],
        explanation: "move backward"
      });
    }

    if (/\bturn\s+left\b|\bleft\b/.test(clause)) {
      intents.push({
        candidates: [
          { token: "TURN", args: [-90], duration_ms: 800 },
          { token: "L", args: [200], duration_ms: 800 }
        ],
        explanation: "turn left"
      });
    }

    if (/\bturn\s+right\b|\bright\b/.test(clause)) {
      intents.push({
        candidates: [{ token: "TURN", args: [90], duration_ms: 800 }],
        explanation: "turn right"
      });
    }

    if (/\bclose\s+gripper\b|\bclose\b/.test(clause)) {
      intents.push({
        candidates: [{ token: "GRIP", args: ["close"] }],
        explanation: "close gripper"
      });
    }

    if (/\bopen\s+gripper\b|\bopen\b/.test(clause)) {
      intents.push({
        candidates: [{ token: "GRIP", args: ["open"] }],
        explanation: "open gripper"
      });
    }

    if (/\bhome\b/.test(clause)) {
      intents.push({
        candidates: [{ token: "HOME", args: [] }],
        explanation: "go home"
      });
    }
  }

  return intents;
}

function resolveIntent(intent: Intent, catalog: ReturnType<typeof buildCommandCatalog>): RunStep {
  for (const candidate of intent.candidates) {
    const supporters = getSupportingNodes(catalog, candidate.token);

    if (supporters.length === 0) {
      continue;
    }

    if (supporters.length !== 1) {
      throw new PlannerError("Token target is ambiguous across multiple nodes.", {
        token: candidate.token,
        candidate_targets: supporters
      });
    }

    const target = supporters[0];

    return {
      type: "RUN",
      target,
      token: candidate.token,
      args: candidate.args,
      ...(candidate.duration_ms ? { duration_ms: candidate.duration_ms } : {})
    };
  }

  throw new PlannerError("No supported token found in system_manifest for requested action.", {
    intent: intent.explanation,
    candidates: intent.candidates.map((candidate) => candidate.token)
  });
}

function buildExplanation(intents: Intent[]): string {
  const labels = intents.map((intent) => intent.explanation);

  if (labels.length === 0) {
    return "Stop.";
  }

  const first = labels[0].charAt(0).toUpperCase() + labels[0].slice(1);
  const rest = labels.slice(1);
  const sentence = [first, ...rest].join(", then ");
  return `${sentence}, then stop.`;
}

export function createPlan(instruction: string, manifest: SystemManifest): PlanResponse {
  if (!instruction.trim()) {
    throw new PlannerError("instruction must be a non-empty string.");
  }

  const intents = parseInstruction(instruction);
  if (intents.length === 0) {
    throw new PlannerError("No supported actions found in instruction.", { instruction });
  }

  const catalog = buildCommandCatalog(manifest);
  const runSteps = intents.map((intent) => resolveIntent(intent, catalog));
  const plan = [...runSteps, { type: "STOP" as const }];
  const explanation = buildExplanation(intents);

  validatePlan(plan, manifest);

  return { plan, explanation };
}
