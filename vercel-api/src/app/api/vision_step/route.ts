import { NextResponse } from "next/server";
import jpeg from "jpeg-js";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalLabel,
  parseInstruction as parseInstructionPolicy,
  selectTargetWithTraceDeterministic,
  shouldBypassPerceptionTask,
  type TargetSelectionResult,
  updateTargetLockCtx
} from "@/lib/visionPolicy";
import { computeOpenAIFramePeriod, recommendIntervalMs } from "@/lib/visionPerf";

export const runtime = "nodejs";

const ALLOWED_ORIGINS = new Set([
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "tauri://localhost"
]);

function corsHeaders(origin: string | null): HeadersInit {
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

type Stage = "SEARCH" | "ALIGN" | "APPROACH" | "GRAB" | "DONE" | "MOTION_ONLY";
type TaskType = "stop" | "move-pattern" | "arm-control" | "pick-object" | "follow" | "search" | "avoid+approach" | "unknown";

type MotionPattern = "circle" | "square" | "triangle";
type CanonicalMoveDirection = "forward" | "backward" | "left" | "right";
type CanonicalTurnDirection = "left" | "right";
type CanonicalAction =
  | { type: "MOVE"; direction: CanonicalMoveDirection; distance_m?: number; speed?: number }
  | { type: "TURN"; direction: CanonicalTurnDirection; angle_deg?: number; speed?: number }
  | { type: "STOP" };

interface TargetSpec {
  query: string | null;
  label: string | null;
  color: string | null;
}

interface ParsedInstruction {
  task_type: TaskType;
  stop_kind?: "normal" | "emergency";
  target: TargetSpec;
  pattern?: MotionPattern;
  canonical_actions?: CanonicalAction[];
  arm_actions?: Array<{ state: "open" | "hold"; duration_s?: number }>;
  count?: number;
  distance_m?: number;
}

interface PerceivedObject {
  label: string;
  bbox: { x: number; y: number; w: number; h: number };
  confidence: number;
  attributes?: string[];
}

interface Perception {
  objects: PerceivedObject[];
  selected_target?: PerceivedObject;
  summary: string;
  found: boolean;
  bbox: { x: number; y: number; w: number; h: number } | null;
  area: number;
  offset_x: number;
  center_offset_x: number;
  confidence: number;
}

type PlanStep =
  | { type: "STOP" }
  | {
      type: "RUN";
      target: string;
      token: string;
      args: unknown[];
      duration_ms?: number;
    };

interface Capabilities {
  base_target: string;
  arm_target: string;
  base_turn_token: string;
  base_fwd_token: string;
  base_strafe_token: string;
  arm_grip_token: string;
}

interface VisionState {
  stage: Stage;
  scan_dir: number;
  scan_ticks: number;
  capabilities: Capabilities;
  instruction_ctx: {
    hash: string;
  };
  motion_ctx: {
    consumed: boolean;
    step_idx: number;
    total_steps: number;
  };
  target_lock_ctx: {
    label: string;
    bbox: { x: number; y: number; w: number; h: number };
    lost_ticks: number;
  } | null;
  verification_ctx: {
    status: "on_track" | "uncertain" | "off_track";
    confidence: number;
    on_track_streak: number;
    off_track_streak: number;
    last_motion_score: number;
    last_offset_abs: number;
    last_area: number;
    last_signature: number[] | null;
  };
  learning_ctx: {
    confidence_floor: number;
    align_tolerance: number;
    frames: number;
    on_track_frames: number;
    false_switches: number;
    recovery_count: number;
    avg_latency_ms: number;
    last_selected_label: string | null;
  };
  task_eval_ctx: {
    episode_index: number;
    finalized: boolean;
    last_outcome: "pending" | "success" | "failure";
    success_streak: number;
    failure_streak: number;
    target_label: string | null;
    target_color: string | null;
    label_mismatch_count: number;
    color_mismatch_count: number;
  };
  perf_ctx: {
    frame_index: number;
    last_latency_ms: number;
    recommended_interval_ms: number;
    last_openai_frame: number;
    cached_perception: Perception | null;
    cached_source: "openai_vision" | "fallback_color" | "none";
  };
}

interface SystemManifestInput {
  nodes?: Array<{
    name?: unknown;
    commands?: Array<{
      token?: unknown;
    }>;
  }>;
}

interface OpenAIPerception {
  objects: PerceivedObject[];
  summary: string;
  error?: string;
}

interface PerceptionSchedule {
  allow_fast_track: boolean;
  run_full_model: boolean;
  reason: string;
  openai_period_frames: number;
  strong_lock: boolean;
}

interface TaskValidation {
  outcome: "pending" | "success" | "failure";
  reason: string;
  checks: {
    motion_ok: boolean;
    target_label_ok: boolean;
    target_color_ok: boolean;
    grasp_intent_ok: boolean;
    selected_label: string | null;
    selected_color: string | null;
  };
}

interface PersistentTaskMetrics {
  total_success: number;
  total_failure: number;
  by_target: Record<
    string,
    {
      success: number;
      failure: number;
      label_mismatch: number;
      color_mismatch: number;
    }
  >;
}

const DEFAULT_STATE: VisionState = {
  stage: "SEARCH",
  scan_dir: 1,
  scan_ticks: 0,
  capabilities: {
    base_target: "base",
    arm_target: "arm",
    base_turn_token: "TURN",
    base_fwd_token: "FWD",
    base_strafe_token: "STRAFE",
    arm_grip_token: "GRIP"
  },
  instruction_ctx: {
    hash: ""
  },
  motion_ctx: {
    consumed: false,
    step_idx: 0,
    total_steps: 0
  },
  target_lock_ctx: null,
  verification_ctx: {
    status: "uncertain",
    confidence: 0,
    on_track_streak: 0,
    off_track_streak: 0,
    last_motion_score: 0,
    last_offset_abs: 0,
    last_area: 0,
    last_signature: null
  },
  learning_ctx: {
    confidence_floor: 0.35,
    align_tolerance: 0.07,
    frames: 0,
    on_track_frames: 0,
    false_switches: 0,
    recovery_count: 0,
    avg_latency_ms: 0,
    last_selected_label: null
  },
  task_eval_ctx: {
    episode_index: 0,
    finalized: false,
    last_outcome: "pending",
    success_streak: 0,
    failure_streak: 0,
    target_label: null,
    target_color: null,
    label_mismatch_count: 0,
    color_mismatch_count: 0
  },
  perf_ctx: {
    frame_index: 0,
    last_latency_ms: 0,
    recommended_interval_ms: 180,
    last_openai_frame: -1000,
    cached_perception: null,
    cached_source: "none"
  }
};

const ALIGN_OFFSET_THRESHOLD = 0.07;
const SEARCH_STEP_DEG = 12;
const CLOSE_AREA_THRESHOLD = 0.09;
const OPENAI_MIN_CONFIDENCE = 0.35;
const TASK_METRICS_FILE = path.join(process.cwd(), ".daemon", "vision_task_metrics.json");
let FILE_ENV_CACHE: Record<string, string> | null = null;

function logVisionTrace(event: string, correlationId: string, payload: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      event,
      correlation_id: correlationId,
      ...payload
    })
  );
}

