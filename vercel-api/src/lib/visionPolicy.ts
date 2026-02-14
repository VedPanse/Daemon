export type TaskType = "stop" | "move-pattern" | "pick-object" | "follow" | "search" | "avoid+approach" | "unknown";

export type MotionPattern = "circle" | "square" | "triangle" | "forward";

export interface TargetSpec {
  query: string | null;
  label: string | null;
  color: "red" | "blue" | "green" | "yellow" | null;
}

export interface ParsedInstruction {
  task_type: TaskType;
  stop_kind?: "normal" | "emergency";
  target: TargetSpec;
  pattern?: MotionPattern;
  count?: number;
  distance_m?: number;
}

export interface PerceivedObject {
  label: string;
  bbox: { x: number; y: number; w: number; h: number };
  confidence: number;
  attributes?: string[];
}

export interface TargetLockCtx {
  label: string;
  bbox: { x: number; y: number; w: number; h: number };
  lost_ticks: number;
}

const PERSON_ALIASES = ["person", "human", "man", "woman", "people"];
const PERSON_CANONICAL = "person";

export interface TargetScoreTrace {
  label: string;
  canonical_label: string;
  confidence: number;
  total_score: number;
  components: {
    confidence: number;
    exact_label: number;
    partial_label: number;
    query_token: number;
    color: number;
    mismatch_penalty: number;
    person_distractor_penalty: number;
    lock_label: number;
    lock_distance: number;
  };
}

export interface TargetSelectionResult {
  selected?: PerceivedObject;
  target_required: boolean;
  decision_reason: string;
  scored: TargetScoreTrace[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseCount(text: string): number {
  const digit = text.match(/\b(\d+)\b/);
  if (digit) {
    return clamp(Number(digit[1]), 1, 10);
  }

  if (text.includes("once")) return 1;
  if (text.includes("twice")) return 2;
  if (text.includes("thrice")) return 3;

  const wordMap: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10
  };

  for (const [word, value] of Object.entries(wordMap)) {
    if (text.includes(word)) {
      return value;
    }
  }

  return 1;
}

function parseDistanceMeters(text: string): number | undefined {
  const match = text.match(/\b(\d+(?:\.\d+)?)\s*(meter|meters|m)\b/);
  if (!match) {
    return undefined;
  }
  return clamp(Number(match[1]), 0.1, 10);
}

function cleanTargetPhrase(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/\b(and\s+grab\s+it|and\s+pick\s+it\s+up|please|now)\b/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function extractTargetQuery(text: string): string | null {
  const patterns = [
    /(?:walk|go|move|head|approach)\s+(?:to|toward|towards)\s+(?:the\s+|a\s+|an\s+)?(.+?)(?:\s+and\s+(?:pick(?:\s+\w+)?\s+up|grab)\b|$)/,
    /search for\s+(.+?)(?:\s+and\s+|$)/,
    /pick(?:\s+\w+)?\s+up\s+(?:the\s+)?(.+?)$/,
    /grab\s+(?:the\s+)?(.+?)$/,
    /follow\s+(?:the\s+)?(.+?)$/,
    /approach\s+(?:the\s+)?(.+?)$/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return cleanTargetPhrase(match[1]);
    }
  }

  return null;
}

function extractColor(query: string | null): TargetSpec["color"] {
  if (!query) return null;
  if (query.includes("red")) return "red";
  if (query.includes("blue")) return "blue";
  if (query.includes("green")) return "green";
  if (query.includes("yellow")) return "yellow";
  return null;
}

function extractLabel(query: string | null): string | null {
  if (!query) return null;

  const stopWords = new Set(["the", "a", "an", "red", "blue", "green", "yellow", "object", "it"]);
  const tokens = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !stopWords.has(t));

  if (tokens.length === 0) return null;

  const joined = tokens.join(" ");
  const canonical = ["person", "phone", "banana", "cube", "box", "bottle", "backpack", "obstacle", "car", "rc car"];
  for (const item of canonical) {
    if (joined.includes(item)) {
      return item;
    }
  }

  return tokens[tokens.length - 1];
}

