import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const shortcut = process.env.PI_VOICE_SHORTCUT ?? "ctrl+space";
const model = process.env.PI_VOICE_MODEL ?? "mlx-community/whisper-tiny-mlx";
const whisperCppModel = process.env.PI_VOICE_WHISPER_CPP_MODEL;
const audioDevice = process.env.PI_VOICE_AUDIO_DEVICE ?? ":0";
const warmupEnabled = process.env.PI_VOICE_WARMUP !== "0";
const stateKey = "__piLocalVoiceStatus";

type VoiceStatus = {
  status: string;
  detail: string;
  updatedAt: number;
  recording: boolean;
  transcribing: boolean;
};

function setSharedStatus(status: Partial<VoiceStatus>) {
  const previous = ((globalThis as Record<string, unknown>)[stateKey] as
    | VoiceStatus
    | undefined) ?? {
    status: "voice: idle",
    detail: "",
    updatedAt: Date.now(),
    recording: false,
    transcribing: false,
  };
  (globalThis as Record<string, unknown>)[stateKey] = {
    ...previous,
    ...status,
    updatedAt: Date.now(),
  };

  const requestRender = (globalThis as Record<string, unknown>)
    .__piRequestFooterRender;
  if (typeof requestRender === "function") requestRender();
}

type Ctx = {
  ui: {
    setEditorText?(text: string): void;
    notify(message: string, level?: "info" | "warn" | "error"): void;
  };
};

type Engine =
  | { kind: "mlx-whisper"; command: string }
  | { kind: "whisper.cpp"; command: string; model: string };

function which(command: string): string | undefined {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
}

function detectEngine(): Engine | undefined {
  if (process.env.PI_VOICE_ENGINE === "whisper.cpp") {
    const command = which("whisper-cli") ?? which("whisper-cpp");
    if (command && whisperCppModel)
      return { kind: "whisper.cpp", command, model: whisperCppModel };
    return undefined;
  }

  const mlx = which("mlx_whisper");
  if (mlx) return { kind: "mlx-whisper", command: mlx };

  const cpp = which("whisper-cli") ?? which("whisper-cpp");
  if (cpp && whisperCppModel)
    return { kind: "whisper.cpp", command: cpp, model: whisperCppModel };

  return undefined;
}

function render(_ctx: Ctx, status: string, detail: string) {
  setSharedStatus({
    status,
    detail,
    recording: status.includes("recording"),
    transcribing:
      status.includes("transcribing") ||
      status.includes("waiting") ||
      status.includes("warming"),
  });
}