function generateCorrelationId(): string {
  return `vision-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringOr(defaultValue: string, value: unknown): string {
  if (typeof value !== "string") {
    return defaultValue;
  }
  const normalized = value.trim();
  return normalized || defaultValue;
}

function toNumberOr(defaultValue: number, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseDotEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function loadFileEnv(): Record<string, string> {
  if (FILE_ENV_CACHE) {
    return FILE_ENV_CACHE;
  }

  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, ".env.local"),
    path.join(cwd, ".env"),
    path.join(cwd, "..", ".env.local"),
    path.join(cwd, "..", ".env")
  ];

  const merged: Record<string, string> = {};
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = parseDotEnv(fs.readFileSync(file, "utf8"));
      Object.assign(merged, parsed);
    } catch {
      // Ignore unreadable dotenv files and continue with remaining candidates.
    }
  }

  FILE_ENV_CACHE = merged;
  return merged;
}

function envValue(...keys: string[]): string | undefined {
  for (const key of keys) {
    const runtime = process.env[key];
    if (typeof runtime === "string" && runtime.trim()) {
      return runtime.trim();
    }
  }

  const fileEnv = loadFileEnv();
  for (const key of keys) {
    const value = fileEnv[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function targetMetricsKey(parsed: ParsedInstruction): string {
  const label = parsed.target.label ? canonicalLabel(parsed.target.label) : "any";
  const color = parsed.target.color || "any";
  return `${parsed.task_type}|${label}|${color}`;
}

function readPersistentTaskMetrics(): PersistentTaskMetrics {
  try {
    if (!fs.existsSync(TASK_METRICS_FILE)) {
      return { total_success: 0, total_failure: 0, by_target: {} };
    }
    const raw = JSON.parse(fs.readFileSync(TASK_METRICS_FILE, "utf8"));
    if (!raw || typeof raw !== "object") {
      return { total_success: 0, total_failure: 0, by_target: {} };
    }
    return {
      total_success: typeof raw.total_success === "number" ? Math.max(0, Math.floor(raw.total_success)) : 0,
      total_failure: typeof raw.total_failure === "number" ? Math.max(0, Math.floor(raw.total_failure)) : 0,
      by_target: isObject(raw.by_target) ? (raw.by_target as PersistentTaskMetrics["by_target"]) : {}
    };
  } catch {
    return { total_success: 0, total_failure: 0, by_target: {} };
  }
}

function writePersistentTaskMetrics(metrics: PersistentTaskMetrics): void {
  fs.mkdirSync(path.dirname(TASK_METRICS_FILE), { recursive: true });
  fs.writeFileSync(TASK_METRICS_FILE, JSON.stringify(metrics, null, 2), "utf8");
}

function persistTaskOutcome(parsed: ParsedInstruction, validation: TaskValidation): PersistentTaskMetrics {
  const metrics = readPersistentTaskMetrics();
  const key = targetMetricsKey(parsed);
  const existing = metrics.by_target[key] || {
    success: 0,
    failure: 0,
    label_mismatch: 0,
    color_mismatch: 0
  };

  if (validation.outcome === "success") {
    metrics.total_success += 1;
    existing.success += 1;
  } else if (validation.outcome === "failure") {
    metrics.total_failure += 1;
    existing.failure += 1;
  }

  if (!validation.checks.target_label_ok) {
    existing.label_mismatch += 1;
  }
  if (!validation.checks.target_color_ok) {
    existing.color_mismatch += 1;
  }

  metrics.by_target[key] = existing;
  writePersistentTaskMetrics(metrics);
  return metrics;
}

function extractObjectDescriptor(selected: PerceivedObject | undefined, expectedQualifier: string | null): string | null {
  if (!selected) return null;
  const values = [selected.label, ...(selected.attributes || [])].map((v) => v.toLowerCase());
  if (expectedQualifier) {
    if (values.some((value) => value.includes(expectedQualifier))) {
      return expectedQualifier;
    }
    return null;
  }
  if (values.length > 0) return values[0].split(/\s+/)[0] || null;
  return null;
}

function evaluateTaskValidation(
  parsed: ParsedInstruction,
  state: VisionState,
  nextState: VisionState,
  perception: Perception,
  plan: PlanStep[],
  motionScore: number,
  recoveryTriggered: boolean
): TaskValidation {
  const selected = perception.selected_target;
  const selectedLabel = selected ? canonicalLabel(selected.label) : null;
  const expectedColor = parsed.target.color ? parsed.target.color.toLowerCase() : null;
  const selectedColor = extractObjectDescriptor(selected, expectedColor);
  const expectedLabel = parsed.target.label ? canonicalLabel(parsed.target.label) : null;

  const baseMotionCommanded = plan.some(
    (step) => step.type === "RUN" && step.target === state.capabilities.base_target && (step.token === state.capabilities.base_fwd_token || step.token === state.capabilities.base_turn_token)
  );
  const motionDelta =
    Math.abs(state.verification_ctx.last_offset_abs - Math.abs(perception.offset_x)) + Math.abs(state.verification_ctx.last_area - perception.area);
  const motionOk = !baseMotionCommanded || motionScore >= 0.005 || motionDelta >= 0.003;
  const targetLabelOk = !expectedLabel || (selectedLabel !== null && selectedLabel === expectedLabel);
  const targetColorOk = !expectedColor || selectedColor === expectedColor;
  const graspIntentOk =
    nextState.stage !== "DONE" ||
    state.stage === "GRAB" ||
    plan.some((step) => step.type === "RUN" && step.target === state.capabilities.arm_target && step.token === state.capabilities.arm_grip_token);

  if (recoveryTriggered) {
    return {
      outcome: "failure",
      reason: "recovery_stop_triggered",
      checks: {
        motion_ok: motionOk,
        target_label_ok: targetLabelOk,
        target_color_ok: targetColorOk,
        grasp_intent_ok: false,
        selected_label: selectedLabel,
        selected_color: selectedColor
      }
    };
  }

  if (parsed.task_type === "pick-object" && nextState.stage === "DONE") {
    const success = motionOk && targetLabelOk && targetColorOk && graspIntentOk;
    return {
      outcome: success ? "success" : "failure",
      reason: success ? "pick_verified" : "pick_verification_failed",
      checks: {
        motion_ok: motionOk,
        target_label_ok: targetLabelOk,
        target_color_ok: targetColorOk,
        grasp_intent_ok: graspIntentOk,
        selected_label: selectedLabel,
        selected_color: selectedColor
      }
    };
  }

  return {
    outcome: "pending",
    reason: "task_in_progress",
    checks: {
      motion_ok: motionOk,
      target_label_ok: targetLabelOk,
      target_color_ok: targetColorOk,
      grasp_intent_ok: graspIntentOk,
      selected_label: selectedLabel,
      selected_color: selectedColor
    }
  };
}

function asCachedPerception(value: unknown): Perception | null {
  if (!isObject(value)) return null;
  if (!Array.isArray(value.objects)) return null;
  if (typeof value.summary !== "string") return null;
  if (typeof value.found !== "boolean") return null;
  if (typeof value.area !== "number") return null;
  if (typeof value.offset_x !== "number") return null;
  if (typeof value.center_offset_x !== "number") return null;
  if (typeof value.confidence !== "number") return null;
  return value as unknown as Perception;
}

function normalizeState(input: unknown): VisionState {
  if (!isObject(input)) {
    return { ...DEFAULT_STATE, capabilities: { ...DEFAULT_STATE.capabilities } };
  }

  const rawStage = toStringOr(DEFAULT_STATE.stage, input.stage).toUpperCase();
  const stage: Stage = ["SEARCH", "ALIGN", "APPROACH", "GRAB", "DONE", "MOTION_ONLY"].includes(rawStage)
    ? (rawStage as Stage)
    : DEFAULT_STATE.stage;

  const capabilitiesInput = isObject(input.capabilities) ? input.capabilities : {};
  const instructionCtxInput = isObject(input.instruction_ctx) ? input.instruction_ctx : {};
  const motionCtxInput = isObject(input.motion_ctx) ? input.motion_ctx : {};
  const lockInput = isObject(input.target_lock_ctx) ? input.target_lock_ctx : null;
  const verificationCtxInput = isObject(input.verification_ctx) ? input.verification_ctx : {};
  const learningCtxInput = isObject(input.learning_ctx) ? input.learning_ctx : {};
  const taskEvalCtxInput = isObject(input.task_eval_ctx) ? input.task_eval_ctx : {};
  const perfCtxInput = isObject(input.perf_ctx) ? input.perf_ctx : {};

  const scanDir = toNumberOr(DEFAULT_STATE.scan_dir, input.scan_dir);
  const scanTicks = toNumberOr(DEFAULT_STATE.scan_ticks, input.scan_ticks);

  return {
    stage,
    scan_dir: scanDir >= 0 ? 1 : -1,
    scan_ticks: Math.max(0, Math.floor(scanTicks)),
    capabilities: {
      base_target: toStringOr(DEFAULT_STATE.capabilities.base_target, capabilitiesInput.base_target),
      arm_target: toStringOr(DEFAULT_STATE.capabilities.arm_target, capabilitiesInput.arm_target),
      base_turn_token: toStringOr(DEFAULT_STATE.capabilities.base_turn_token, capabilitiesInput.base_turn_token),
      base_fwd_token: toStringOr(DEFAULT_STATE.capabilities.base_fwd_token, capabilitiesInput.base_fwd_token),
      base_strafe_token: toStringOr(DEFAULT_STATE.capabilities.base_strafe_token, capabilitiesInput.base_strafe_token),
      arm_grip_token: toStringOr(DEFAULT_STATE.capabilities.arm_grip_token, capabilitiesInput.arm_grip_token)
    },
    instruction_ctx: {
      hash: toStringOr("", instructionCtxInput.hash)
    },
    motion_ctx: {
      consumed: Boolean(motionCtxInput.consumed),
      step_idx: Math.max(0, Math.floor(toNumberOr(0, motionCtxInput.step_idx))),
      total_steps: Math.max(0, Math.floor(toNumberOr(0, motionCtxInput.total_steps)))
    },
    target_lock_ctx:
      lockInput &&
      typeof lockInput.label === "string" &&
      isObject(lockInput.bbox) &&
      typeof lockInput.bbox.x === "number" &&
      typeof lockInput.bbox.y === "number" &&
      typeof lockInput.bbox.w === "number" &&
      typeof lockInput.bbox.h === "number"
        ? {
            label: lockInput.label,
            bbox: {
              x: clamp(lockInput.bbox.x, 0, 1),
              y: clamp(lockInput.bbox.y, 0, 1),
              w: clamp(lockInput.bbox.w, 0, 1),
              h: clamp(lockInput.bbox.h, 0, 1)
            },
            lost_ticks:
              typeof lockInput.lost_ticks === "number" && Number.isFinite(lockInput.lost_ticks)
                ? Math.max(0, Math.floor(lockInput.lost_ticks))
                : 0
          }
        : null
    ,
    verification_ctx: {
      status:
        verificationCtxInput.status === "on_track" ||
        verificationCtxInput.status === "off_track" ||
        verificationCtxInput.status === "uncertain"
          ? verificationCtxInput.status
          : DEFAULT_STATE.verification_ctx.status,
      confidence: clamp(toNumberOr(DEFAULT_STATE.verification_ctx.confidence, verificationCtxInput.confidence), 0, 1),
      on_track_streak: Math.max(0, Math.floor(toNumberOr(0, verificationCtxInput.on_track_streak))),
      off_track_streak: Math.max(0, Math.floor(toNumberOr(0, verificationCtxInput.off_track_streak))),
      last_motion_score: clamp(toNumberOr(0, verificationCtxInput.last_motion_score), 0, 1),
      last_offset_abs: Math.max(0, toNumberOr(0, verificationCtxInput.last_offset_abs)),
      last_area: Math.max(0, toNumberOr(0, verificationCtxInput.last_area)),
      last_signature:
        Array.isArray(verificationCtxInput.last_signature) && verificationCtxInput.last_signature.every((v) => typeof v === "number")
          ? verificationCtxInput.last_signature.slice(0, 8).map((v) => clamp(v, 0, 1))
          : null
    },
    learning_ctx: {
      confidence_floor: clamp(toNumberOr(DEFAULT_STATE.learning_ctx.confidence_floor, learningCtxInput.confidence_floor), 0.2, 0.8),
      align_tolerance: clamp(toNumberOr(DEFAULT_STATE.learning_ctx.align_tolerance, learningCtxInput.align_tolerance), 0.04, 0.14),
      frames: Math.max(0, Math.floor(toNumberOr(0, learningCtxInput.frames))),
      on_track_frames: Math.max(0, Math.floor(toNumberOr(0, learningCtxInput.on_track_frames))),
      false_switches: Math.max(0, Math.floor(toNumberOr(0, learningCtxInput.false_switches))),
      recovery_count: Math.max(0, Math.floor(toNumberOr(0, learningCtxInput.recovery_count))),
      avg_latency_ms: Math.max(0, toNumberOr(0, learningCtxInput.avg_latency_ms)),
      last_selected_label:
        typeof learningCtxInput.last_selected_label === "string" && learningCtxInput.last_selected_label.trim()
          ? learningCtxInput.last_selected_label.trim()
          : null
    },
    task_eval_ctx: {
      episode_index: Math.max(0, Math.floor(toNumberOr(0, taskEvalCtxInput.episode_index))),
      finalized: Boolean(taskEvalCtxInput.finalized),
      last_outcome:
        taskEvalCtxInput.last_outcome === "success" ||
        taskEvalCtxInput.last_outcome === "failure" ||
        taskEvalCtxInput.last_outcome === "pending"
          ? taskEvalCtxInput.last_outcome
          : "pending",
      success_streak: Math.max(0, Math.floor(toNumberOr(0, taskEvalCtxInput.success_streak))),
      failure_streak: Math.max(0, Math.floor(toNumberOr(0, taskEvalCtxInput.failure_streak))),
      target_label:
        typeof taskEvalCtxInput.target_label === "string" && taskEvalCtxInput.target_label.trim()
          ? canonicalLabel(taskEvalCtxInput.target_label.trim())
          : null,
      target_color:
        typeof taskEvalCtxInput.target_color === "string" && taskEvalCtxInput.target_color.trim()
          ? taskEvalCtxInput.target_color.trim().toLowerCase()
          : null,
      label_mismatch_count: Math.max(0, Math.floor(toNumberOr(0, taskEvalCtxInput.label_mismatch_count))),
      color_mismatch_count: Math.max(0, Math.floor(toNumberOr(0, taskEvalCtxInput.color_mismatch_count)))
    },
    perf_ctx: {
      frame_index: Math.max(0, Math.floor(toNumberOr(0, perfCtxInput.frame_index))),
      last_latency_ms: Math.max(0, toNumberOr(0, perfCtxInput.last_latency_ms)),
      recommended_interval_ms: clamp(Math.round(toNumberOr(180, perfCtxInput.recommended_interval_ms)), 80, 600),
      last_openai_frame: Math.floor(toNumberOr(-1000, perfCtxInput.last_openai_frame)),
      cached_perception: asCachedPerception(perfCtxInput.cached_perception),
      cached_source:
        perfCtxInput.cached_source === "openai_vision" ||
        perfCtxInput.cached_source === "fallback_color" ||
        perfCtxInput.cached_source === "none"
          ? perfCtxInput.cached_source
          : "none"
    }
  };
}

function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeInstruction(instruction: string): string {
  return instruction.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseInstruction(instruction: string): ParsedInstruction {
  return parseInstructionPolicy(instruction);
}

function decodeImage(base64Input: string): { data: Uint8Array; width: number; height: number } {
  const trimmed = base64Input.includes(",") ? base64Input.split(",").pop() || "" : base64Input;
  const raw = Buffer.from(trimmed, "base64");
  const decoded = jpeg.decode(raw, { useTArray: true });

  if (!decoded?.data || !decoded.width || !decoded.height) {
    throw new Error("invalid JPEG payload");
  }

  return {
    data: decoded.data,
    width: decoded.width,
    height: decoded.height
  };
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const cMax = Math.max(rf, gf, bf);
  const cMin = Math.min(rf, gf, bf);
  const delta = cMax - cMin;

  let h = 0;
  if (delta !== 0) {
    if (cMax === rf) {
      h = 60 * (((gf - bf) / delta) % 6);
    } else if (cMax === gf) {
      h = 60 * ((bf - rf) / delta + 2);
    } else {
      h = 60 * ((rf - gf) / delta + 4);
    }
  }

  if (h < 0) {
    h += 360;
  }

  const s = cMax === 0 ? 0 : delta / cMax;
  return { h, s, v: cMax };
}

function toSupportedFallbackColor(color: string | null): "red" | "blue" | "green" | "yellow" | null {
  if (!color) return null;
  const normalized = color.toLowerCase().trim();
  if (normalized === "red" || normalized === "blue" || normalized === "green" || normalized === "yellow") {
    return normalized;
  }
  return null;
}

function colorHit(color: "red" | "blue" | "green" | "yellow", h: number, s: number, v: number): boolean {
  if (color === "blue") return h >= 190 && h <= 255 && s >= 0.25 && v >= 0.12;
  if (color === "red") return (h <= 20 || h >= 340) && s >= 0.35 && v >= 0.12;
  if (color === "green") return h >= 75 && h <= 165 && s >= 0.2 && v >= 0.12;
  return h >= 35 && h <= 70 && s >= 0.2 && v >= 0.2;
}

function largestComponentByMask(mask: Uint8Array, width: number, height: number) {
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const stack = new Int32Array(pixelCount);

  let bestArea = 0;
  let bestMinX = 0;
  let bestMinY = 0;
  let bestMaxX = 0;
  let bestMaxY = 0;

  for (let idx = 0; idx < pixelCount; idx += 1) {
    if (mask[idx] === 0 || visited[idx] === 1) continue;

    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    let head = 0;
    stack[head++] = idx;
    visited[idx] = 1;

    while (head > 0) {
      const current = stack[--head];
      const x = current % width;
      const y = Math.floor(current / width);

      area += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      if (x > 0) {
        const n = current - 1;
        if (mask[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          stack[head++] = n;
        }
      }
      if (x < width - 1) {
        const n = current + 1;
        if (mask[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          stack[head++] = n;
        }
      }
      if (y > 0) {
        const n = current - width;
        if (mask[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          stack[head++] = n;
        }
      }
      if (y < height - 1) {
        const n = current + width;
        if (mask[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          stack[head++] = n;
        }
      }
    }

    if (area > bestArea) {
      bestArea = area;
      bestMinX = minX;
      bestMinY = minY;
      bestMaxX = maxX;
      bestMaxY = maxY;
    }
  }

  if (bestArea <= 0) return null;

  return {
    area: bestArea,
    bbox: {
      x: bestMinX,
      y: bestMinY,
      w: bestMaxX - bestMinX + 1,
      h: bestMaxY - bestMinY + 1
    }
  };
}

function detectByColorFallback(frameBase64: string, color: "red" | "blue" | "green" | "yellow"): PerceivedObject[] {
  const decoded = decodeImage(frameBase64);
  const pixelCount = decoded.width * decoded.height;
  const mask = new Uint8Array(pixelCount);

  for (let i = 0; i < pixelCount; i += 1) {
    const px = i * 4;
    const hsv = rgbToHsv(decoded.data[px], decoded.data[px + 1], decoded.data[px + 2]);
    mask[i] = colorHit(color, hsv.h, hsv.s, hsv.v) ? 1 : 0;
  }

  const largest = largestComponentByMask(mask, decoded.width, decoded.height);
  if (!largest) return [];

  const normalizedArea = largest.area / (decoded.width * decoded.height);
  const conf = clamp(normalizedArea * 9, 0.05, 0.9);

  return [
    {
      label: `${color} object`,
      confidence: conf,
      bbox: {
        x: clamp(largest.bbox.x / decoded.width, 0, 1),
        y: clamp(largest.bbox.y / decoded.height, 0, 1),
        w: clamp(largest.bbox.w / decoded.width, 0, 1),
        h: clamp(largest.bbox.h / decoded.height, 0, 1)
      },
      attributes: ["fallback_color"]
    }
  ];
}

function extractResponsesText(payload: any): string {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  if (Array.isArray(payload?.output)) {
    for (const item of payload.output) {
      if (!Array.isArray(item?.content)) continue;
      for (const content of item.content) {
        if (typeof content?.text === "string" && content.text.trim()) {
          return content.text;
        }
      }
    }
  }

  return "";
}

function sanitizeObject(raw: any): PerceivedObject | null {
  if (!raw || typeof raw !== "object") return null;
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  const confidence = typeof raw.confidence === "number" ? clamp(raw.confidence, 0, 1) : 0;
  const bbox = raw.bbox || raw.bbox_norm;
  if (!label || !bbox || typeof bbox !== "object") return null;

  const x = typeof bbox.x === "number" ? clamp(bbox.x, 0, 1) : 0;
  const y = typeof bbox.y === "number" ? clamp(bbox.y, 0, 1) : 0;
  const w = typeof bbox.w === "number" ? clamp(bbox.w, 0, 1 - x) : 0;
  const h = typeof bbox.h === "number" ? clamp(bbox.h, 0, 1 - y) : 0;
  if (w <= 0 || h <= 0) return null;

  return {
    label,
    confidence,
    bbox: { x, y, w, h },
    attributes: Array.isArray(raw.attributes)
      ? raw.attributes.filter((v: unknown) => typeof v === "string").map((v: string) => v.trim()).filter(Boolean)
      : undefined
  };
}

async function detectObjectsWithOpenAI(frameBase64: string, instruction: string): Promise<OpenAIPerception> {
  const apiKey = envValue("OPENAI_API_KEY", "OPEN_AI_API_KEY");
  if (!apiKey) {
    return {
      objects: [],
      summary: "OpenAI perception unavailable (missing OPENAI_API_KEY or OPEN_AI_API_KEY)",
      error: "missing_api_key"
    };
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      objects: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            bbox: {
              type: "object",
              additionalProperties: false,
              properties: {
                x: { type: "number", minimum: 0, maximum: 1 },
                y: { type: "number", minimum: 0, maximum: 1 },
                w: { type: "number", minimum: 0, maximum: 1 },
                h: { type: "number", minimum: 0, maximum: 1 }
              },
              required: ["x", "y", "w", "h"]
            },
            attributes: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["label", "confidence", "bbox", "attributes"]
        }
      }
    },
    required: ["summary", "objects"]
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: envValue("OPENAI_VISION_MODEL") || "gpt-4.1-mini",
        temperature: 0,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text:
                  "Return strict JSON only. Detect visible objects relevant for robot navigation/manipulation. Bounding boxes must be normalized [0..1]. Use label aliases for common items (e.g., phone/cell phone/mobile phone/smartphone)."
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Instruction: ${instruction}`
              },
              {
                type: "input_image",
                image_url: `data:image/jpeg;base64,${frameBase64}`
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "vision_perception",
            strict: true,
            schema
          }
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text();
      return { objects: [], summary: "OpenAI perception failed", error: `http_${response.status}:${errText.slice(0, 120)}` };
    }

    const payload = await response.json();
    const rawText = extractResponsesText(payload);
    if (!rawText.trim()) {
      return { objects: [], summary: "OpenAI returned empty output", error: "empty_output" };
    }

    const parsed = JSON.parse(rawText);
    const summary = typeof parsed?.summary === "string" ? parsed.summary : "OpenAI perception response";
    const objects = Array.isArray(parsed?.objects)
      ? parsed.objects.map((obj: unknown) => sanitizeObject(obj)).filter((obj: PerceivedObject | null): obj is PerceivedObject => obj !== null)
      : [];

    return { objects, summary };
  } catch (error) {
    return {
      objects: [],
      summary: "OpenAI perception error",
      error: error instanceof Error ? error.message : "unknown_error"
    };
  } finally {
    clearTimeout(timeout);
  }
}

