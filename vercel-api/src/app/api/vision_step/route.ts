import { NextResponse } from "next/server";
import jpeg from "jpeg-js";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalLabel,
  parseInstruction as parseInstructionPolicy,
  selectTargetDeterministic,
  shouldBypassPerceptionTask,
  updateTargetLockCtx
} from "@/lib/visionPolicy";

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
type TaskType = "stop" | "move-pattern" | "pick-object" | "follow" | "search" | "avoid+approach" | "unknown";

type MotionPattern = "circle" | "square" | "triangle" | "forward";

interface TargetSpec {
  query: string | null;
  label: string | null;
  color: "red" | "blue" | "green" | "yellow" | null;
}

interface ParsedInstruction {
  task_type: TaskType;
  stop_kind?: "normal" | "emergency";
  target: TargetSpec;
  pattern?: MotionPattern;
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
  };
  target_lock_ctx: {
    label: string;
    bbox: { x: number; y: number; w: number; h: number };
    lost_ticks: number;
  } | null;
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

const DEFAULT_STATE: VisionState = {
  stage: "SEARCH",
  scan_dir: 1,
  scan_ticks: 0,
  capabilities: {
    base_target: "base",
    arm_target: "arm",
    base_turn_token: "TURN",
    base_fwd_token: "FWD",
    arm_grip_token: "GRIP"
  },
  instruction_ctx: {
    hash: ""
  },
  motion_ctx: {
    consumed: false
  },
  target_lock_ctx: null
};

