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
    /search for\s+(.+?)(?:\s+and\s+|$)/,
    /pick up\s+(?:the\s+)?(.+?)$/,
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
  const canonical = ["phone", "banana", "cube", "box", "bottle", "backpack", "obstacle", "car", "rc car"];
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
  const targetQuery = extractTargetQuery(text);
  const target: TargetSpec = {
    query: targetQuery,
    color: extractColor(targetQuery),
    label: extractLabel(targetQuery)
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

  if (/pick up|grab/.test(text)) {
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
  if (objects.length === 0) return undefined;

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
    let score = obj.confidence;

    if (targetLabel && label === targetLabel) score += 3.2;
    if (targetLabel && label.includes(targetLabel)) score += 1.6;
    if (queryTokens.length > 0 && queryTokens.some((t) => label.includes(t))) score += 0.9;
    if (targetColor && (label.includes(targetColor) || attrs.some((a) => a.includes(targetColor)))) score += 0.8;

    if (targetLabel && label && label !== targetLabel) {
      score -= 0.9;
    }

    if (targetLabel && targetLabel !== "person" && isPersonLike(label)) {
      score -= 2.2;
    }

    if (lockCtx) {
      const lockLabel = canonicalLabel(lockCtx.label);
      if (label === lockLabel) {
        score += 1.4;
        const d = bboxCenterDistance(obj.bbox, lockCtx.bbox);
        score += Math.max(0, 0.8 - d * 1.5);
      }
    }

    return { obj, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 0.2) {
    return undefined;
  }

  return best.obj;
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