function composePerception(objects: PerceivedObject[], selected: PerceivedObject | undefined, summary: string): Perception {
  const bbox = selected?.bbox || null;
  const area = bbox ? bbox.w * bbox.h : 0;
  const offset = bbox ? bbox.x + bbox.w / 2 - 0.5 : 0;

  return {
    objects,
    selected_target: selected,
    summary,
    found: Boolean(selected),
    bbox,
    area,
    offset_x: offset,
    center_offset_x: offset * 320,
    confidence: selected?.confidence || 0
  };
}

function projectTrackedBBox(
  bbox: { x: number; y: number; w: number; h: number },
  motionScore: number
): { x: number; y: number; w: number; h: number } {
  const centerX = bbox.x + bbox.w / 2;
  const centerPull = clamp(0.5 - centerX, -0.5, 0.5);
  const dx = clamp(centerPull * motionScore * 0.35, -0.04, 0.04);
  return {
    x: clamp(bbox.x + dx, 0, 1 - bbox.w),
    y: bbox.y,
    w: bbox.w,
    h: bbox.h
  };
}

function buildPerceptionSchedule(parsed: ParsedInstruction, state: VisionState): PerceptionSchedule {
  const cached = state.perf_ctx.cached_perception;
  const lockLabel = state.target_lock_ctx ? canonicalLabel(state.target_lock_ctx.label) : "";
  const targetLabel = parsed.target.label ? canonicalLabel(parsed.target.label) : "";
  const targetCompatible = !targetLabel || !lockLabel || targetLabel === lockLabel;
  const strongLock =
    state.verification_ctx.status === "on_track" &&
    state.target_lock_ctx !== null &&
    state.target_lock_ctx.lost_ticks === 0 &&
    cached !== null &&
    cached.selected_target !== undefined &&
    targetCompatible;

  const period = computeOpenAIFramePeriod(state.verification_ctx.status, strongLock);
  const framesSinceFull = state.perf_ctx.frame_index - state.perf_ctx.last_openai_frame;
  const runFullModel = framesSinceFull >= period || parsed.task_type === "search" || !strongLock;
  const allowFastTrack = strongLock && parsed.task_type !== "search";

  return {
    allow_fast_track: allowFastTrack,
    run_full_model: runFullModel,
    reason: runFullModel ? `full_model_due(period=${period},since=${framesSinceFull})` : `fast_track_only(period=${period},since=${framesSinceFull})`,
    openai_period_frames: period,
    strong_lock: strongLock
  };
}

