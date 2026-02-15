import assert from "node:assert/strict";
import {
  canonicalLabel,
  parseInstruction,
  selectTargetDeterministic,
  selectTargetWithTraceDeterministic,
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

run("parseInstruction canonical MOVE backward", () => {
  const parsed = parseInstruction("move backward 1 meter");
  assert.equal(parsed.task_type, "move-pattern");
  assert.equal(parsed.canonical_actions?.[0]?.type, "MOVE");
  assert.equal((parsed.canonical_actions?.[0] as any)?.direction, "backward");
});

run("parseInstruction canonical MOVE strafe synonyms", () => {
  const parsed = parseInstruction("slide right 2 meters");
  assert.equal(parsed.task_type, "move-pattern");
  assert.equal(parsed.canonical_actions?.[0]?.type, "MOVE");
  assert.equal((parsed.canonical_actions?.[0] as any)?.direction, "right");
});

run("parseInstruction multi-step move forward then move back", () => {
  const parsed = parseInstruction("move forward then move back");
  assert.equal(parsed.task_type, "move-pattern");
  assert.equal(parsed.canonical_actions?.length, 2);
  assert.equal(parsed.canonical_actions?.[0]?.type, "MOVE");
  assert.equal((parsed.canonical_actions?.[0] as any)?.direction, "forward");
  assert.equal(parsed.canonical_actions?.[1]?.type, "MOVE");
  assert.equal((parsed.canonical_actions?.[1] as any)?.direction, "backward");
});

run("parseInstruction behind synonym maps to MOVE backward", () => {
  const parsed = parseInstruction("go behind");
  assert.equal(parsed.task_type, "move-pattern");
  assert.equal(parsed.canonical_actions?.[0]?.type, "MOVE");
  assert.equal((parsed.canonical_actions?.[0] as any)?.direction, "backward");
});

run("parseInstruction move-if-clear red object gate", () => {
  const parsed = parseInstruction("go forward if there is no red object ahead of it");
  assert.equal(parsed.task_type, "move-if-clear");
  assert.equal(parsed.target.color, "red");
});

run("parseInstruction pick-object phone", () => {
  const parsed = parseInstruction("pick up the phone");
  assert.equal(parsed.task_type, "pick-object");
  assert.equal(parsed.target.label, "phone");
});

run("parseInstruction person pick phrase", () => {
  const parsed = parseInstruction("walk to a person and pick it up");
  assert.equal(parsed.task_type, "pick-object");
  assert.equal(parsed.target.label, "person");
});

run("parseInstruction keeps generic qualifier token", () => {
  const parsed = parseInstruction("pick up the cyan box");
  assert.equal(parsed.task_type, "pick-object");
  assert.equal(parsed.target.label, "box");
  assert.equal(parsed.target.color, "cyan");
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

run("selectTargetDeterministic selects person when person is target", () => {
  const parsed: ParsedInstruction = parseInstruction("walk to a person and pick it up");
  const selected = selectTargetDeterministic([
    obj("person", 0.61, 0.44, 0.2),
    obj("pillar", 0.97, 0.4, 0.2)
  ], parsed, null);

  assert.ok(selected);
  assert.equal(canonicalLabel(String(selected?.label)), "person");
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
  assert.equal(shouldBypassPerceptionTask("move-if-clear"), false);
});

run("selection trace marks required target when absent", () => {
  const parsed = parseInstruction("pick up the banana");
  const result = selectTargetWithTraceDeterministic([obj("person", 0.9, 0.3, 0.3)], parsed, null);
  assert.equal(result.target_required, true);
  assert.equal(result.selected, undefined);
  assert.equal(result.decision_reason, "target_required_but_no_scored_match");
});

console.log("All vision policy tests passed.");
