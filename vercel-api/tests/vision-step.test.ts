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

async function postVision(frame: string, instruction: string, state: unknown) {
  const req = new Request("http://localhost/api/vision_step", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      frame_jpeg_base64: frame,
      instruction,
      state
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