function maybeBuildFastTrackPerception(
  parsed: ParsedInstruction,
  lockCtx: VisionState["target_lock_ctx"],
  cachedPerception: Perception | null,
  motionScore: number
): Perception | null {
  if (!lockCtx || !cachedPerception?.selected_target) {
    return null;
  }

  const tracked = cachedPerception.selected_target;
  const trackedLabel = canonicalLabel(tracked.label);
  const targetLabel = parsed.target.label ? canonicalLabel(parsed.target.label) : "";
  if (targetLabel && trackedLabel !== targetLabel) {
    return null;
  }

  const projected = {
    ...tracked,
    bbox: projectTrackedBBox(tracked.bbox, motionScore),
    confidence: clamp(tracked.confidence * 0.94, 0, 1)
  };

  return composePerception(cachedPerception.objects, projected, "Fast-track from deterministic lock projection");
}

async function analyzePerception(
  frameBase64: string,
  instruction: string,
  parsed: ParsedInstruction,
  targetLockCtx: VisionState["target_lock_ctx"],
  confidenceFloor: number,
  cachedPerception: Perception | null,
  schedule: PerceptionSchedule,
  motionScore: number
): Promise<{
  perception: Perception;
  source: "openai_vision" | "fallback_color" | "none";
  notes: string[];
  target_scoring: TargetSelectionResult;
  timings_ms: { fast_track: number; full_model: number; select: number; fallback: number };
}> {
  if (shouldBypassPerceptionTask(parsed.task_type)) {
    return {
      perception: composePerception([], undefined, "Perception bypassed for non-visual command"),
      source: "none",
      notes: ["Perception bypassed due to task type"],
      target_scoring: {
        selected: undefined,
        target_required: false,
        decision_reason: "bypass_task_type",
        scored: []
      },
      timings_ms: { fast_track: 0, full_model: 0, select: 0, fallback: 0 }
    };
  }

  const notes: string[] = [];
  const fastTrackStart = Date.now();
  const fastTracked = schedule.allow_fast_track
    ? maybeBuildFastTrackPerception(parsed, targetLockCtx, cachedPerception, motionScore)
    : null;
  const fastTrackMs = Date.now() - fastTrackStart;
  if (fastTracked && !schedule.run_full_model) {
    const selectStart = Date.now();
    const fastSelection = selectTargetWithTraceDeterministic(fastTracked.objects, parsed, targetLockCtx);
    const selectMs = Date.now() - selectStart;
    const selected = fastSelection.selected && fastSelection.selected.confidence >= confidenceFloor ? fastSelection.selected : undefined;
    return {
      perception: composePerception(fastTracked.objects, selected, fastTracked.summary),
      source: "openai_vision",
      notes: [
        "Fast-track perception used (full model deferred)",
        `selection=${selected ? "selected" : "none"}:${fastSelection.decision_reason}`,
        `schedule=${schedule.reason}`
      ],
      target_scoring: fastSelection,
      timings_ms: { fast_track: fastTrackMs, full_model: 0, select: selectMs, fallback: 0 }
    };
  }

  const modelStart = Date.now();
  const openai = await detectObjectsWithOpenAI(frameBase64, instruction);
  const fullModelMs = Date.now() - modelStart;
  const selectStart = Date.now();
  const selection = selectTargetWithTraceDeterministic(openai.objects, parsed, targetLockCtx);
  let selectedFromOpenAI = selection.selected && selection.selected.confidence >= confidenceFloor ? selection.selected : undefined;
  const targetLabel = parsed.target.label ? canonicalLabel(parsed.target.label) : "";
  if (!selectedFromOpenAI && targetLabel) {
    const matching = openai.objects
      .filter((candidate) => canonicalLabel(candidate.label) === targetLabel && candidate.confidence >= confidenceFloor)
      .sort((a, b) => b.confidence - a.confidence);
    if (matching.length > 0) {
      selectedFromOpenAI = matching[0];
      notes.push(`selection contract fallback applied for target=${targetLabel}`);
    }
  }
  const selectMs = Date.now() - selectStart;

  if (selectedFromOpenAI) {
    return {
      perception: composePerception(openai.objects, selectedFromOpenAI, openai.summary),
      source: "openai_vision",
      notes: [
        ...(targetLockCtx ? [`target lock active: ${canonicalLabel(targetLockCtx.label)}`] : []),
        `selection=selected:${selection.decision_reason}`,
        `schedule=${schedule.reason}`
      ],
      target_scoring: selection,
      timings_ms: { fast_track: fastTrackMs, full_model: fullModelMs, select: selectMs, fallback: 0 }
    };
  }

  if (openai.error) {
    notes.push(`OpenAI unavailable: ${openai.error}`);
  } else {
    notes.push(`OpenAI target confidence too low or target not found: ${selection.decision_reason}`);
  }

  const fallbackColor = toSupportedFallbackColor(parsed.target.color);
  if (fallbackColor) {
    const fbStart = Date.now();
    const fallbackObjects = detectByColorFallback(frameBase64, fallbackColor);
    const selectedFallback = fallbackObjects[0];
    if (selectedFallback) {
      notes.push(`Fallback color detector used for ${fallbackColor}`);
      return {
        perception: composePerception(fallbackObjects, selectedFallback, `Fallback detection for ${fallbackColor}`),
        source: "fallback_color",
        notes: [...notes, `schedule=${schedule.reason}`],
        target_scoring: selection,
        timings_ms: { fast_track: fastTrackMs, full_model: fullModelMs, select: selectMs, fallback: Date.now() - fbStart }
      };
    }
  } else if (parsed.target.color) {
    notes.push(`No pixel fallback available for qualifier=${parsed.target.color}`);
  }

  if (!selectedFromOpenAI && targetLabel) {
    const hasMatching = openai.objects.some((candidate) => canonicalLabel(candidate.label) === targetLabel && candidate.confidence >= confidenceFloor);
    if (hasMatching) {
      notes.push(`ERROR: matching target ${targetLabel} present but selected_target null after fallback`);
    }
  }

  return {
    perception: composePerception(openai.objects, selectedFromOpenAI, openai.summary),
    source: openai.objects.length > 0 ? "openai_vision" : "none",
    notes: [...notes, `selection=none:${selection.decision_reason}`, `schedule=${schedule.reason}`],
    target_scoring: selection,
    timings_ms: { fast_track: fastTrackMs, full_model: fullModelMs, select: selectMs, fallback: 0 }
  };
}

