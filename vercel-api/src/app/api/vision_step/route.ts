import { NextResponse } from "next/server";
import jpeg from "jpeg-js";

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

type Stage = "SEARCH" | "ALIGN" | "APPROACH" | "FINAL_ALIGN" | "GRAB" | "DONE";

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
}

interface Perception {
  found: boolean;
  bbox: { x: number; y: number; w: number; h: number } | null;
  area: number;
  center_offset_x: number;
  confidence: number;
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
  }
};

const ALIGN_PX = 20;
const FINAL_ALIGN_PX = 8;
const SEARCH_STEP_DEG = 12;
const CLOSE_AREA_THRESHOLD = 3000;

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

function normalizeState(input: unknown): VisionState {
  if (!isObject(input)) {
    return { ...DEFAULT_STATE };
  }

  const rawStage = toStringOr(DEFAULT_STATE.stage, input.stage).toUpperCase();
  const stage: Stage = ["SEARCH", "ALIGN", "APPROACH", "FINAL_ALIGN", "GRAB", "DONE"].includes(rawStage)
    ? (rawStage as Stage)
    : DEFAULT_STATE.stage;

  const capabilitiesInput = isObject(input.capabilities) ? input.capabilities : {};
  const scanDir = typeof input.scan_dir === "number" ? input.scan_dir : DEFAULT_STATE.scan_dir;
  const scanTicks = typeof input.scan_ticks === "number" ? input.scan_ticks : DEFAULT_STATE.scan_ticks;

  return {
    stage,
    scan_dir: scanDir >= 0 ? 1 : -1,
    scan_ticks: Number.isFinite(scanTicks) ? Math.max(0, Math.floor(scanTicks)) : 0,
    capabilities: {
      base_target: toStringOr(DEFAULT_STATE.capabilities.base_target, capabilitiesInput.base_target),
      arm_target: toStringOr(DEFAULT_STATE.capabilities.arm_target, capabilitiesInput.arm_target),
      base_turn_token: toStringOr(DEFAULT_STATE.capabilities.base_turn_token, capabilitiesInput.base_turn_token),
      base_fwd_token: toStringOr(DEFAULT_STATE.capabilities.base_fwd_token, capabilitiesInput.base_fwd_token),
      arm_grip_token: toStringOr(DEFAULT_STATE.capabilities.arm_grip_token, capabilitiesInput.arm_grip_token)
    }
  };
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

function isBluePixel(r: number, g: number, b: number): boolean {
  return b >= 60 && b > r * 1.2 && b > g * 1.12 && b - r >= 20 && b - g >= 10;
}

function largestBlueComponent(data: Uint8Array, width: number, height: number) {
  const pixelCount = width * height;
  const mask = new Uint8Array(pixelCount);

  for (let i = 0; i < pixelCount; i += 1) {
    const px = i * 4;
    const r = data[px];
    const g = data[px + 1];
    const b = data[px + 2];
    mask[i] = isBluePixel(r, g, b) ? 1 : 0;
  }

  const visited = new Uint8Array(pixelCount);
  const stack = new Int32Array(pixelCount);

  let bestArea = 0;
  let bestMinX = 0;
  let bestMinY = 0;
  let bestMaxX = 0;
  let bestMaxY = 0;

  for (let idx = 0; idx < pixelCount; idx += 1) {
    if (mask[idx] === 0 || visited[idx] === 1) {
      continue;
    }

    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    let head = 0;
    stack[head] = idx;
    head += 1;
    visited[idx] = 1;

    while (head > 0) {
      head -= 1;
      const current = stack[head];
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
          stack[head] = n;
          head += 1;
        }
      }
      if (x < width - 1) {
        const n = current + 1;
        if (mask[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          stack[head] = n;
          head += 1;
        }
      }
      if (y > 0) {
        const n = current - width;
        if (mask[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          stack[head] = n;
          head += 1;
        }
      }
      if (y < height - 1) {
        const n = current + width;
        if (mask[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          stack[head] = n;
          head += 1;
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

  if (bestArea <= 0) {
    return null;
  }

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function analyzeFrame(frameBase64: string): Perception {
  const decoded = decodeImage(frameBase64);
  const largest = largestBlueComponent(decoded.data, decoded.width, decoded.height);

  if (!largest) {
    return {
      found: false,
      bbox: null,
      area: 0,
      center_offset_x: 0,
      confidence: 0
    };
  }

  const centerX = largest.bbox.x + largest.bbox.w / 2;
  const frameCenterX = decoded.width / 2;
  const offset = centerX - frameCenterX;
  const normalizedArea = largest.area / (decoded.width * decoded.height);
  const confidence = clamp(normalizedArea * 10, 0, 0.99);

  return {
    found: true,
    bbox: largest.bbox,
    area: largest.area,
    center_offset_x: offset,
    confidence
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

function buildPlanAndState(previous: VisionState, perception: Perception) {
  const next: VisionState = {
    stage: previous.stage,
    scan_dir: previous.scan_dir,
    scan_ticks: previous.scan_ticks,
    capabilities: { ...previous.capabilities }
  };

  const caps = next.capabilities;
  const plan: PlanStep[] = [];
  let note = "";

  const searchSweep = () => {
    next.scan_ticks += 1;
    if (next.scan_ticks % 5 === 0) {
      next.scan_dir = next.scan_dir * -1;
    }
    plan.push(runStep(caps.base_target, caps.base_turn_token, [SEARCH_STEP_DEG * next.scan_dir], 220));
    plan.push(stopStep());
  };

  switch (next.stage) {
    case "SEARCH": {
      if (perception.found) {
        next.stage = "ALIGN";
        note = "target acquired, switching to ALIGN";
        plan.push(stopStep());
      } else {
        note = "no blue target found, scanning";
        searchSweep();
      }
      break;
    }

    case "ALIGN": {
      if (!perception.found) {
        next.stage = "SEARCH";
        note = "lost target, back to SEARCH";
        searchSweep();
        break;
      }

      const off = perception.center_offset_x;
      if (Math.abs(off) < ALIGN_PX) {
        next.stage = "APPROACH";
        note = "aligned, switching to APPROACH";
        plan.push(stopStep());
      } else {
        const turnDeg = clamp(off * 0.12, -18, 18);
        note = "centering target";
        plan.push(runStep(caps.base_target, caps.base_turn_token, [Number(turnDeg.toFixed(2))], 220));
        plan.push(stopStep());
      }
      break;
    }

    case "APPROACH": {
      if (!perception.found) {
        next.stage = "SEARCH";
        note = "target lost during approach";
        searchSweep();
        break;
      }

      if (perception.area > CLOSE_AREA_THRESHOLD) {
        next.stage = "FINAL_ALIGN";
        note = "target is close, switching to FINAL_ALIGN";
        plan.push(stopStep());
      } else {
        note = "advancing toward target";
        plan.push(runStep(caps.base_target, caps.base_fwd_token, [0.5], 300));
        plan.push(stopStep());
      }
      break;
    }

    case "FINAL_ALIGN": {
      if (!perception.found) {
        next.stage = "SEARCH";
        note = "target lost during final align";
        searchSweep();
        break;
      }

      note = "final correction before grab";
      if (Math.abs(perception.center_offset_x) > FINAL_ALIGN_PX) {
        const fineTurn = clamp(perception.center_offset_x * 0.08, -10, 10);
        plan.push(runStep(caps.base_target, caps.base_turn_token, [Number(fineTurn.toFixed(2))], 150));
      }
      plan.push(runStep(caps.base_target, caps.base_fwd_token, [0.35], 220));
      plan.push(stopStep());
      next.stage = "GRAB";
      break;
    }

    case "GRAB": {
      note = "closing gripper";
      plan.push(runStep(caps.arm_target, caps.arm_grip_token, ["close"]));
      plan.push(stopStep());
      next.stage = "DONE";
      break;
    }

    case "DONE":
    default: {
      note = "task complete";
      next.stage = "DONE";
      plan.push(stopStep());
      break;
    }
  }

  return {
    state: next,
    plan,
    debug: {
      stage: next.stage,
      note
    }
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
    const state = normalizeState(body.state);
    const perception = analyzeFrame(frameBase64);
    const output = buildPlanAndState(state, perception);

    return NextResponse.json(
      {
        state: output.state,
        perception,
        plan: output.plan,
        debug: output.debug
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
