# Daemon Web (Vercel)

This app provides the publish endpoint used by the CLI:

- `POST /api/v1/daemon-configs/ingest`
- `GET /api/health`

## Local run

```bash
cd web
npm install
npm run dev
```

Test health:

```bash
curl http://localhost:3000/api/health
```

## Deploy to Vercel

1. Create and link a Vercel project (from repo root):

```bash
vercel
```

2. In Vercel project settings:
- Set **Root Directory** to `web`
- Framework preset: **Next.js**

3. Add environment variables (optional but recommended):
- `DAEMON_PUBLISH_API_KEY` (protect ingest endpoint)
- `BLOB_READ_WRITE_TOKEN` (persist artifacts to Vercel Blob)

4. Deploy:

```bash
vercel --prod
```

## Configure CLI to publish

Set env var:

```bash
export DAEMON_PUBLISH_URL="https://<your-vercel-domain>/api/v1/daemon-configs/ingest"
export DAEMON_PUBLISH_API_KEY="<same-token-if-configured>"
```

Run build + publish:

```bash
daemon build \
  --context-dir daemon-cli/firmware-code/profiles/rc_car_pi_arduino \
  --profile rc_car_pi_arduino \
  --publish
```

Or explicit URL per command:

```bash
daemon build \
  --context-dir daemon-cli/firmware-code/profiles/rc_car_pi_arduino \
  --profile rc_car_pi_arduino \
  --publish \
  --publish-url https://<your-vercel-domain>/api/v1/daemon-configs/ingest
```

## API behavior

- Validates payload shape (`config_id`, `manifest`, `artifacts`)
- Requires Bearer token only when `DAEMON_PUBLISH_API_KEY` is set
- Stores `manifest.json`, `DAEMON.yaml`, `daemon_entry.c` to Vercel Blob when `BLOB_READ_WRITE_TOKEN` exists
- If Blob token is missing, it still accepts and returns success without persistence