function runStep(target: string, token: string, args: unknown[], durationMs?: number): PlanStep {
  const base: PlanStep = {
    type: "RUN",
    target,
    token,
    args
  };

  if (typeof durationMs === "number") {
    return { ...base, duration_ms: durationMs };
  }

  return base;
}

function stopStep(): PlanStep {
  return { type: "STOP" };
}

function validateCanonicalActionSchema(parsed: ParsedInstruction): void {
  if (!parsed.canonical_actions) {
    return;
  }
  for (const [index, action] of parsed.canonical_actions.entries()) {
    if (!action || typeof action !== "object" || !("type" in action)) {
      throw new Error(`canonical_actions[${index}] must be an object with type`);
    }
    if (action.type === "MOVE") {
      if (!["forward", "backward", "left", "right"].includes(action.direction)) {
        throw new Error(`canonical_actions[${index}] MOVE.direction invalid: ${String(action.direction)}`);
      }
      if (action.distance_m !== undefined && (!(typeof action.distance_m === "number") || !Number.isFinite(action.distance_m))) {
        throw new Error(`canonical_actions[${index}] MOVE.distance_m must be numeric`);
      }
      continue;
    }
    if (action.type === "TURN") {
      if (!["left", "right"].includes(action.direction)) {
        throw new Error(`canonical_actions[${index}] TURN.direction invalid: ${String(action.direction)}`);
      }
      if (action.angle_deg !== undefined && (!(typeof action.angle_deg === "number") || !Number.isFinite(action.angle_deg))) {
        throw new Error(`canonical_actions[${index}] TURN.angle_deg must be numeric`);
      }
      continue;
    }
    if (action.type !== "STOP") {
      throw new Error(`canonical_actions[${index}] unsupported type: ${String((action as { type?: unknown }).type)}`);
    }
  }
}

function uppercaseTokenSet(allowedTokenMap: Map<string, Set<string>> | null, target: string): Set<string> {
  const out = new Set<string>();
  const existing = allowedTokenMap?.get(target);
  if (!existing) {
    return out;
  }
  for (const token of existing) {
    out.add(token.toUpperCase());
  }
  return out;
}

function buildMotionSteps(
  parsed: ParsedInstruction,
  caps: Capabilities,
  allowedTokenMap: Map<string, Set<string>> | null
): { steps: PlanStep[]; mapping_notes: string[] } {
  const steps: PlanStep[] = [];
  const mapping_notes: string[] = [];
  const baseTokens = uppercaseTokenSet(allowedTokenMap, caps.base_target);
  const tokenAvailable = (token: string) => !allowedTokenMap || baseTokens.has(token.toUpperCase());
  const count = clamp(parsed.count || 1, 1, 10);

  if (parsed.pattern === "circle") {
    for (let i = 0; i < count; i += 1) {
      for (let k = 0; k < 4; k += 1) {
        steps.push(runStep(caps.base_target, caps.base_fwd_token, [0.55], 420));
        steps.push(runStep(caps.base_target, caps.base_turn_token, [90], 260));
      }
    }
    return { steps, mapping_notes };
  }

  if (parsed.pattern === "square") {
    for (let i = 0; i < count; i += 1) {
      for (let k = 0; k < 4; k += 1) {
        steps.push(runStep(caps.base_target, caps.base_fwd_token, [0.5], 460));
        steps.push(runStep(caps.base_target, caps.base_turn_token, [90], 280));
      }
    }
    return { steps, mapping_notes };
  }

  if (parsed.pattern === "triangle") {
    for (let i = 0; i < count; i += 1) {
      for (let k = 0; k < 3; k += 1) {
        steps.push(runStep(caps.base_target, caps.base_fwd_token, [0.5], 480));
        steps.push(runStep(caps.base_target, caps.base_turn_token, [120], 300));
      }
    }
    return { steps, mapping_notes };
  }

  const actions = parsed.canonical_actions ?? [
    {
      type: "MOVE",
      direction: "forward",
      distance_m: clamp(parsed.distance_m || 1, 0.1, 10),
      speed: 0.55
    } as CanonicalAction
  ];

  for (const action of actions) {
    if (action.type === "STOP") {
      steps.push(stopStep());
      continue;
    }

    if (action.type === "TURN") {
      const angle = clamp(Math.abs(action.angle_deg ?? 90), 1, 180);
      const signed = action.direction === "left" ? -angle : angle;
      if (tokenAvailable(caps.base_turn_token)) {
        steps.push(runStep(caps.base_target, caps.base_turn_token, [signed], 360));
        mapping_notes.push(`TURN(${action.direction},${angle}) -> ${caps.base_turn_token}`);
      } else if (tokenAvailable("MECANUM")) {
        const cmd = action.direction === "left" ? "Q" : "E";
        steps.push(runStep(caps.base_target, "MECANUM", [cmd], 360));
        mapping_notes.push(`TURN(${action.direction},${angle}) -> MECANUM(${cmd})`);
      } else {
        throw new Error(`No manifest token available to map TURN(${action.direction})`);
      }
      continue;
    }

    const distance = clamp(action.distance_m ?? parsed.distance_m ?? 1, 0.1, 10);
    const speed = clamp(action.speed ?? 0.55, 0.1, 1);
    const duration = clamp(Math.round(distance * 1800), 250, 8000);
    if (action.direction === "forward") {
      if (!tokenAvailable(caps.base_fwd_token)) {
        throw new Error(`No manifest token available to map MOVE(forward) expected ${caps.base_fwd_token}`);
      }
      steps.push(runStep(caps.base_target, caps.base_fwd_token, [speed], duration));
      mapping_notes.push(`MOVE(forward) -> ${caps.base_fwd_token}`);
      continue;
    }

    if (action.direction === "backward") {
      if (tokenAvailable("BWD")) {
        steps.push(runStep(caps.base_target, "BWD", [speed], duration));
        mapping_notes.push("MOVE(backward) -> BWD");
      } else if (tokenAvailable("MECANUM")) {
        steps.push(runStep(caps.base_target, "MECANUM", ["B"], duration));
        mapping_notes.push("MOVE(backward) -> MECANUM(B)");
      } else {
        throw new Error("No manifest token available to map MOVE(backward)");
      }
      continue;
    }

    if (action.direction === "left" || action.direction === "right") {
      const dir = action.direction === "left" ? "L" : "R";
      if (tokenAvailable(caps.base_strafe_token)) {
        steps.push(runStep(caps.base_target, caps.base_strafe_token, [dir, speed], duration));
        mapping_notes.push(`MOVE(${action.direction}) -> ${caps.base_strafe_token}(${dir})`);
      } else if (tokenAvailable("MECANUM")) {
        steps.push(runStep(caps.base_target, "MECANUM", [dir], duration));
        mapping_notes.push(`MOVE(${action.direction}) -> MECANUM(${dir})`);
      } else if (tokenAvailable(caps.base_turn_token)) {
        const fallbackTurn = action.direction === "left" ? -90 : 90;
        steps.push(runStep(caps.base_target, caps.base_turn_token, [fallbackTurn], 360));
        mapping_notes.push(`MOVE(${action.direction}) fallback -> ${caps.base_turn_token}(${fallbackTurn})`);
      } else {
        throw new Error(`No manifest token available to map MOVE(${action.direction})`);
      }
    }
  }
  return { steps, mapping_notes };
}