const ALIGN_OFFSET_THRESHOLD = 0.07;
const SEARCH_STEP_DEG = 12;
const CLOSE_AREA_THRESHOLD = 0.09;
const OPENAI_MIN_CONFIDENCE = 0.35;
let FILE_ENV_CACHE: Record<string, string> | null = null;

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
      arm_grip_token: toStringOr(DEFAULT_STATE.capabilities.arm_grip_token, capabilitiesInput.arm_grip_token)
    },
    instruction_ctx: {
      hash: toStringOr("", instructionCtxInput.hash)
    },
    motion_ctx: {
      consumed: Boolean(motionCtxInput.consumed)
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

function colorHit(color: NonNullable<TargetSpec["color"]>, h: number, s: number, v: number): boolean {
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

function detectByColorFallback(frameBase64: string, color: NonNullable<TargetSpec["color"]>): PerceivedObject[] {
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

async function analyzePerception(
  frameBase64: string,
  instruction: string,
  parsed: ParsedInstruction,
  targetLockCtx: VisionState["target_lock_ctx"]
): Promise<{ perception: Perception; source: "openai_vision" | "fallback_color" | "none"; notes: string[] }> {
  if (shouldBypassPerceptionTask(parsed.task_type)) {
    return {
      perception: composePerception([], undefined, "Perception bypassed for non-visual command"),
      source: "none",
      notes: ["Perception bypassed due to task type"]
    };
  }

  const notes: string[] = [];
  const openai = await detectObjectsWithOpenAI(frameBase64, instruction);
  const selectedFromOpenAI = selectTargetDeterministic(openai.objects, parsed, targetLockCtx);
  if (selectedFromOpenAI && selectedFromOpenAI.confidence >= OPENAI_MIN_CONFIDENCE) {
    return {
      perception: composePerception(openai.objects, selectedFromOpenAI, openai.summary),
      source: "openai_vision",
      notes: targetLockCtx ? [...notes, `target lock active: ${canonicalLabel(targetLockCtx.label)}`] : notes
    };
  }

  if (openai.error) {
    notes.push(`OpenAI unavailable: ${openai.error}`);
  } else {
    notes.push("OpenAI target confidence too low or target not found");
  }

  if (parsed.target.color) {
    const fallbackObjects = detectByColorFallback(frameBase64, parsed.target.color);
    const selectedFallback = fallbackObjects[0];
    if (selectedFallback) {
      notes.push(`Fallback color detector used for ${parsed.target.color}`);
      return {
        perception: composePerception(fallbackObjects, selectedFallback, `Fallback detection for ${parsed.target.color}`),
        source: "fallback_color",
        notes
      };
    }
  }

  return {
    perception: composePerception(openai.objects, selectedFromOpenAI, openai.summary),
    source: openai.objects.length > 0 ? "openai_vision" : "none",
    notes
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

function buildMotionPlan(parsed: ParsedInstruction, caps: Capabilities): { plan: PlanStep[]; notes: string[] } {
  const plan: PlanStep[] = [];
  const notes: string[] = [];

  const count = clamp(parsed.count || 1, 1, 10);

  if (parsed.pattern === "circle") {
    for (let i = 0; i < count; i += 1) {
      for (let k = 0; k < 4; k += 1) {
        plan.push(runStep(caps.base_target, caps.base_fwd_token, [0.55], 450));
        plan.push(runStep(caps.base_target, caps.base_turn_token, [90], 300));
      }
    }
    notes.push(`circle macro count=${count}`);
  } else if (parsed.pattern === "square") {
    for (let i = 0; i < count; i += 1) {
      for (let k = 0; k < 4; k += 1) {
        plan.push(runStep(caps.base_target, caps.base_fwd_token, [0.5], 500));
        plan.push(runStep(caps.base_target, caps.base_turn_token, [90], 300));
      }
    }
    notes.push(`square macro count=${count}`);
  } else if (parsed.pattern === "triangle") {
    for (let i = 0; i < count; i += 1) {
      for (let k = 0; k < 3; k += 1) {
        plan.push(runStep(caps.base_target, caps.base_fwd_token, [0.5], 500));
        plan.push(runStep(caps.base_target, caps.base_turn_token, [120], 320));
      }
    }
    notes.push(`triangle macro count=${count}`);
  } else {
    const distance = clamp(parsed.distance_m || 1, 0.1, 10);
    const duration = clamp(Math.round(distance * 1800), 250, 8000);
    plan.push(runStep(caps.base_target, caps.base_fwd_token, [0.55], duration));
    notes.push(`forward macro distance_m=${distance}`);
  }

  plan.push(stopStep());
  return { plan, notes };
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

function buildPlanAndState(previous: VisionState, parsed: ParsedInstruction, perception: Perception) {
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

    if (!next.motion_ctx.consumed) {
      const macro = buildMotionPlan(parsed, caps);
      notes.push(...macro.notes);
      plan.push(...macro.plan);
      next.motion_ctx.consumed = true;
    } else {
      notes.push("motion macro already emitted for current instruction");
      plan.push(stopStep());
    }

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
      if (Math.abs(off) <= ALIGN_OFFSET_THRESHOLD) {
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
          tokenSet.add(command.token);
        }
      }
    }
    allowed.set(node.name, tokenSet);
  }

  return allowed;
}

function sanitizePlanToManifest(plan: PlanStep[], allowedTokenMap: Map<string, Set<string>> | null) {
  if (!allowedTokenMap) {
    return { plan, dropped: 0 };
  }

  const nextPlan: PlanStep[] = [];
  let dropped = 0;

  for (const step of plan) {
    if (step.type === "STOP") {
      nextPlan.push(step);
      continue;
    }

    const tokens = allowedTokenMap.get(step.target);
    if (tokens && tokens.has(step.token)) {
      nextPlan.push(step);
    } else {
      dropped += 1;
    }
  }

  if (nextPlan.length === 0 || nextPlan[nextPlan.length - 1]?.type !== "STOP") {
    nextPlan.push(stopStep());
  }

  return {
    plan: nextPlan,
    dropped
  };
}

function resetStateForInstruction(previous: VisionState, newHash: string): VisionState {
  return {
    ...previous,
    stage: "SEARCH",
    scan_dir: 1,
    scan_ticks: 0,
    instruction_ctx: { hash: newHash },
    motion_ctx: { consumed: false },
    target_lock_ctx: null
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

  if (typeof frameBase64 !== "string" || frameBase64.length < 20) {
    return NextResponse.json({ error: "BAD_REQUEST", message: "frame_jpeg_base64 is required" }, { status: 400, headers });
  }

  if (typeof instruction !== "string" || !instruction.trim()) {
    return NextResponse.json({ error: "BAD_REQUEST", message: "instruction is required" }, { status: 400, headers });
  }

  try {
    const parsed = parseInstruction(instruction);
    const instructionHash = fnv1aHash(normalizeInstruction(instruction));

    let state = normalizeState(body.state);
    const notes: string[] = [];

    if (state.instruction_ctx.hash !== instructionHash) {
      state = resetStateForInstruction(state, instructionHash);
      notes.push("instruction hash changed; state reset for immediate task switch");
    }

    const perceptionResult = await analyzePerception(frameBase64, instruction, parsed, state.target_lock_ctx);
    notes.push(...perceptionResult.notes);

    const output = buildPlanAndState(state, parsed, perceptionResult.perception);
    output.state.target_lock_ctx = updateTargetLockCtx(state.target_lock_ctx, perceptionResult.perception.selected_target);
    const allowedTokenMap = buildAllowedTokenMap(body.system_manifest);
    const safePlan = sanitizePlanToManifest(output.plan, allowedTokenMap);

    return NextResponse.json(
      {
        state: output.state,
        perception: perceptionResult.perception,
        plan: safePlan.plan,
        debug: {
          policy_branch: output.policyBranch,
          parsed_instruction: parsed,
          perception_source: perceptionResult.source,
          notes: [
            ...notes,
            ...output.notes,
            output.state.target_lock_ctx
              ? `lock=${output.state.target_lock_ctx.label},lost=${output.state.target_lock_ctx.lost_ticks}`
              : "lock=none"
          ],
          manifest_guard: {
            enabled: Boolean(allowedTokenMap),
            dropped_steps: safePlan.dropped
          }
        }
      },
      { status: 200, headers }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: "VISION_ERROR",
        message: error instanceof Error ? error.message : "failed to process frame"
      },
      { status: 400, headers }
    );
  }
}
