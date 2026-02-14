import { NextResponse } from "next/server";
import { createPlan, PlannerError } from "@/lib/planner";
import type { PlanRequest } from "@/lib/types";
import { ValidationError } from "@/lib/validate";

interface BadRequestResponse {
  error: "BAD_REQUEST";
  message: string;
  details?: unknown;
}

function badRequest(message: string, details?: unknown): NextResponse<BadRequestResponse> {
  return NextResponse.json(
    {
      error: "BAD_REQUEST",
      message,
      ...(details !== undefined ? { details } : {})
    },
    { status: 400 }
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(body: unknown): PlanRequest {
  if (!isObject(body)) {
    throw new ValidationError("Request body must be a JSON object.");
  }

  const instruction = body.instruction;
  const system_manifest = body.system_manifest;
  const telemetry_snapshot = body.telemetry_snapshot;

  if (typeof instruction !== "string" || !instruction.trim()) {
    throw new ValidationError("instruction must be a non-empty string.", { instruction });
  }

  if (!isObject(system_manifest)) {
    throw new ValidationError("system_manifest must be an object.");
  }

  if (typeof system_manifest.daemon_version !== "string" || !system_manifest.daemon_version.trim()) {
    throw new ValidationError("system_manifest.daemon_version must be a non-empty string.");
  }

  if (!Array.isArray(system_manifest.nodes)) {
    throw new ValidationError("system_manifest.nodes must be an array.");
  }

  if (!isObject(telemetry_snapshot)) {
    throw new ValidationError("telemetry_snapshot must be an object.");
  }

  const typedNodes: PlanRequest["system_manifest"]["nodes"] = system_manifest.nodes.map((node, index) => {
    if (!isObject(node)) {
      throw new ValidationError("Each system_manifest node must be an object.", { index, node });
    }

    if (typeof node.name !== "string" || !node.name.trim()) {
      throw new ValidationError("Each node.name must be a non-empty string.", { index, node });
    }

    if (typeof node.node_id !== "string" || !node.node_id.trim()) {
      throw new ValidationError("Each node.node_id must be a non-empty string.", { index, node });
    }

    if (!Array.isArray(node.commands)) {
      throw new ValidationError("Each node.commands must be an array.", { index, node });
    }

    if (node.telemetry !== undefined && !isObject(node.telemetry)) {
      throw new ValidationError("node.telemetry must be an object when provided.", { index, node });
    }

    return {
      name: node.name,
      node_id: node.node_id,
      commands: node.commands,
      ...(node.telemetry !== undefined ? { telemetry: node.telemetry } : {})
    };
  });

  return {
    instruction,
    system_manifest: {
      daemon_version: system_manifest.daemon_version,
      nodes: typedNodes
    },
    telemetry_snapshot
  };
}

export async function handlePlanRequest(request: Request): Promise<NextResponse> {
  let body: unknown;

  try {
    body = await request.json();
  } catch (error) {
    return badRequest("Invalid JSON body.", { cause: (error as Error).message });
  }

  try {
    const parsed = parseBody(body);
    const response = createPlan(parsed.instruction, parsed.system_manifest);
    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    if (error instanceof ValidationError || error instanceof PlannerError) {
      return NextResponse.json(
        {
          error: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {})
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        error: "INTERNAL_ERROR",
        message: "Unexpected planner failure."
      },
      { status: 500 }
    );
  }
}