function hasObstacleOnPath(objects: PerceivedObject[], selected: PerceivedObject | undefined): boolean {
  const obstacleKeywords = ["person", "chair", "wall", "table", "obstacle", "barrier"];
  for (const object of objects) {
    if (selected && object === selected) continue;
    const label = object.label.toLowerCase();
    if (!obstacleKeywords.some((key) => label.includes(key))) continue;

    const centerX = object.bbox.x + object.bbox.w / 2;
    const nearCenter = Math.abs(centerX - 0.5) < 0.22;
    const largeEnough = object.bbox.w * object.bbox.h > 0.05;
    if (nearCenter && largeEnough && object.confidence >= 0.35) {
      return true;
    }
  }
  return false;
}

function computeFrameSignature(frameBase64: string): number[] {
  const decoded = decodeImage(frameBase64);
  const quadrants = [
    { sum: 0, n: 0 },
    { sum: 0, n: 0 },
    { sum: 0, n: 0 },
    { sum: 0, n: 0 }
  ];
  let globalSum = 0;

  for (let y = 0; y < decoded.height; y += 8) {
    for (let x = 0; x < decoded.width; x += 8) {
      const idx = (y * decoded.width + x) * 4;
      const lum = (decoded.data[idx] * 0.299 + decoded.data[idx + 1] * 0.587 + decoded.data[idx + 2] * 0.114) / 255;
      globalSum += lum;
      const q = (y < decoded.height / 2 ? 0 : 2) + (x < decoded.width / 2 ? 0 : 1);
      quadrants[q].sum += lum;
      quadrants[q].n += 1;
    }
  }

  const quadMeans = quadrants.map((q) => (q.n > 0 ? q.sum / q.n : 0));
  const global = globalSum / Math.max(1, quadrants.reduce((acc, q) => acc + q.n, 0));
  return [global, ...quadMeans].map((v) => clamp(v, 0, 1));
}

function signatureMotionScore(previous: number[] | null, current: number[]): number {
  if (!previous || previous.length !== current.length) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < current.length; i += 1) {
    sum += Math.abs(current[i] - previous[i]);
  }
  return clamp(sum / current.length, 0, 1);
}

function buildPlanAndState(
  previous: VisionState,
  parsed: ParsedInstruction,
  perception: Perception,
  allowedTokenMap: Map<string, Set<string>> | null
) {
  const next: VisionState = {
    ...previous,
    capabilities: { ...previous.capabilities },
    instruction_ctx: { ...previous.instruction_ctx },
    motion_ctx: { ...previous.motion_ctx }
  };

  const caps = next.capabilities;
  const plan: PlanStep[] = [];
  const notes: string[] = [];
  let policyBranch = "NONE";
  const alignTolerance = next.learning_ctx.align_tolerance;

  const searchSweep = () => {
    next.scan_ticks += 1;
    if (next.scan_ticks % 5 === 0) {
      next.scan_dir = next.scan_dir * -1;
    }
    plan.push(runStep(caps.base_target, caps.base_turn_token, [SEARCH_STEP_DEG * next.scan_dir], 220));
    plan.push(stopStep());
  };

  if (parsed.task_type === "stop") {
    next.stage = "DONE";
    policyBranch = "STOP/E_STOP";
    notes.push(parsed.stop_kind === "emergency" ? "Emergency stop requested" : "Stop requested");
    plan.push(stopStep());
    return { state: next, plan, policyBranch, notes };
  }

  if (parsed.task_type === "move-pattern") {
    next.stage = "MOTION_ONLY";
    policyBranch = "MOVE/PATTERN";
    const { steps, mapping_notes } = buildMotionSteps(parsed, caps, allowedTokenMap);
    notes.push(...mapping_notes);
    next.motion_ctx.total_steps = steps.length;

    if (next.motion_ctx.step_idx < steps.length) {
      const remaining = steps.slice(next.motion_ctx.step_idx);
      next.motion_ctx.step_idx = steps.length;
      notes.push(`motion macro emitted ${remaining.length} steps (${steps.length} total)`);
      plan.push(...remaining);
      plan.push(stopStep());
      next.motion_ctx.consumed = next.motion_ctx.step_idx >= steps.length;
    } else {
      next.motion_ctx.consumed = true;
      notes.push("motion macro already emitted for current instruction");
      plan.push(stopStep());
    }

    return { state: next, plan, policyBranch, notes };
  }

  if (parsed.task_type === "arm-control") {
    next.stage = "DONE";
    policyBranch = "ARM/CONTROL";
    const armTokens = uppercaseTokenSet(allowedTokenMap, caps.arm_target);
    const canGrip = !allowedTokenMap || armTokens.has(caps.arm_grip_token.toUpperCase());
    if (!canGrip) {
      notes.push("arm-control requested but arm GRIP token is unavailable; fail-closed STOP");
      plan.push(stopStep());
      return { state: next, plan, policyBranch, notes };
    }

    const actions = parsed.arm_actions && parsed.arm_actions.length > 0 ? parsed.arm_actions : [{ state: "hold" as const }];
    for (const action of actions) {
      const durationMs = typeof action.duration_s === "number" ? clamp(Math.round(action.duration_s * 1000), 0, 60_000) : undefined;
      plan.push(runStep(caps.arm_target, caps.arm_grip_token, [action.state], durationMs));
    }
    plan.push(stopStep());
    notes.push(`arm-control emitted ${actions.length} grip action(s)`);
    return { state: next, plan, policyBranch, notes };
  }

  if (next.stage === "DONE" || next.stage === "MOTION_ONLY") {
    next.stage = "SEARCH";
  }

  const target = perception.selected_target;

  switch (next.stage) {
    case "SEARCH": {
      if (target) {
        next.stage = "ALIGN";
        policyBranch = parsed.task_type === "follow" ? "FOLLOW/SEARCH_LOCK" : "PICK/SEARCH_LOCK";
        notes.push("Target acquired; switching to ALIGN");
        plan.push(stopStep());
      } else {
        policyBranch = parsed.task_type === "follow" ? "FOLLOW/SEARCH" : "PICK/SEARCH";
        notes.push("No target found; scanning");
        searchSweep();
      }
      break;
    }

    case "ALIGN": {
      if (!target) {
        next.stage = "SEARCH";
        policyBranch = parsed.task_type === "follow" ? "FOLLOW/LOST" : "PICK/LOST";
        notes.push("Target lost; back to SEARCH");
        searchSweep();
        break;
      }

      const off = perception.offset_x;
      if (Math.abs(off) <= alignTolerance) {
        next.stage = "APPROACH";
        policyBranch = parsed.task_type === "follow" ? "FOLLOW/ALIGN_OK" : "PICK/ALIGN_OK";
        notes.push("Alignment complete; switching to APPROACH");
        plan.push(stopStep());
      } else {
        const turnDeg = clamp(off * 55, -20, 20);
        policyBranch = parsed.task_type === "follow" ? "FOLLOW/TRACK_ALIGN" : "PICK/ALIGN";
        notes.push("Turning to center target");
        plan.push(runStep(caps.base_target, caps.base_turn_token, [Number(turnDeg.toFixed(2))], 220));
        plan.push(stopStep());
      }
      break;
    }

    case "APPROACH": {
      if (!target) {
        next.stage = "SEARCH";
        policyBranch = parsed.task_type === "follow" ? "FOLLOW/LOST" : "PICK/LOST";
        notes.push("Target lost during approach");
        searchSweep();
        break;
      }

      if (parsed.task_type === "avoid+approach" && hasObstacleOnPath(perception.objects, target)) {
        policyBranch = "AVOID/DETOUR";
        notes.push("Obstacle detected on path; applying deterministic sidestep");
        plan.push(runStep(caps.base_target, caps.base_turn_token, [18], 200));
        plan.push(stopStep());
        next.stage = "ALIGN";
        break;
      }

      if (parsed.task_type === "follow") {
        policyBranch = "FOLLOW/TRACK";
        notes.push("Follow mode: approach and keep tracking");
        plan.push(runStep(caps.base_target, caps.base_fwd_token, [0.45], 240));
        plan.push(stopStep());
        next.stage = "ALIGN";
        break;
      }

      if (perception.area >= CLOSE_AREA_THRESHOLD) {
        next.stage = "GRAB";
        policyBranch = "PICK/CLOSE";
        notes.push("Target close enough for grab");
        plan.push(stopStep());
      } else {
        policyBranch = parsed.task_type === "avoid+approach" ? "AVOID/APPROACH" : "PICK/APPROACH";
        notes.push("Approaching target");
        plan.push(runStep(caps.base_target, caps.base_fwd_token, [0.5], 300));
        plan.push(stopStep());
      }
      break;
    }

    case "GRAB": {
      policyBranch = "PICK/GRIP";
      notes.push("Closing gripper");
      plan.push(runStep(caps.arm_target, caps.arm_grip_token, ["close"]));
      plan.push(stopStep());
      next.stage = "DONE";
      break;
    }

    default: {
      policyBranch = "DONE/HOLD";
      notes.push("Task complete");
      next.stage = "DONE";
      plan.push(stopStep());
      break;
    }
  }

  return { state: next, plan, policyBranch, notes };
}

