#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v pi >/dev/null 2>&1; then
  echo "Error: pi is not installed or is not on PATH." >&2
  echo "Install Pi first: npm install -g @earendil-works/pi-coding-agent" >&2
  exit 1
fi

if command -v npm >/dev/null 2>&1; then
  echo "Installing project npm dependencies..."
  npm install
else
  echo "Warning: npm is not installed; skipping project dependency install." >&2
fi

echo "Installing third-party Pi packages..."
pi install npm:pi-hashline-edit

echo "Installing this Pi setup..."
pi install "$ROOT_DIR"

cat <<'MSG'

Setup complete.

Optional for local voice transcription:
  - install ffmpeg
  - install mlx-whisper: pipx install mlx-whisper
MSG