export function canonicalLabel(raw: string): string {
  const label = raw.toLowerCase().trim();
  const aliases: Array<{ canonical: string; terms: string[] }> = [
    { canonical: "person", terms: ["person", "human", "man", "woman", "someone", "people"] },
    { canonical: "phone", terms: ["phone", "cell phone", "mobile phone", "smartphone", "iphone", "android phone"] },
    { canonical: "bottle", terms: ["bottle", "water bottle"] },
    { canonical: "backpack", terms: ["backpack", "bag", "rucksack"] },
    { canonical: "cube", terms: ["cube", "block"] },
    { canonical: "box", terms: ["box", "package"] },
    { canonical: "rc car", terms: ["rc car", "toy car", "remote car"] }
  ];

  for (const group of aliases) {
    if (group.terms.some((term) => label === term || label.includes(term))) {
      return group.canonical;
    }
  }

  return label;
}

export function parseInstruction(instruction: string): ParsedInstruction {
  const text = instruction.toLowerCase().replace(/\s+/g, " ").trim();
  let targetQuery = extractTargetQuery(text);
  if (!targetQuery && /\b(?:person|human|man|woman|someone|people)\b/.test(text)) {
    targetQuery = PERSON_CANONICAL;
  }
  const target: TargetSpec = {
    query: targetQuery,
    color: extractColor(targetQuery),
    label: targetQuery ? canonicalLabel(extractLabel(targetQuery) || targetQuery) : null
  };

  if (/(emergency stop|e-stop|estop|abort|halt|\bstop\b)/.test(text)) {
    return {
      task_type: "stop",
      stop_kind: /(emergency stop|e-stop|estop|abort)/.test(text) ? "emergency" : "normal",
      target
    };
  }

  if (/circle|square|triangle|move forward|go forward/.test(text)) {
    if (/circle/.test(text)) {
      return { task_type: "move-pattern", pattern: "circle", count: parseCount(text), target };
    }
    if (/square/.test(text)) {
      return { task_type: "move-pattern", pattern: "square", count: parseCount(text), target };
    }
    if (/triangle/.test(text)) {
      return { task_type: "move-pattern", pattern: "triangle", count: parseCount(text), target };
    }
    return {
      task_type: "move-pattern",
      pattern: "forward",
      distance_m: parseDistanceMeters(text) ?? 1,
      count: 1,
      target
    };
  }

  if (/follow\s+/.test(text)) {
    return { task_type: "follow", target };
  }

  if (/search for\s+/.test(text)) {
    return { task_type: "search", target };
  }

  if (/avoid/.test(text) && /approach/.test(text)) {
    return { task_type: "avoid+approach", target };
  }

  if (/pick(?:\s+\w+)?\s+up|grab/.test(text)) {
    return { task_type: "pick-object", target };
  }

  return { task_type: "unknown", target };
}

function isPersonLike(label: string): boolean {
  return PERSON_ALIASES.some((term) => label === term || label.includes(term));
}

