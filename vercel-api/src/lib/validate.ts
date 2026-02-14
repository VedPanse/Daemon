import type {
  CommandCatalog,
  NormalizedArgSpec,
  NormalizedCommandSpec,
  PlanStep,
  PrimitiveArgType,
  SystemManifest
} from "@/lib/types";

const TOKEN_KEYS = ["token", "name", "command", "id", "op"] as const;
const ARG_KEYS = ["args", "params", "parameters", "arguments"] as const;

export class ValidationError extends Error {
  readonly code = "VALIDATION_ERROR";
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.details = details;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeType(value: string): PrimitiveArgType | undefined {
  const lowered = value.toLowerCase();

  if (lowered === "number" || lowered === "float" || lowered === "double" || lowered === "int" || lowered === "integer") {
    return "number";
  }

  if (lowered === "string") {
    return "string";
  }

  if (lowered === "boolean" || lowered === "bool") {
    return "boolean";
  }

  return undefined;
}

function normalizeArgSpec(rawArg: unknown, context: { node: string; token: string; index: number }): NormalizedArgSpec {
  if (typeof rawArg === "string") {
    const normalized = normalizeType(rawArg);

    if (!normalized) {
      throw new ValidationError("Unknown argument type in manifest command definition.", {
        node: context.node,
        token: context.token,
        arg_index: context.index,
        arg_spec: rawArg
      });
    }

    return { type: normalized };
  }

  if (!isObject(rawArg)) {
    throw new ValidationError("Invalid argument spec in manifest command definition.", {
      node: context.node,
      token: context.token,
      arg_index: context.index,
      arg_spec: rawArg
    });
  }

  const rawType = typeof rawArg.type === "string" ? rawArg.type : undefined;
  const enumValues = Array.isArray(rawArg.enum) ? rawArg.enum : undefined;
  const min = typeof rawArg.min === "number" ? rawArg.min : typeof rawArg.minimum === "number" ? rawArg.minimum : undefined;
  const max = typeof rawArg.max === "number" ? rawArg.max : typeof rawArg.maximum === "number" ? rawArg.maximum : undefined;

  const inferredType = rawType
    ? normalizeType(rawType)
    : min !== undefined || max !== undefined
      ? "number"
      : enumValues?.length
        ? typeof enumValues[0] === "boolean"
          ? "boolean"
          : typeof enumValues[0] === "number"
            ? "number"
            : "string"
        : undefined;

  if (!inferredType) {
    throw new ValidationError("Unable to infer argument type in manifest command definition.", {
      node: context.node,
      token: context.token,
      arg_index: context.index,
      arg_spec: rawArg
    });
  }

  return {
    type: inferredType,
    min,
    max,
    optional: rawArg.required === false || rawArg.optional === true,
    enum: enumValues
  };
}

function parseCommand(rawCommand: unknown, nodeName: string): NormalizedCommandSpec {
  if (typeof rawCommand === "string") {
    return { token: rawCommand, args: [] };
  }

  if (!isObject(rawCommand)) {
    throw new ValidationError("Invalid command entry in manifest node.commands.", {
      node: nodeName,
      command: rawCommand
    });
  }

  const tokenKey = TOKEN_KEYS.find((key) => typeof rawCommand[key] === "string");
  const token = tokenKey ? (rawCommand[tokenKey] as string) : undefined;

  if (!token) {
    throw new ValidationError("Command definition missing token-like field.", {
      node: nodeName,
      command: rawCommand
    });
  }

  const argKey = ARG_KEYS.find((key) => key in rawCommand);
  const rawArgs = argKey ? rawCommand[argKey] : undefined;

  if (rawArgs === undefined) {
    return { token, args: [] };
  }

  if (!Array.isArray(rawArgs)) {
    throw new ValidationError("Command args/params must be an array.", {
      node: nodeName,
      token,
      arg_spec: rawArgs
    });
  }

  const args = rawArgs.map((arg, index) => normalizeArgSpec(arg, { node: nodeName, token, index }));
  return { token, args };
}

export function buildCommandCatalog(manifest: SystemManifest): CommandCatalog {
  if (!manifest || !Array.isArray(manifest.nodes)) {
    throw new ValidationError("system_manifest.nodes must be an array.");
  }

  const catalog: CommandCatalog = new Map();

  for (const node of manifest.nodes) {
    if (!node || typeof node.name !== "string" || !node.name.trim()) {
      throw new ValidationError("Each node must include a non-empty string name.", { node });
    }

    if (!Array.isArray(node.commands)) {
      throw new ValidationError("Each node must include commands[] in system_manifest.", { node: node.name });
    }

    const commandMap = new Map<string, NormalizedCommandSpec>();
    for (const rawCommand of node.commands) {
      const parsed = parseCommand(rawCommand, node.name);

      if (commandMap.has(parsed.token)) {
        throw new ValidationError("Duplicate token found in node command catalog.", {
          node: node.name,
          token: parsed.token
        });
      }

      commandMap.set(parsed.token, parsed);
    }

    catalog.set(node.name, commandMap);
  }

  return catalog;
}

export function getSupportingNodes(catalog: CommandCatalog, token: string): string[] {
  const matches: string[] = [];

  for (const [nodeName, commands] of catalog.entries()) {
    if (commands.has(token)) {
      matches.push(nodeName);
    }
  }

  return matches;
}

function validateArgType(value: unknown, spec: NormalizedArgSpec): boolean {
  if (spec.type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }

  if (spec.type === "string") {
    return typeof value === "string";
  }

  if (spec.type === "boolean") {
    return typeof value === "boolean";
  }

  return false;
}

function validateArgs(args: unknown[], specs: NormalizedArgSpec[], stepIndex: number, token: string, target: string): void {
  if (specs.length === 0) {
    if (args.length > 0) {
      throw new ValidationError("RUN step provided args, but token takes no args.", {
        step_index: stepIndex,
        token,
        target,
        args
      });
    }
    return;
  }

  const requiredCount = specs.filter((spec) => !spec.optional).length;
  if (args.length < requiredCount) {
    throw new ValidationError("RUN step has fewer args than required by token schema.", {
      step_index: stepIndex,
      token,
      target,
      expected_at_least: requiredCount,
      actual: args.length
    });
  }

  if (args.length > specs.length) {
    throw new ValidationError("RUN step has more args than allowed by token schema.", {
      step_index: stepIndex,
      token,
      target,
      expected_at_most: specs.length,
      actual: args.length
    });
  }

  args.forEach((value, argIndex) => {
    const spec = specs[argIndex];

    if (!validateArgType(value, spec)) {
      throw new ValidationError("RUN step arg type does not match command schema.", {
        step_index: stepIndex,
        token,
        target,
        arg_index: argIndex,
        expected_type: spec.type,
        actual_type: typeof value,
        value
      });
    }

    if (spec.type === "number") {
      if (spec.min !== undefined && (value as number) < spec.min) {
        throw new ValidationError("RUN step arg is below command min.", {
          step_index: stepIndex,
          token,
          target,
          arg_index: argIndex,
          min: spec.min,
          value
        });
      }

      if (spec.max !== undefined && (value as number) > spec.max) {
        throw new ValidationError("RUN step arg is above command max.", {
          step_index: stepIndex,
          token,
          target,
          arg_index: argIndex,
          max: spec.max,
          value
        });
      }
    }

    if (spec.enum && !spec.enum.some((allowed) => Object.is(allowed, value))) {
      throw new ValidationError("RUN step arg is not in command enum.", {
        step_index: stepIndex,
        token,
        target,
        arg_index: argIndex,
        enum: spec.enum,
        value
      });
    }
  });
}

export function validatePlan(plan: PlanStep[], manifest: SystemManifest): void {
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new ValidationError("Plan must be a non-empty array.");
  }

