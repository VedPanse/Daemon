const REQUIRED_TOP_LEVEL = ["config_id", "manifest", "artifacts"];
const REQUIRED_ARTIFACTS = ["DAEMON.yaml", "daemon_entry.c"];

export function validateIngestBody(body) {
  if (!body || typeof body !== "object") {
    return "Body must be a JSON object.";
  }

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in body)) {
      return `Missing required field: ${key}`;
    }
  }

  if (typeof body.config_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.config_id)) {
    return "config_id must contain only letters, numbers, underscore, or dash.";
  }

  if (typeof body.artifacts !== "object" || body.artifacts === null) {
    return "artifacts must be an object.";
  }

  for (const key of REQUIRED_ARTIFACTS) {
    if (typeof body.artifacts[key] !== "string" || body.artifacts[key].trim() === "") {
      return `artifacts.${key} must be a non-empty string.`;
    }
  }

  return null;
}

export function readBearerToken(headerValue) {
  if (!headerValue || typeof headerValue !== "string") return null;
  const [scheme, token] = headerValue.split(" ", 2);
  if (scheme !== "Bearer" || !token) return null;
  return token;
}
