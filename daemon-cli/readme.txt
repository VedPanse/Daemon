Daemon CLI
==========

Install locally:

  cd daemon-cli
  pip install -e .

Usage:

  daemon build

What `daemon build` does:

- Reads all text files under `firmware-code/` as context
- Calls the OpenAI/Codex API
- Writes:
  - `firmware-code/DAEMON.yaml`
  - `firmware-code/daemon_entry.c`

Environment requirements:

- Set `OPENAI_API_KEY` or `OPEN_AI_API_KEY`
- The CLI will also read these keys from a `.env` file in the current directory
  or parent directories

Optional flags:

- `--firmware-dir <path>`
- `--system-prompt-file <path>`
- `--model <model_name>`
- `--daemon-yaml-path <path>`
- `--daemon-entry-path <path>`

Notes:

- Default system prompt is a placeholder in `daemon_cli/main.py`
- Replace it later or pass `--system-prompt-file`
