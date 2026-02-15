export type CriticFailureMode =
  | "not_visible"
  | "target_not_visible"
  | "wrong_object"
  | "no_progress"
  | "regressing"
  | "collision_risk"
  | "edge_of_view"
  | "uncertain";

export type CriticToolOutput = {
  describe: string;
  evaluate: string;
  reward: number; // [-1, 1]
  success: boolean;
  success_confidence: number; // [0, 1]
  critical_failure: boolean;
  critical_failure_reason: string;
  failure_modes: CriticFailureMode[];
  // Optional: if you want the critic to point at robot/target for debugging/overlays.
  robot_bbox?: { x: number; y: number; w: number; h: number } | null; // normalized [0..1]
  target_bbox?: { x: number; y: number; w: number; h: number } | null; // normalized [0..1]
  notes_short: string;
};

// Function tool schema for Realtime tool calling.
// Uses JSON Schema-ish shape as supported by Realtime `tools[].parameters`.
export const CRITIC_TOOL_SCHEMA = {
  type: "function",
  name: "critic_reward",
  description:
    "Return structured reward + safety evaluation for the robot's current camera frame, relative to the given task goal. " +
    "If uncertain, fail closed (success=false, low confidence, conservative reward).",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      describe: { type: "string" },
      evaluate: { type: "string" },
      reward: { type: "number", minimum: -1.0, maximum: 1.0 },
      success: { type: "boolean" },
      success_confidence: { type: "number", minimum: 0.0, maximum: 1.0 },
      critical_failure: { type: "boolean" },
      critical_failure_reason: { type: "string" },
      failure_modes: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "not_visible",
            "target_not_visible",
            "wrong_object",
            "no_progress",
            "regressing",
            "collision_risk",
            "edge_of_view",
            "uncertain"
          ]
        }
      },
      robot_bbox: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              x: { type: "number", minimum: 0.0, maximum: 1.0 },
              y: { type: "number", minimum: 0.0, maximum: 1.0 },
              w: { type: "number", minimum: 0.0, maximum: 1.0 },
              h: { type: "number", minimum: 0.0, maximum: 1.0 }
            },
            required: ["x", "y", "w", "h"]
          }
        ]
      },
      target_bbox: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              x: { type: "number", minimum: 0.0, maximum: 1.0 },
              y: { type: "number", minimum: 0.0, maximum: 1.0 },
              w: { type: "number", minimum: 0.0, maximum: 1.0 },
              h: { type: "number", minimum: 0.0, maximum: 1.0 }
            },
            required: ["x", "y", "w", "h"]
          }
        ]
      },
      notes_short: { type: "string" }
    },
    required: [
      "describe",
      "evaluate",
      "reward",
      "success",
      "success_confidence",
      "critical_failure",
      "critical_failure_reason",
      "failure_modes",
      "notes_short"
    ]
  }
} as const;

// System prompt intended for Realtime `session.update.session.instructions` or per-response `response.instructions`.
//
// Note: avoid requiring "chain-of-thought" output. The tool call itself is the structured output we need.
export function buildCriticSystemPrompt(params: {
  task: string;
  safetyNotes?: string;
  successDefinition?: string;
}): string {
  const safety = (params.safetyNotes || "").trim();
  const successDef = (params.successDefinition || "").trim();
  const task = params.task.trim();

  return [
    "You are a Vision-Language Reward Critic for a physical RC robot.",
    "Your job: evaluate the current camera frame against the user's task goal, and produce a reward signal for RL.",
    "",
    "Output requirements:",
    "- You MUST call the function tool `critic_reward` exactly once.",
    "- Do not output free-form text.",
    "- Be conservative: if uncertain, set success=false and success_confidence<=0.5.",
    "- Never claim success unless the goal is visually confirmed in the frame.",
    "",
    "Reward rules:",
    "- reward in [-1.0, 1.0].",
    "- +1.0 only when the task is clearly completed.",
    "- 0.0 when no clear progress or unclear.",
    "- negative when the robot regresses, is interacting with the wrong object, or is unsafe.",
    "",
    "Safety rules:",
    "- If there is imminent collision risk, falling risk, or the robot is about to leave the camera view, set critical_failure=true.",
    "- If the robot or target is not visible enough to judge, include failure_modes with not_visible/target_not_visible and keep reward near 0 or negative if clearly wrong.",
    "",
    `TASK: ${task}`,
    successDef ? `SUCCESS DEFINITION: ${successDef}` : "",
    safety ? `SAFETY NOTES: ${safety}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