function run(
  command: string,
  args: string[],
  options?: { signal?: AbortSignal },
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}\n${stderr || stdout}`));
    });
    options?.signal?.addEventListener("abort", () => child.kill("SIGINT"), {
      once: true,
    });
  });
}

async function transcribe(engine: Engine, wav: string, dir: string) {
  if (engine.kind === "mlx-whisper") {
    const { stdout, stderr } = await run(engine.command, [
      wav,
      "--model",
      model,
      "--output-dir",
      dir,
      "--output-format",
      "txt",
    ]);

    const txtPath = join(dir, "speech.txt");
    if (existsSync(txtPath)) return readFileSync(txtPath, "utf8").trim();
    return parseMlxOutput(stdout || stderr);
  }

  const out = join(dir, "transcript");
  await run(engine.command, [
    "-m",
    engine.model,
    "-f",
    wav,
    "-otxt",
    "-of",
    out,
    "-nt",
  ]);
  return readFileSync(`${out}.txt`, "utf8").trim();
}

function parseMlxOutput(output: string) {
  const trimmed = output.trim();
  try {
    const parsed = JSON.parse(trimmed) as { text?: string };
    if (parsed.text) return parsed.text.trim();
  } catch {}
  return trimmed
    .split("\n")
    .filter(
      (line) => !line.includes("Fetching") && !line.includes("Special tokens"),
    )
    .join("\n")
    .trim();
}

export default function (pi: ExtensionAPI) {
  setSharedStatus({
    status: "voice: idle",
    detail: `model: ${model}`,
    recording: false,
    transcribing: false,
  });
  let recorder: ChildProcess | undefined;
  let workDir: string | undefined;
  let wav: string | undefined;
  let warmupPromise: Promise<void> | undefined;

  async function warmup(ctx?: Ctx) {
    if (!warmupEnabled || warmupPromise) return warmupPromise;

    warmupPromise = (async () => {
      const engine = detectEngine();
      if (!engine) return;

      const dir = mkdtempSync(join(tmpdir(), "pi-voice-warmup-"));
      const silence = join(dir, "speech.wav");
      try {
        ctx &&
          render(ctx, "voice: warming", `Warming ${engine.kind} ${model}...`);
        await run("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=channel_layout=mono:sample_rate=16000",
          "-t",
          "0.25",
          "-y",
          silence,
        ]);
        await transcribe(engine, silence, dir);
        ctx &&
          render(
            ctx,
            "voice: idle",
            `Warmup complete: ${engine.kind} ${model}`,
          );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx && render(ctx, "voice: warmup failed", message.slice(0, 160));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();

    return warmupPromise;
  }

  async function stop(ctx: Ctx) {
    const child = recorder;
    if (!child || !workDir || !wav) return;

    render(ctx, "voice: stopping", "Stopping recorder...");
    recorder = undefined;
    child.kill("SIGINT");
    await new Promise((resolve) => child.once("close", resolve));

    const engine = detectEngine();
    if (!engine) {
      render(
        ctx,
        "voice: error",
        "Install mlx-whisper: pipx install mlx-whisper",
      );
      ctx.ui.notify(
        "No local Whisper engine found. Install with: pipx install mlx-whisper",
        "error",
      );
      return;
    }

    const startedAt = Date.now();
    if (warmupPromise) {
      render(ctx, "voice: waiting", "Waiting for startup warmup to finish...");
      await warmupPromise;
    }
    render(ctx, "voice: transcribing", `Using ${engine.kind} with ${model}...`);
    const text = await transcribe(engine, wav, workDir);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
    wav = undefined;

    if (!text) {
      render(ctx, "voice: idle", "No speech detected.");
      ctx.ui.notify("No speech detected.", "warn");
      return;
    }

    render(
      ctx,
      "voice: done",
      `Transcribed in ${elapsed}s: ${text.slice(0, 100)}`,
    );
    if (ctx.ui.setEditorText) {
      ctx.ui.setEditorText(text);
      ctx.ui.notify("Transcript inserted into editor.", "info");
    } else {
      pi.sendUserMessage(text);
      ctx.ui.notify("Transcript sent as user message.", "info");
    }
  }

  async function start(ctx: Ctx) {
    if (!which("ffmpeg")) {
      render(ctx, "voice: error", "Install ffmpeg: brew install ffmpeg");
      ctx.ui.notify(
        "ffmpeg is required. Install with: brew install ffmpeg",
        "error",
      );
      return;
    }

    workDir = mkdtempSync(join(tmpdir(), "pi-voice-"));
    wav = join(workDir, "speech.wav");
    render(
      ctx,
      "🎙️ recording",
      `Recording from avfoundation ${audioDevice}. Press ${shortcut} again to stop.`,
    );

    recorder = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "avfoundation",
      "-i",
      audioDevice,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-y",
      wav,
    ]);

    recorder.stderr?.on("data", (data) =>
      render(ctx, "🎙️ recording", String(data).trim().slice(0, 160)),
    );
    recorder.on("error", (error) => {
      render(ctx, "voice: error", error.message);
      ctx.ui.notify(error.message, "error");
    });
  }

  async function toggle(ctx: Ctx) {
    try {
      if (recorder) await stop(ctx);
      else await start(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      render(ctx, "voice: error", message);
      ctx.ui.notify(message, "error");
    }
  }

  pi.registerShortcut(shortcut, {
    description: "Toggle local Whisper voice input",
    handler: toggle,
  });

  pi.registerCommand("voice", {
    description: "Toggle local Whisper voice input",
    handler: async (_args, ctx) => toggle(ctx),
  });

  pi.registerCommand("voice-status", {
    description: "Show local voice input status",
    handler: async (_args, ctx) => {
      const engine = detectEngine();
      render(
        ctx,
        recorder ? "🎙️ recording" : "voice: idle",
        `ffmpeg: ${which("ffmpeg") ?? "missing"} | engine: ${engine ? engine.kind : "missing"} | model: ${model} | warmup: ${warmupEnabled ? "on" : "off"}`,
      );
    },
  });

  pi.registerCommand("voice-warmup", {
    description: "Warm local Whisper model now",
    handler: async (_args, ctx) => {
      await warmup(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    void warmup(ctx);
  });

  pi.on("session_shutdown", async () => {
    recorder?.kill("SIGINT");
    setSharedStatus({
      status: "voice: idle",
      detail: "session shutdown",
      recording: false,
      transcribing: false,
    });
  });
}
