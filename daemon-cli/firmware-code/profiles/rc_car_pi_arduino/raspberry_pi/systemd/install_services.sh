#!/usr/bin/env bash
set -euo pipefail

PROFILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_DIR="${PROFILE_DIR}/systemd"

echo "Installing systemd services for DAEMON nodes..."
echo "Source: ${SYSTEMD_DIR}"

sudo install -m 0644 "${SYSTEMD_DIR}/daemon-mecanum.service" /etc/systemd/system/daemon-mecanum.service
sudo install -m 0644 "${SYSTEMD_DIR}/daemon-claw.service" /etc/systemd/system/daemon-claw.service
sudo install -m 0644 "${SYSTEMD_DIR}/daemon-camera.service" /etc/systemd/system/daemon-camera.service
sudo install -m 0644 "${SYSTEMD_DIR}/daemon-brain.service" /etc/systemd/system/daemon-brain.service

sudo systemctl daemon-reload
sudo systemctl enable --now daemon-mecanum.service
sudo systemctl enable --now daemon-claw.service
sudo systemctl enable --now daemon-camera.service
sudo systemctl enable --now daemon-brain.service

echo
echo "Status:"
sudo systemctl --no-pager status daemon-mecanum.service || true
sudo systemctl --no-pager status daemon-claw.service || true
sudo systemctl --no-pager status daemon-camera.service || true
sudo systemctl --no-pager status daemon-brain.service || true
