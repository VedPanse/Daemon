import assert from "node:assert/strict";
import jpeg from "jpeg-js";
import { POST } from "../src/app/api/vision_step/route";
import { computeOpenAIFramePeriod, recommendIntervalMs } from "../src/lib/visionPerf";

type MockObject = {
  label: string;
  confidence: number;
  bbox: { x: number; y: number; w: number; h: number };
  attributes: string[];
};

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function run(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

function makeFrameBase64() {
  const width = 24;
  const height = 24;
  const data = Buffer.alloc(width * height * 4, 0);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4 + 3] = 255;
  }
  return jpeg.encode({ data, width, height }, 65).data.toString("base64");
}

function instructionHash(instruction: string) {
  const normalized = instruction.toLowerCase().replace(/\s+/g, " ").trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function installOpenAIMock(resolver: (instruction: string) => MockObject[]) {
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes("/v1/responses")) {
      return originalFetch(input as any, init);
    }
    const payload = JSON.parse(String(init?.body || "{}"));
    const instruction =
      payload?.input?.[1]?.content?.find((item: any) => item?.type === "input_text")?.text?.replace(/^Instruction:\s*/i, "") || "";
    const objects = resolver(instruction);
    return new Response(
      JSON.stringify({
        output_text: JSON.stringify({
          summary: "mock perception",
          objects
        })
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function postVision(frame: string, instruction: string, state: unknown, extras?: Record<string, unknown>) {
  const req = new Request("http://localhost/api/vision_step", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      frame_jpeg_base64: frame,
      instruction,
      state,
      ...extras
    })
  });
  const res = await POST(req);
  assert.equal(res.status, 200);
  return res.json();
}

run("contract: matching target class must produce selected_target", async () => {
  const restore = installOpenAIMock(() => [
    { label: "person", confidence: 0.94, bbox: { x: 0.38, y: 0.2, w: 0.2, h: 0.5 }, attributes: ["standing"] },
    { label: "pillar", confidence: 0.97, bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.7 }, attributes: [] }
  ]);
  try {
    const out = await postVision(makeFrameBase64(), "walk to a person and pick it up", {});
    assert.equal(out.debug?.parsed_instruction?.task_type, "pick-object");
    assert.equal(out.debug?.parsed_instruction?.target?.label, "person");
    assert.equal(out.perception?.found, true);
    assert.equal(out.perception?.selected_target?.label, "person");
    assert.notEqual(out.debug?.policy_branch, "PICK/SEARCH");
  } finally {
    restore();
  }
});

run("prompt switch: parsed target updates on immediate next frame", async () => {
  const restore = installOpenAIMock((instruction) => {
    if (instruction.includes("banana")) {
      return [{ label: "banana", confidence: 0.9, bbox: { x: 0.42, y: 0.3, w: 0.16, h: 0.16 }, attributes: [] }];
    }
    return [{ label: "person", confidence: 0.92, bbox: { x: 0.4, y: 0.16, w: 0.22, h: 0.62 }, attributes: [] }];
  });
  try {
    const frame = makeFrameBase64();
    const t = await postVision(frame, "pick up the banana", {});
    const t1 = await postVision(frame, "walk to a person and pick it up", t.state);
    assert.equal(t.debug?.parsed_instruction?.target?.label, "banana");
    assert.equal(t1.debug?.parsed_instruction?.target?.label, "person");
    assert.equal(t1.debug?.applied_instruction, "walk to a person and pick it up");
  } finally {
    restore();
  }
});