function bboxCenterDistance(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): number {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

export function shouldBypassPerceptionTask(taskType: TaskType): boolean {
  return taskType === "stop" || taskType === "move-pattern";
}

export function selectTargetDeterministic(
  objects: PerceivedObject[],
  parsed: ParsedInstruction,
  lockCtx?: TargetLockCtx | null
): PerceivedObject | undefined {
  return selectTargetWithTraceDeterministic(objects, parsed, lockCtx).selected;
}

export function selectTargetWithTraceDeterministic(
  objects: PerceivedObject[],
  parsed: ParsedInstruction,
  lockCtx?: TargetLockCtx | null
): TargetSelectionResult {
  if (objects.length === 0) {
    return {
      selected: undefined,
      target_required: false,
      decision_reason: "no_objects",
      scored: []
    };
  }

  const targetLabel = parsed.target.label ? canonicalLabel(parsed.target.label) : "";
  const targetColor = parsed.target.color || null;
  const queryTokens = (parsed.target.query || "")
    .toLowerCase()
    .split(/\s+/)
    .map((t) => canonicalLabel(t))
    .filter(Boolean);

  const scored = objects.map((obj) => {
    const label = canonicalLabel(obj.label);
    const attrs = (obj.attributes || []).map((v) => v.toLowerCase());
    const exactLabel = targetLabel && label === targetLabel ? 3.2 : 0;
    const partialLabel = targetLabel && label.includes(targetLabel) ? 1.6 : 0;
    const queryMatch = queryTokens.length > 0 && queryTokens.some((t) => label.includes(t)) ? 0.9 : 0;
    const colorMatch = targetColor && (label.includes(targetColor) || attrs.some((a) => a.includes(targetColor))) ? 0.8 : 0;
    const mismatchPenalty = targetLabel && label && label !== targetLabel ? -0.9 : 0;
    const personDistractorPenalty = targetLabel && targetLabel !== PERSON_CANONICAL && isPersonLike(label) ? -2.2 : 0;
    let lockLabelBonus = 0;
    let lockDistanceBonus = 0;

    if (lockCtx) {
      const lockLabel = canonicalLabel(lockCtx.label);
      if (label === lockLabel) {
        lockLabelBonus = 1.4;
        const d = bboxCenterDistance(obj.bbox, lockCtx.bbox);
        lockDistanceBonus = Math.max(0, 0.8 - d * 1.5);
      }
    }

    const score =
      obj.confidence +
      exactLabel +
      partialLabel +
      queryMatch +
      colorMatch +
      mismatchPenalty +
      personDistractorPenalty +
      lockLabelBonus +
      lockDistanceBonus;

    return {
      obj,
      trace: {
        label: obj.label,
        canonical_label: label,
        confidence: obj.confidence,
        total_score: Number(score.toFixed(4)),
        components: {
          confidence: Number(obj.confidence.toFixed(4)),
          exact_label: Number(exactLabel.toFixed(4)),
          partial_label: Number(partialLabel.toFixed(4)),
          query_token: Number(queryMatch.toFixed(4)),
          color: Number(colorMatch.toFixed(4)),
          mismatch_penalty: Number(mismatchPenalty.toFixed(4)),
          person_distractor_penalty: Number(personDistractorPenalty.toFixed(4)),
          lock_label: Number(lockLabelBonus.toFixed(4)),
          lock_distance: Number(lockDistanceBonus.toFixed(4))
        }
      }
    };
  });

  const targetRequired =
    (parsed.task_type === "pick-object" ||
      parsed.task_type === "follow" ||
      parsed.task_type === "search" ||
      parsed.task_type === "avoid+approach") &&
    Boolean(targetLabel || queryTokens.length > 0 || targetColor);

  const matchesTarget = (candidate: PerceivedObject): boolean => {
    const label = canonicalLabel(candidate.label);
    const attrs = (candidate.attributes || []).map((v) => v.toLowerCase());
    const labelMatch = Boolean(targetLabel && (label === targetLabel || label.includes(targetLabel)));
    const queryMatch = queryTokens.length > 0 && queryTokens.some((token) => label.includes(token));
    const colorMatch = Boolean(targetColor && (label.includes(targetColor) || attrs.some((a) => a.includes(targetColor))));
    return labelMatch || queryMatch || colorMatch;
  };

  if (targetRequired) {
    const filtered = scored.filter(({ obj }) => matchesTarget(obj));
    if (filtered.length > 0) {
      filtered.sort((a, b) => b.trace.total_score - a.trace.total_score);
      const bestFiltered = filtered[0];
      if (bestFiltered.trace.total_score >= 0.2) {
        return {
          selected: bestFiltered.obj,
          target_required: targetRequired,
          decision_reason: "target_match_found",
          scored: scored.sort((a, b) => b.trace.total_score - a.trace.total_score).map((entry) => entry.trace)
        };
      }
    }
    return {
      selected: undefined,
      target_required: targetRequired,
      decision_reason: "target_required_but_no_scored_match",
      scored: scored.sort((a, b) => b.trace.total_score - a.trace.total_score).map((entry) => entry.trace)
    };
  }

  scored.sort((a, b) => b.trace.total_score - a.trace.total_score);
  const best = scored[0];
  if (!best || best.trace.total_score < 0.2) {
    return {
      selected: undefined,
      target_required: targetRequired,
      decision_reason: "best_score_below_threshold",
      scored: scored.map((entry) => entry.trace)
    };
  }

  return {
    selected: best.obj,
    target_required: targetRequired,
    decision_reason: "best_candidate_selected",
    scored: scored.map((entry) => entry.trace)
  };
}

export function updateTargetLockCtx(
  previous: TargetLockCtx | null | undefined,
  selected: PerceivedObject | undefined,
  maxLostTicks = 3
): TargetLockCtx | null {
  if (selected) {
    return {
      label: canonicalLabel(selected.label),
      bbox: selected.bbox,
      lost_ticks: 0
    };
  }

  if (!previous) {
    return null;
  }

  const nextLost = previous.lost_ticks + 1;
  if (nextLost > maxLostTicks) {
    return null;
  }

  return {
    ...previous,
    lost_ticks: nextLost
  };
}