  const catalog = buildCommandCatalog(manifest);

  const finalStep = plan[plan.length - 1];
  if (!finalStep || finalStep.type !== "STOP") {
    throw new ValidationError("Plan must end with a STOP step.");
  }

  plan.forEach((step, index) => {
    if (!step || typeof step !== "object") {
      throw new ValidationError("Plan steps must be objects.", { step_index: index, step });
    }

    if (step.type === "STOP") {
      if (index !== plan.length - 1) {
        throw new ValidationError("STOP is only allowed as the final step.", { step_index: index });
      }
      return;
    }

    if (step.type !== "RUN") {
      throw new ValidationError("Unknown step type.", { step_index: index, type: (step as { type?: unknown }).type });
    }

    if (typeof step.target !== "string" || !step.target) {
      throw new ValidationError("RUN step.target must be a non-empty string.", { step_index: index });
    }

    if (typeof step.token !== "string" || !step.token) {
      throw new ValidationError("RUN step.token must be a non-empty string.", { step_index: index });
    }

    const args = step.args ?? [];
    if (!Array.isArray(args)) {
      throw new ValidationError("RUN step.args must be an array.", { step_index: index, args });
    }

    if (step.duration_ms !== undefined) {
      if (typeof step.duration_ms !== "number" || !Number.isFinite(step.duration_ms) || step.duration_ms <= 0) {
        throw new ValidationError("RUN step.duration_ms must be a positive number when provided.", {
          step_index: index,
          duration_ms: step.duration_ms
        });
      }
    }

    const nodeCommands = catalog.get(step.target);
    if (!nodeCommands) {
      throw new ValidationError("RUN step target node does not exist in system_manifest.", {
        step_index: index,
        target: step.target
      });
    }

    const command = nodeCommands.get(step.token);
    if (!command) {
      throw new ValidationError("RUN step token does not exist in target node command catalog.", {
        step_index: index,
        target: step.target,
        token: step.token
      });
    }

    validateArgs(args, command.args, index, step.token, step.target);
  });
}