run("task validation fails when qualifier does not match selected target", async () => {
  const restore = installOpenAIMock(() => [
    { label: "box", confidence: 0.95, bbox: { x: 0.45, y: 0.28, w: 0.22, h: 0.22 }, attributes: ["red"] }
  ]);
  try {
    const instruction = "pick up the blue box";
    const state = {
      stage: "GRAB",
      scan_dir: 1,
      scan_ticks: 0,
      capabilities: {
        base_target: "base",
        arm_target: "arm",
        base_turn_token: "TURN",
        base_fwd_token: "FWD",
        arm_grip_token: "GRIP"
      },
      instruction_ctx: { hash: instructionHash(instruction) },
      motion_ctx: { consumed: false, step_idx: 0, total_steps: 0 },
      target_lock_ctx: null,
      verification_ctx: {
        status: "on_track",
        confidence: 0.8,
        on_track_streak: 2,
        off_track_streak: 0,
        last_motion_score: 0.02,
        last_offset_abs: 0.03,
        last_area: 0.05,
        last_signature: [0.1, 0.1, 0.1, 0.1, 0.1]
      },
      learning_ctx: {
        confidence_floor: 0.35,
        align_tolerance: 0.07,
        frames: 1,
        on_track_frames: 1,
        false_switches: 0,
        recovery_count: 0,
        avg_latency_ms: 100,
        last_selected_label: "box"
      },
      task_eval_ctx: {
        episode_index: 0,
        finalized: false,
        last_outcome: "pending",
        success_streak: 0,
        failure_streak: 0,
        target_label: "box",
        target_color: "blue",
        label_mismatch_count: 0,
        color_mismatch_count: 0
      },
      perf_ctx: {
        frame_index: 0,
        last_latency_ms: 100,
        recommended_interval_ms: 180,
        last_openai_frame: -1000,
        cached_perception: null,
        cached_source: "none"
      }
    };
    const out = await postVision(makeFrameBase64(), instruction, state);
    assert.equal(out.state?.stage, "DONE");
    assert.equal(out.debug?.task_validation?.outcome, "failure");
    assert.equal(out.debug?.task_validation?.checks?.target_label_ok, true);
    assert.equal(out.debug?.task_validation?.checks?.target_color_ok, false);
    assert.equal(out.state?.task_eval_ctx?.last_outcome, "failure");
  } finally {
    restore();
  }
});

run("performance behavior: stable lock tightens interval, off_track relaxes interval", () => {
  const onTrackStrong = recommendIntervalMs("on_track", 180, true);
  const onTrackWeak = recommendIntervalMs("on_track", 180, false);
  const offTrack = recommendIntervalMs("off_track", 180, false);
  assert.ok(onTrackStrong >= 80 && onTrackStrong <= 180);
  assert.ok(onTrackStrong < onTrackWeak);
  assert.ok(offTrack > onTrackWeak);

  assert.equal(computeOpenAIFramePeriod("on_track", true), 3);
  assert.equal(computeOpenAIFramePeriod("uncertain", true), 1);
  assert.equal(computeOpenAIFramePeriod("off_track", false), 1);
});

run("manifest-aware canonical MOVE left maps to STRAFE", async () => {
  const manifest = {
    nodes: [
      {
        name: "base",
        commands: [{ token: "STRAFE" }, { token: "FWD" }, { token: "TURN" }, { token: "STOP" }]
      }
    ]
  };
  const out = await postVision(makeFrameBase64(), "strafe left", {}, { system_manifest: manifest });
  const run = (Array.isArray(out.plan) ? out.plan : []).find((step: any) => step?.type === "RUN");
  assert.equal(run?.token, "STRAFE");
  assert.equal(run?.args?.[0], "L");
  assert.equal(out?.debug?.manifest_guard?.dropped_steps, 0);
});

run("arm-control instruction emits GRIP open then hold", async () => {
  const out = await postVision(makeFrameBase64(), "open the claw for 5 seconds then close it", {});
  const runs = (Array.isArray(out.plan) ? out.plan : []).filter((step: any) => step?.type === "RUN");
  assert.equal(runs.length >= 1, true);
  assert.equal(runs[0]?.token, "GRIP");
  assert.equal(runs[0]?.args?.[0], "open");
  assert.equal(runs[0]?.duration_ms, 5000);
});

async function main() {
  for (const test of tests) {
    try {
      await test.fn();
      console.log(`PASS ${test.name}`);
    } catch (error) {
      console.error(`FAIL ${test.name}`);
      throw error;
    }
  }
  console.log("All vision_step tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
