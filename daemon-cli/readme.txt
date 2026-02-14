Daemon CLI
==========

Install locally:

  cd daemon-cli
  pip install -e .

Usage:

  daemon build

Primary workflow:

1) Create sample profile contexts (optional but recommended):

   daemon init-samples

   This writes profile-specific firmware context files into:
   `firmware-code/profiles/<profile>/...`

2) Build a unique configuration from firmware context:

   daemon build --context-dir firmware-code/profiles/rc_car_pi_arduino --profile rc_car_pi_arduino

   The build writes to a unique folder each run:
   - `firmware-code/configs/<config_id>/DAEMON.yaml`
   - `firmware-code/configs/<config_id>/daemon_entry.c`
   - `firmware-code/configs/<config_id>/manifest.json`

3) Publish generated artifacts to your Vercel endpoint:

   daemon build --context-dir firmware-code/profiles/rc_car_pi_arduino --profile rc_car_pi_arduino --publish

   or publish an existing config:

   daemon publish --config-id <config_id>

Environment requirements:

- Set `OPENAI_API_KEY` or `OPEN_AI_API_KEY`
- The CLI will also read these keys from a `.env` file in the current directory
  or parent directories
- Optional for publish auth: `DAEMON_PUBLISH_API_KEY`
- Optional custom publish URL: `DAEMON_PUBLISH_URL`

Optional flags:

- `daemon build --firmware-dir <path>`
- `daemon build --context-dir <path>`
- `daemon build --profile <name>`
- `daemon build --config-id <id>`
- `daemon build --generation-mode model|template`
- `daemon build --system-prompt-file <path>`
- `daemon build --model <model_name>`
- `daemon build --publish --publish-url <https://...>`
- `daemon build --daemon-yaml-path <path>` (extra legacy copy)
- `daemon build --daemon-entry-path <path>` (extra legacy copy)
- `daemon publish --config-id <id>`
- `daemon init-samples --force`

Notes:

- Placeholder publish URL default:
  `https://daemon-api.vercel.app/api/v1/daemon-configs/ingest`
  (replace with your actual Vercel API route)
- `generation-mode=template` gives deterministic local sample outputs and does not call OpenAI.
