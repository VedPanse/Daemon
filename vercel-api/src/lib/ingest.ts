const REQUIRED_TOP_LEVEL = ["config_id", "manifest", "artifacts"] as const;
const REQUIRED_ARTIFACTS = ["DAEMON.yaml", "daemon_entry.c"] as const;

export interface IngestBody {
  config_id: string;
  manifest: Record<string, unknown>;
  artifacts: Record<string, string>;
  storage_path?: string;
}

export function validateIngestBody(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Body must be a JSON object.";
  }

  const data = body as Record<string, unknown>;

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in data)) {
      return `Missing required field: ${key}`;
    }
  }

  if (typeof data.config_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(data.config_id)) {
    return "config_id must contain only letters, numbers, underscore, or dash.";
  }

  if (!data.manifest || typeof data.manifest !== "object" || Array.isArray(data.manifest)) {
    return "manifest must be an object.";
  }

  if (!data.artifacts || typeof data.artifacts !== "object" || Array.isArray(data.artifacts)) {
    return "artifacts must be an object.";
  }

  const artifacts = data.artifacts as Record<string, unknown>;
  for (const key of REQUIRED_ARTIFACTS) {
    const value = artifacts[key];
    if (typeof value !== "string" || !value.trim()) {
      return `artifacts.${key} must be a non-empty string.`;
    }
  }

  if (data.storage_path !== undefined && (typeof data.storage_path !== "string" || !data.storage_path.trim())) {
    return "storage_path must be a non-empty string when provided.";
  }

  return null;
}

export function readBearerToken(headerValue: string | null): string | null {
  if (!headerValue || typeof headerValue !== "string") {
    return null;
  }

  const [scheme, token] = headerValue.split(" ", 2);
  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
}

export function normalizeStoragePath(body: IngestBody): string {
  if (typeof body.storage_path === "string" && body.storage_path.trim()) {
    return body.storage_path.replace(/^\/+|\/+$/g, "");
  }
  return `configs/${body.config_id}`;
}
