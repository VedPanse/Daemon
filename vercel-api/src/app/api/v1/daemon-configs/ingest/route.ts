import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { normalizeStoragePath, readBearerToken, validateIngestBody, type IngestBody } from "@/lib/ingest";

export const runtime = "nodejs";

interface UploadEntry {
  name: string;
  url: string;
}

interface IngestResponse {
  status: "success";
  config_id: string;
  storage_path: string;
  persisted: boolean;
  uploaded: UploadEntry[];
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

async function persistToBlob(basePath: string, body: IngestBody): Promise<UploadEntry[]> {
  const uploaded: UploadEntry[] = [];

  const manifestBlob = await put(`${basePath}/manifest.json`, JSON.stringify(body.manifest, null, 2), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json"
  });
  uploaded.push({ name: "manifest.json", url: manifestBlob.url });

  const yamlBlob = await put(`${basePath}/DAEMON.yaml`, body.artifacts["DAEMON.yaml"], {
    access: "public",
    addRandomSuffix: false,
    contentType: "text/yaml"
  });
  uploaded.push({ name: "DAEMON.yaml", url: yamlBlob.url });

  const cBlob = await put(`${basePath}/daemon_entry.c`, body.artifacts["daemon_entry.c"], {
    access: "public",
    addRandomSuffix: false,
    contentType: "text/x-c"
  });
  uploaded.push({ name: "daemon_entry.c", url: cBlob.url });

  return uploaded;
}

export async function POST(request: Request) {
  const requiredToken = process.env.DAEMON_PUBLISH_API_KEY;
  if (requiredToken) {
    const providedToken = readBearerToken(request.headers.get("authorization"));
    if (providedToken !== requiredToken) {
      return unauthorized();
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validationError = validateIngestBody(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const typedBody = body as IngestBody;
  const storagePath = normalizeStoragePath(typedBody);

  const response: IngestResponse = {
    status: "success",
    config_id: typedBody.config_id,
    storage_path: storagePath,
    persisted: false,
    uploaded: []
  };

  try {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      response.uploaded = await persistToBlob(storagePath, typedBody);
      response.persisted = true;
    } else {
      console.log("[daemon-ingest] accepted payload without Blob persistence", {
        config_id: typedBody.config_id,
        storage_path: storagePath,
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