function buildVerification(
  parsed: ParsedInstruction,
  state: VisionState,
  nextState: VisionState,
  perception: Perception,
  motionScore: number
) {
  const previous = state.verification_ctx;
  let status: "on_track" | "uncertain" | "off_track" = "uncertain";
  let confidence = 0.5;
  let expectedPhase = "";
  let observedPhase = "";
  const evidence: string[] = [];

  if (parsed.task_type === "move-pattern") {
    expectedPhase = `motion_step_${nextState.motion_ctx.step_idx}/${Math.max(1, nextState.motion_ctx.total_steps)}`;
    observedPhase = motionScore > 0.01 ? "camera_motion_detected" : "low_camera_motion";
    confidence = clamp(motionScore * 25, 0, 1);
    if (nextState.motion_ctx.consumed) {
      status = "on_track";
      confidence = Math.max(confidence, 0.75);
      evidence.push("macro steps completed");
    } else if (motionScore > 0.01) {
      status = "on_track";
      evidence.push("motion observed during macro execution");
    } else {
      status = "off_track";
      evidence.push("insufficient observed motion for commanded macro");
    }
  } else {
    const target = perception.selected_target;
    const offsetAbs = Math.abs(perception.offset_x);
    const area = perception.area;
    const targetLabel = parsed.target.label ? canonicalLabel(parsed.target.label) : "";
    expectedPhase = nextState.stage.toLowerCase();
    observedPhase = target ? `target:${canonicalLabel(target.label)}` : "no_target";
    if (target) {
      const offsetTrend = previous.last_offset_abs - offsetAbs;
      const areaTrend = area - previous.last_area;
      const personPickMode = parsed.task_type === "pick-object" && targetLabel === "person";

      if (personPickMode) {
        if (offsetTrend > 0.005 && areaTrend > 0.001) {
          status = "on_track";
          confidence = clamp(target.confidence * 0.75 + 0.2, 0, 1);
          evidence.push("person-pick trend positive: offset decreased and area increased");
        } else if (offsetTrend > 0 || areaTrend > 0) {
          status = "uncertain";
          confidence = clamp(target.confidence * 0.55, 0, 1);
          evidence.push("person-pick trend mixed");
        } else {
          status = "off_track";
          confidence = clamp(target.confidence * 0.35, 0, 1);
          evidence.push("person-pick trend negative");
        }
      } else {
        confidence = clamp(target.confidence * 0.7 + clamp(offsetTrend * 5, -0.2, 0.2) + clamp(areaTrend * 1.5, -0.2, 0.2), 0, 1);
        if (confidence >= 0.45) {
          status = "on_track";
        } else {
          status = "uncertain";
        }
      }
      evidence.push(`offset_abs=${offsetAbs.toFixed(3)}`);
      evidence.push(`area=${area.toFixed(3)}`);
    } else if (nextState.stage === "SEARCH") {
      status = "uncertain";
      confidence = 0.25;
      evidence.push("searching without lock");
    } else {
      status = "off_track";
      confidence = 0.1;
      evidence.push("target missing outside SEARCH");
    }
  }

  const onTrackStreak = status === "on_track" ? previous.on_track_streak + 1 : 0;
  const offTrackStreak = status === "off_track" ? previous.off_track_streak + 1 : 0;

  return {
    status,
    confidence,
    expected_phase: expectedPhase,
    observed_phase: observedPhase,
    evidence,
    on_track_streak: onTrackStreak,
    off_track_streak: offTrackStreak
  };
}

function updateLearning(
  previous: VisionState["learning_ctx"],
  verification: { status: "on_track" | "uncertain" | "off_track" },
  selectedTarget: PerceivedObject | undefined,
  parsed: ParsedInstruction,
  totalLatencyMs: number,
  recoveryTriggered: boolean,
  taskOutcome: "pending" | "success" | "failure"
): VisionState["learning_ctx"] {
  const next = { ...previous };
  next.frames += 1;
  if (verification.status === "on_track") {
    next.on_track_frames += 1;
  }

  const selectedLabel = selectedTarget ? canonicalLabel(selectedTarget.label) : null;
  if (
    next.last_selected_label &&
    selectedLabel &&
    selectedLabel !== next.last_selected_label &&
    parsed.task_type !== "move-pattern" &&
    parsed.task_type !== "stop"
  ) {
    next.false_switches += 1;
  }
  next.last_selected_label = selectedLabel;

  if (recoveryTriggered) {
    next.recovery_count += 1;
  }

  next.avg_latency_ms = (next.avg_latency_ms * (next.frames - 1) + totalLatencyMs) / next.frames;
  const onTrackRatio = next.on_track_frames / Math.max(1, next.frames);
  const switchRatio = next.false_switches / Math.max(1, next.frames);

  if (switchRatio > 0.08) {
    next.confidence_floor = clamp(next.confidence_floor + 0.02, 0.25, 0.75);
  } else if (switchRatio < 0.03) {
    next.confidence_floor = clamp(next.confidence_floor - 0.005, 0.25, 0.75);
  }

  if (onTrackRatio < 0.45 && next.recovery_count > 1) {
    next.align_tolerance = clamp(next.align_tolerance - 0.003, 0.04, 0.14);
  } else if (onTrackRatio > 0.75) {
    next.align_tolerance = clamp(next.align_tolerance + 0.002, 0.04, 0.14);
  }

  if (taskOutcome === "success") {
    next.confidence_floor = clamp(next.confidence_floor - 0.01, 0.25, 0.75);
    next.align_tolerance = clamp(next.align_tolerance + 0.001, 0.04, 0.14);
  } else if (taskOutcome === "failure") {
    next.confidence_floor = clamp(next.confidence_floor + 0.015, 0.25, 0.75);
    next.align_tolerance = clamp(next.align_tolerance - 0.002, 0.04, 0.14);
  }

  return next;
}

function buildAllowedTokenMap(manifest: unknown): Map<string, Set<string>> | null {
  if (!isObject(manifest)) {
    return null;
  }

  const nodes = (manifest as SystemManifestInput).nodes;
  if (!Array.isArray(nodes)) {
    return null;
  }

  const allowed = new Map<string, Set<string>>();

  for (const node of nodes) {
    if (!isObject(node) || typeof node.name !== "string") {
      continue;
    }

    const tokenSet = new Set<string>();
    if (Array.isArray(node.commands)) {
      for (const command of node.commands) {
        if (isObject(command) && typeof command.token === "string") {
          tokenSet.add(command.token.toUpperCase());
        }
      }
    }
    allowed.set(node.name, tokenSet);
  }

  return allowed;
}

function sanitizePlanToManifest(plan: PlanStep[], allowedTokenMap: Map<string, Set<string>> | null) {
  if (!allowedTokenMap) {
    return { plan, dropped: 0, dropped_details: [] as Array<Record<string, unknown>> };
  }

  const nextPlan: PlanStep[] = [];
  let dropped = 0;
  const droppedDetails: Array<Record<string, unknown>> = [];

  for (const step of plan) {
    if (step.type === "STOP") {
      nextPlan.push(step);
      continue;
    }

    const tokens = allowedTokenMap.get(step.target);
    if (tokens && tokens.has(step.token.toUpperCase())) {
      nextPlan.push(step);
    } else {
      dropped += 1;
      droppedDetails.push({
        target: step.target,
        token: step.token,
        available_tokens: tokens ? Array.from(tokens) : []
      });
    }
  }

  if (nextPlan.length === 0 || nextPlan[nextPlan.length - 1]?.type !== "STOP") {
    nextPlan.push(stopStep());
  }

  return {
    plan: nextPlan,
    dropped,
    dropped_details: droppedDetails
  };
}

function resetStateForInstruction(previous: VisionState, newHash: string): VisionState {
  return {
    ...previous,
    stage: "SEARCH",
    scan_dir: 1,
    scan_ticks: 0,
    instruction_ctx: { hash: newHash },
    motion_ctx: { consumed: false, step_idx: 0, total_steps: 0 },
    target_lock_ctx: null
    ,
    verification_ctx: { ...DEFAULT_STATE.verification_ctx },
    task_eval_ctx: {
      ...DEFAULT_STATE.task_eval_ctx,
      episode_index: previous.task_eval_ctx.episode_index + 1
    },
    perf_ctx: { ...previous.perf_ctx, cached_perception: null, cached_source: "none" }
  };
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request.headers.get("origin"))
  });
}

