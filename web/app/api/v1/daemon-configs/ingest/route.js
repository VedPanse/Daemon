import { put } from "@vercel/blob";
import { NextResponse } from "next/server";

import { readBearerToken, validateIngestBody } from "@/lib/validation";

export const runtime = "nodejs";

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function normalizeBasePath(body) {
  if (typeof body.storage_path === "string" && body.storage_path.trim()) {
    return body.storage_path.replace(/^\/+|\/+$/g, "");
  }
  return `configs/${body.config_id}`;
}

async function persistToBlob(basePath, body) {
  const uploaded = [];

  const manifestBlob = await put(`${basePath}/manifest.json`, JSON.stringify(body.manifest, null, 2), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json"
  });
  uploaded.push({ name: "manifest.json", url: manifestBlob.url });

  const yamlBlob = await put(`${basePath}/DAEMON.yaml`, body.artifacts["DAEMON.yaml"], {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "text/yaml"
  });
  uploaded.push({ name: "DAEMON.yaml", url: yamlBlob.url });

  const cBlob = await put(`${basePath}/daemon_entry.c`, body.artifacts["daemon_entry.c"], {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "text/x-c"
  });
  uploaded.push({ name: "daemon_entry.c", url: cBlob.url });

  return uploaded;
}

export async function POST(request) {
  const requiredToken = process.env.DAEMON_PUBLISH_API_KEY;
  if (requiredToken) {
    const providedToken = readBearerToken(request.headers.get("authorization"));
    if (providedToken !== requiredToken) {
      return unauthorized();
    }
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validationError = validateIngestBody(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const basePath = normalizeBasePath(body);
  const response = {
    status: "success",
    config_id: body.config_id,
    storage_path: basePath,
    persisted: false,
    uploaded: []
  };

  try {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      response.uploaded = await persistToBlob(basePath, body);
      response.persisted = true;
    } else {
      console.log("[daemon-ingest] accepted payload without Blob persistence", {
        config_id: body.config_id,
        storage_path: basePath,
        received_at: new Date().toISOString()
      });
    }
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to persist artifacts",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }

  return NextResponse.json(response, { status: 200 });
}
