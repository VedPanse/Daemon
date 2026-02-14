# Sleepy Runbook

## Commands
```bash
python3 daemon-cli/examples/node-emulator/emulator.py --host 127.0.0.1 --port 7777 --manifest daemon-cli/examples/manifests/base.yml
```

```bash
python3 daemon-cli/examples/node-emulator/emulator.py --host 127.0.0.1 --port 7778 --manifest daemon-cli/examples/manifests/arm.yml
```

```bash
python3 orchestrator/orchestrator.py --node base=localhost:7777 --node arm=localhost:7778
# with telemetry: add --telemetry
```

## One-liner Smoke Test
```bash
bash daemon-cli/tools/smoke_test.sh
```

```bash
bash daemon-cli/tools/smoke_test_extended.sh
```

## Common Fixes
- Missing `PyYAML`: activate `daemon-cli/.venv` and run `python3 -m pip install -r daemon-cli/requirements.txt`.
- PEP-668 blocked install: use `venv` or `pipx`; do not use system `pip`.
