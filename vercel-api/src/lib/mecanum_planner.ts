import { ValidationError } from "@/lib/validate";
import type { MecanumCmd, MecanumPlanRequest, MecanumPlanResponse, MecanumPlanStep } from "@/lib/mecanum_types";

const ALLOWED_CMDS: ReadonlySet<string> = new Set(["F", "B", "L", "R", "Q", "E", "S"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeStep(value: unknown): MecanumPlanStep | null {
  if (!isObject(value)) return null;
  const cmd = typeof value.cmd === "string" ? value.cmd.trim().toUpperCase() : "";
  const duration = typeof value.duration_ms === "number" ? value.duration_ms : Number(value.duration_ms);
  if (!ALLOWED_CMDS.has(cmd)) return null;
  if (!Number.isFinite(duration)) return null;
  return {
    cmd: cmd as MecanumCmd,
    duration_ms: clampInt(duration, 0, 10_000)
  };
}

function ensureStop(plan: MecanumPlanStep[]): MecanumPlanStep[] {
  if (plan.length === 0) return [{ cmd: "S", duration_ms: 0 }];
  const last = plan[plan.length - 1];
  if (last.cmd === "S") return plan;
  return [...plan, { cmd: "S", duration_ms: 0 }];
}

function fallbackHeuristicPlan(instruction: string, defaultDurationMs: number, maxSteps: number): MecanumPlanResponse {
  const text = instruction.toLowerCase();
  const plan: MecanumPlanStep[] = [];

  const push = (cmd: MecanumCmd, duration_ms: number) => {
    if (plan.length >= maxSteps) return;
    plan.push({ cmd, duration_ms: clampInt(duration_ms, 0, 10_000) });
  };

  if (/\bcircle\b/.test(text)) {
    for (let i = 0; i < Math.min(18, maxSteps - 1); i += 1) {
      push("F", Math.max(120, Math.round(defaultDurationMs * 0.35)));
      push("E", 120);
    }
    return { explanation: "Approximate a circle using repeated forward + rotate-right segments, then stop.", plan: ensureStop(plan) };
  }

  if (/\bsquare\b/.test(text)) {
    for (let i = 0; i < 4; i += 1) {
      push("F", Math.max(200, defaultDurationMs));
      push("E", 420);
    }
    return { explanation: "Drive a rough square (forward, rotate right 90), then stop.", plan: ensureStop(plan) };
  }

  if (/\bstop\b/.test(text)) {
    return { explanation: "Stop.", plan: [{ cmd: "S", duration_ms: 0 }] };
  }

  throw new ValidationError("No supported mecanum action found in instruction.");
}

export async function createMecanumPlan(request: MecanumPlanRequest): Promise<MecanumPlanResponse> {
  const instruction = request.instruction?.trim();
  if (!instruction) {
    throw new ValidationError("instruction must be a non-empty string.");
  }

  const defaultDurationMs = clampInt(typeof request.default_duration_ms === "number" ? request.default_duration_ms : 500, 50, 5000);
  const maxSteps = clampInt(typeof request.max_steps === "number" ? request.max_steps : 28, 1, 80);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return fallbackHeuristicPlan(instruction, defaultDurationMs, maxSteps);
  }

  const model = process.env.OPENAI_MECANUM_PLANNER_MODEL ?? "gpt-4o-mini";

  const completionResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You are a motion planner for a mecanum robot controlled by primitive commands.",
            "Available commands (one letter):",
            "F=forward, B=backward, L=strafe left, R=strafe right, Q=rotate left, E=rotate right, S=stop.",
            "You must output ONLY valid JSON.",
            "Output format: {\"explanation\": string, \"plan\": [{\"cmd\": \"F|B|L|R|Q|E|S\", \"duration_ms\": number}, ...]}",
            `Constraints: duration_ms is 0..10000. Keep plan length <= ${maxSteps}. Always end with cmd \"S\".`,
            "For shapes like a circle: approximate using small repeated segments (e.g. forward+rotate) rather than one long move."
          ].join("\n")
        },
        {
          role: "user",
          content: [
            `Instruction: ${instruction}`,
            `Default duration hint (ms): ${defaultDurationMs}`,
            "Return JSON only."
          ].join("\n")
        }
      ]
    })
  });

  if (!completionResponse.ok) {
    return fallbackHeuristicPlan(instruction, defaultDurationMs, maxSteps);
  }

  const payload = (await completionResponse.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const raw = payload.choices?.[0]?.message?.content;
  if (!raw) {
    return fallbackHeuristicPlan(instruction, defaultDurationMs, maxSteps);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallbackHeuristicPlan(instruction, defaultDurationMs, maxSteps);
  }

  if (!isObject(parsed) || !Array.isArray(parsed.plan)) {
    return fallbackHeuristicPlan(instruction, defaultDurationMs, maxSteps);
  }

  const explanation = typeof parsed.explanation === "string" && parsed.explanation.trim() ? parsed.explanation.trim() : "Planned motion.";
  const steps = parsed.plan.map(normalizeStep).filter(Boolean) as MecanumPlanStep[];
  const trimmed = steps.slice(0, maxSteps);
  const plan = ensureStop(trimmed);

  if (plan.length === 0) {
    return fallbackHeuristicPlan(instruction, defaultDurationMs, maxSteps);
  }

  return { explanation, plan };
}

