# My Pi setup

Extensions and skills I use in [Pi](https://pi.dev/).

## Setup

Clone the repo, then run:

```sh
./scripts/setup.sh
```

The setup script installs project npm dependencies, installs the third-party Pi packages listed below,
and then installs this repo into Pi.

If you prefer to install only this repo manually:

```sh
pi install /path/to/repo
```

## Third-party Pi packages

These are the currently installed non-custom Pi packages from npm or GitHub:

- [`npm:pi-hashline-edit`](https://github.com/RimuruW/pi-hashline-edit) (`pi-hashline-edit` npm package) — hash-line anchored file editing tool used by Pi coding-agent workflows.

## Custom extensions

Custom written extensions that I've found useful, some used more than others.

### Custom status bar

Custom status bar overriding the one provided by Pi itself. Shows some useful information like
the model in use, effort level, in/out tokens, session usage etc.

<img width="987" height="133" alt="image" src="https://github.com/user-attachments/assets/8013fb90-cbfb-4e4c-ba29-b2337a9868e6" />

[Source](extensions/custom-status-bar.ts)

### Model effort command

Custom `/effort` command that allows me to switch the effort/thinking level of the model without
having to go thorugh the `/settings` menu.

[Source](extensions/effort.ts)

### Local voice transcription

Local Whisper voice input for Pi. Press `ctrl+space` (or run `/voice`) to start recording,
press it again to stop and transcribe, or press `escape` to cancel. The transcript is inserted
into the editor when supported, otherwise it is sent as a user message.

Requires `ffmpeg` plus a local Whisper engine:

- default: `mlx-whisper` (`pipx install mlx-whisper`) using `mlx-community/whisper-small-mlx`
- fallback/optional: `whisper.cpp` via `whisper-cli` or `whisper-cpp` with `PI_VOICE_WHISPER_CPP_MODEL` set

Useful commands:

- `/voice` toggles recording
- `/voice-status` shows engine/model/device status
- `/voice-warmup` warms the local model manually

Configuration environment variables:

- `PI_VOICE_SHORTCUT` (default `ctrl+space`)
- `PI_VOICE_MODEL` (default `mlx-community/whisper-small-mlx`)
- `PI_VOICE_LANGUAGE` (default `en`)
- `PI_VOICE_AUDIO_DEVICE` (default `:0` for macOS `avfoundation`)
- `PI_VOICE_ENGINE=whisper.cpp` to force whisper.cpp
- `PI_VOICE_WHISPER_CPP_MODEL=/path/to/model.bin` for whisper.cpp
- `PI_VOICE_WARMUP=0` to disable session-start warmup

[Source](extensions/local-voice.ts)