export async function POST(request: Request) {
  const headers = corsHeaders(request.headers.get("origin"));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST", message: "Invalid JSON body" }, { status: 400, headers });
  }

  if (!isObject(body)) {
    return NextResponse.json({ error: "BAD_REQUEST", message: "Body must be a JSON object" }, { status: 400, headers });
  }

  const frameBase64 = body.frame_jpeg_base64;
  const instruction = body.instruction;
  const correlationId =
    (typeof body.correlation_id === "string" && body.correlation_id.trim()) ||
    request.headers.get("x-correlation-id") ||
    generateCorrelationId();

  if (typeof frameBase64 !== "string" || frameBase64.length < 20) {
    return NextResponse.json({ error: "BAD_REQUEST", message: "frame_jpeg_base64 is required" }, { status: 400, headers });
  }

  if (typeof instruction !== "string" || !instruction.trim()) {
    return NextResponse.json({ error: "BAD_REQUEST", message: "instruction is required" }, { status: 400, headers });
  }

  try {
    const totalStart = Date.now();
    const parseStart = Date.now();
    const parsed = parseInstruction(instruction);
    validateCanonicalActionSchema(parsed);
    const instructionHash = fnv1aHash(normalizeInstruction(instruction));
    const parseMs = Date.now() - parseStart;
    const allowedTokenMap = buildAllowedTokenMap(body.system_manifest);
    const allowedBaseTokens = allowedTokenMap?.get("base") ? Array.from(allowedTokenMap.get("base") || []) : [];
    logVisionTrace("vision_step.parse", correlationId, {
      instruction: instruction.trim(),
      parsed_task_type: parsed.task_type,
      parsed_pattern: parsed.pattern ?? null,
      parsed_canonical_actions: parsed.canonical_actions ?? null,
      allowed_base_tokens: allowedBaseTokens
    });

    let state = normalizeState(body.state);
    const notes: string[] = [];

    if (state.instruction_ctx.hash !== instructionHash) {
      state = resetStateForInstruction(state, instructionHash);
      notes.push("instruction hash changed; state reset for immediate task switch");
    }

    const signatureStart = Date.now();
    const frameSignature = computeFrameSignature(frameBase64);
    const signatureMs = Date.now() - signatureStart;
    const motionScore = signatureMotionScore(state.verification_ctx.last_signature, frameSignature);

    const schedule = buildPerceptionSchedule(parsed, state);
    notes.push(`perception_schedule=${schedule.reason}`);

    const perceptionStart = Date.now();
    const perceptionResult = await analyzePerception(
      frameBase64,
      instruction,
      parsed,
      state.target_lock_ctx,
      state.learning_ctx.confidence_floor,
      state.perf_ctx.cached_perception,
      schedule,
      motionScore
    );
    const perceptionMs = Date.now() - perceptionStart;
    notes.push(...perceptionResult.notes);

    const policyStart = Date.now();
    const output = buildPlanAndState(state, parsed, perceptionResult.perception, allowedTokenMap);
    const policyMs = Date.now() - policyStart;
    output.state.target_lock_ctx = updateTargetLockCtx(state.target_lock_ctx, perceptionResult.perception.selected_target);

    const verificationStart = Date.now();
    const verification = buildVerification(parsed, state, output.state, perceptionResult.perception, motionScore);
    let recoveryTriggered = false;
    let planForValidation = output.plan;
    let recoveryBranch = output.policyBranch;
    if (verification.off_track_streak >= 3) {
      recoveryTriggered = true;
      planForValidation = [stopStep()];
      recoveryBranch = `${output.policyBranch}/RECOVERY_STOP`;
      if (parsed.task_type === "move-pattern") {
        output.state.motion_ctx = { consumed: false, step_idx: 0, total_steps: 0 };
      } else {
        output.state.stage = "SEARCH";
      }
      notes.push("verification off_track streak threshold hit; fail-closed STOP");
    }
    const verificationMs = Date.now() - verificationStart;
    const taskValidation = evaluateTaskValidation(
      parsed,
      state,
      output.state,
      perceptionResult.perception,
      planForValidation,
      motionScore,
      recoveryTriggered
    );

    const totalMs = Date.now() - totalStart;
    output.state.verification_ctx = {
      ...output.state.verification_ctx,
      status: verification.status,
      confidence: verification.confidence,
      on_track_streak: verification.on_track_streak,
      off_track_streak: verification.off_track_streak,
      last_motion_score: motionScore,
      last_offset_abs: Math.abs(perceptionResult.perception.offset_x),
      last_area: perceptionResult.perception.area,
      last_signature: frameSignature
    };

    let persistentMetrics: PersistentTaskMetrics | null = null;
    const isTerminalOutcome = taskValidation.outcome === "success" || taskValidation.outcome === "failure";
    const shouldFinalizeOutcome = isTerminalOutcome && !state.task_eval_ctx.finalized;
    if (shouldFinalizeOutcome) {
      persistentMetrics = persistTaskOutcome(parsed, taskValidation);
      notes.push(`task_outcome_persisted=${taskValidation.outcome}`);
    }

    output.state.task_eval_ctx = {
      ...output.state.task_eval_ctx,
      finalized: shouldFinalizeOutcome ? true : state.task_eval_ctx.finalized,
      last_outcome: taskValidation.outcome,
      success_streak:
        taskValidation.outcome === "success"
          ? state.task_eval_ctx.success_streak + 1
          : taskValidation.outcome === "failure"
            ? 0
            : state.task_eval_ctx.success_streak,
      failure_streak:
        taskValidation.outcome === "failure"
          ? state.task_eval_ctx.failure_streak + 1
          : taskValidation.outcome === "success"
            ? 0
            : state.task_eval_ctx.failure_streak,
      target_label: parsed.target.label ? canonicalLabel(parsed.target.label) : null,
      target_color: parsed.target.color || null,
      label_mismatch_count:
        state.task_eval_ctx.label_mismatch_count + (taskValidation.checks.target_label_ok ? 0 : 1),
      color_mismatch_count:
        state.task_eval_ctx.color_mismatch_count + (taskValidation.checks.target_color_ok ? 0 : 1)
    };

    output.state.learning_ctx = updateLearning(
      state.learning_ctx,
      verification,
      perceptionResult.perception.selected_target,
      parsed,
      totalMs,
      recoveryTriggered,
      shouldFinalizeOutcome ? taskValidation.outcome : "pending"
    );
    output.state.perf_ctx = {
      frame_index: state.perf_ctx.frame_index + 1,
      last_latency_ms: totalMs,
      recommended_interval_ms: recommendIntervalMs(verification.status, totalMs, schedule.strong_lock),
      last_openai_frame:
        perceptionResult.timings_ms.full_model > 0
          ? state.perf_ctx.frame_index + 1
          : state.perf_ctx.last_openai_frame,
      cached_perception: perceptionResult.source === "openai_vision" ? perceptionResult.perception : state.perf_ctx.cached_perception,
      cached_source: perceptionResult.source === "openai_vision" ? "openai_vision" : state.perf_ctx.cached_source
    };

    const safePlan = sanitizePlanToManifest(planForValidation, allowedTokenMap);
    if (safePlan.dropped > 0) {
      logVisionTrace("vision_step.manifest_drop", correlationId, {
        dropped_steps: safePlan.dropped,
        dropped_details: safePlan.dropped_details
      });
    }
    logVisionTrace("vision_step.plan", correlationId, {
      policy_branch: recoveryBranch,
      generated_plan: planForValidation,
      safe_plan: safePlan.plan,
      dropped_steps: safePlan.dropped
    });

    return NextResponse.json(
      {
        correlation_id: correlationId,
        state: output.state,
        perception: perceptionResult.perception,
        plan: safePlan.plan,
        debug: {
          correlation_id: correlationId,
          applied_instruction: instruction.trim(),
          instruction_hash: instructionHash,
          policy_branch: recoveryBranch,
          parsed_instruction: parsed,
          perception_source: perceptionResult.source,
          target_scoring: {
            decision_reason: perceptionResult.target_scoring.decision_reason,
            target_required: perceptionResult.target_scoring.target_required,
            top_candidates: perceptionResult.target_scoring.scored.slice(0, 5)
          },
          verification: {
            expected_phase: verification.expected_phase,
            observed_phase: verification.observed_phase,
            confidence: verification.confidence,
            status: verification.status,
            evidence: verification.evidence
          },
          task_validation: taskValidation,
          learning: {
            frames: output.state.learning_ctx.frames,
            on_track_frames: output.state.learning_ctx.on_track_frames,
            false_switches: output.state.learning_ctx.false_switches,
            recovery_count: output.state.learning_ctx.recovery_count,
            confidence_floor: output.state.learning_ctx.confidence_floor,
            align_tolerance: output.state.learning_ctx.align_tolerance,
            avg_latency_ms: Number(output.state.learning_ctx.avg_latency_ms.toFixed(2))
          },
          persistent_task_metrics: persistentMetrics
            ? {
                total_success: persistentMetrics.total_success,
                total_failure: persistentMetrics.total_failure,
                current_target_key: targetMetricsKey(parsed),
                current_target_stats: persistentMetrics.by_target[targetMetricsKey(parsed)] || null
              }
            : null,
          timings_ms: {
            parse: parseMs,
            signature: signatureMs,
            fast_track: perceptionResult.timings_ms.fast_track,
            full_model: perceptionResult.timings_ms.full_model,
            select: perceptionResult.timings_ms.select,
            perception_model: perceptionResult.timings_ms.full_model,
            perception_fallback: perceptionResult.timings_ms.fallback,
            perception_total: perceptionMs,
            policy: policyMs,
            verification: verificationMs,
            total: totalMs
          },
          notes: [
            ...notes,
            ...output.notes,
            output.state.target_lock_ctx
              ? `lock=${output.state.target_lock_ctx.label},lost=${output.state.target_lock_ctx.lost_ticks}`
              : "lock=none",
            `motion_score=${motionScore.toFixed(4)}`,
            `next_interval_ms=${output.state.perf_ctx.recommended_interval_ms}`
          ],
          manifest_guard: {
            enabled: Boolean(allowedTokenMap),
            dropped_steps: safePlan.dropped,
            dropped_steps_detail: safePlan.dropped_details
          }
        }
      },
      { status: 200, headers }
    );
  } catch (error) {
    logVisionTrace("vision_step.error", correlationId, {
      error: error instanceof Error ? error.message : "failed to process frame"
    });
    return NextResponse.json(
      {
        error: "VISION_ERROR",
        message: error instanceof Error ? error.message : "failed to process frame"
      },
      { status: 400, headers }
    );
  }
}
