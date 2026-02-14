import assert from "node:assert/strict";
import {
  canonicalLabel,
  parseInstruction,
  selectTargetDeterministic,
  shouldBypassPerceptionTask,
  updateTargetLockCtx,
  type ParsedInstruction,
  type PerceivedObject
} from "../src/lib/visionPolicy";

function obj(label: string, confidence: number, x: number, y: number, w = 0.2, h = 0.2): PerceivedObject {
  return {
    label,
    confidence,
    bbox: { x, y, w, h },
    attributes: []
  };
}

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("parseInstruction move-pattern circle 3", () => {
  const parsed = parseInstruction("drive in a circle 3 times");
  assert.equal(parsed.task_type, "move-pattern");
  assert.equal(parsed.pattern, "circle");
  assert.equal(parsed.count, 3);
});

run("parseInstruction pick-object phone", () => {
  const parsed = parseInstruction("pick up the phone");
  assert.equal(parsed.task_type, "pick-object");
  assert.equal(parsed.target.label, "phone");
});

run("canonicalLabel phone aliases", () => {
  assert.equal(canonicalLabel("SmartPhone"), "phone");
  assert.equal(canonicalLabel("cell phone"), "phone");
  assert.equal(canonicalLabel("iphone"), "phone");
});

run("selectTargetDeterministic prefers banana over person distractor", () => {
  const parsed: ParsedInstruction = parseInstruction("pick up the banana");
  const selected = selectTargetDeterministic([
    obj("person", 0.95, 0.3, 0.3),
    obj("banana", 0.62, 0.4, 0.4)
  ], parsed, null);

  assert.ok(selected);
  assert.equal(canonicalLabel(String(selected?.label)), "banana");
});

run("selectTargetDeterministic prefers phone alias over person distractor", () => {
  const parsed: ParsedInstruction = parseInstruction("pick up the phone");
  const selected = selectTargetDeterministic([
    obj("person", 0.96, 0.25, 0.3),
    obj("smartphone", 0.58, 0.5, 0.5)
  ], parsed, null);

  assert.ok(selected);
  assert.equal(canonicalLabel(String(selected?.label)), "phone");
});

run("target lock persists on same class across frames", () => {
  const parsed: ParsedInstruction = parseInstruction("pick up the phone");
  const first = selectTargetDeterministic([obj("smartphone", 0.55, 0.45, 0.45)], parsed, null);
  assert.ok(first);

  const lock = updateTargetLockCtx(null, first);
  assert.ok(lock);

  const second = selectTargetDeterministic([
    obj("person", 0.98, 0.45, 0.45),
    obj("mobile phone", 0.52, 0.48, 0.47)
  ], parsed, lock);

  assert.ok(second);
  assert.equal(canonicalLabel(String(second?.label)), "phone");
});

run("lock expires after lost ticks", () => {
  const initial = updateTargetLockCtx(null, obj("banana", 0.6, 0.4, 0.3));
  assert.ok(initial);

  const l1 = updateTargetLockCtx(initial, undefined, 2);
  assert.ok(l1 && l1.lost_ticks === 1);

  const l2 = updateTargetLockCtx(l1, undefined, 2);
  assert.ok(l2 && l2.lost_ticks === 2);

  const l3 = updateTargetLockCtx(l2, undefined, 2);
  assert.equal(l3, null);
});

run("move-pattern bypasses perception", () => {
  assert.equal(shouldBypassPerceptionTask("move-pattern"), true);
  assert.equal(shouldBypassPerceptionTask("stop"), true);
  assert.equal(shouldBypassPerceptionTask("pick-object"), false);
  assert.equal(shouldBypassPerceptionTask("follow"), false);
});

console.log("All vision policy tests passed.");
