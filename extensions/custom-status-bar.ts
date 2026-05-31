import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function shortPath(path: string): string {
  const home = process.env.HOME;
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

type CodexUsage = {
  primaryPercent: number;
  secondaryPercent?: number;
  resetAfterSeconds?: number;
};

type GitDiffStats = {
  additions: number;
  deletions: number;
};

type VoiceStatus = {
  status: string;
  detail: string;
  updatedAt: number;
  recording: boolean;
  transcribing: boolean;
};

function getVoiceStatus(): VoiceStatus | undefined {
  return (globalThis as Record<string, unknown>).__piLocalVoiceStatus as
    | VoiceStatus
    | undefined;
}

async function fetchGitDiffStats(
  cwd: string,
): Promise<GitDiffStats | undefined> {
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--numstat", "HEAD", "--"],
    { cwd },
  );

  let additions = 0;
  let deletions = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [added, deleted] = line.split("\t");
    if (added !== "-") additions += Number(added) || 0;
    if (deleted !== "-") deletions += Number(deleted) || 0;
  }

  return { additions, deletions };
}

async function fetchCodexUsage(): Promise<CodexUsage | undefined> {
  const home = process.env.HOME;
  if (!home) return undefined;

  const auth = JSON.parse(
    await readFile(join(home, ".codex", "auth.json"), "utf8"),
  );
  const token = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!token) return undefined;

  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      authorization: `Bearer ${token}`,
      ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
    },
  });
  if (!response.ok) return undefined;

  const data = await response.json();
  const primary = data.rate_limit?.primary_window;
  const secondary = data.rate_limit?.secondary_window;
  if (typeof primary?.used_percent !== "number") return undefined;

  return {
    primaryPercent: primary.used_percent,
    secondaryPercent:
      typeof secondary?.used_percent === "number"
        ? secondary.used_percent
        : undefined,
    resetAfterSeconds: primary.reset_after_seconds,
  };
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function usageColor(percent: number): "success" | "warning" | "error" {
  if (percent >= 90) return "error";
  if (percent >= 75) return "warning";
  return "success";
}

export default function (pi: ExtensionAPI) {
  // Do not call pi.getThinkingLevel() during extension loading: runtime action
  // methods are only available after the extension runtime is initialized.
  let thinkingLevel = "off";
  let requestFooterRender: (() => void) | undefined;
  let codexUsage: CodexUsage | undefined;
  let gitDiffStats: GitDiffStats | undefined;
  let usageTimer: ReturnType<typeof setInterval> | undefined;

  const updateGitDiffStats = async (cwd: string) => {
    try {
      gitDiffStats = await fetchGitDiffStats(cwd);
    } catch {
      gitDiffStats = undefined;
    }
    requestFooterRender?.();
  };

  pi.on("thinking_level_select", async (event) => {
    thinkingLevel = event.level;
    requestFooterRender?.();
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    void updateGitDiffStats(ctx.cwd);
  });

  pi.on("session_start", async (_event, ctx) => {
    thinkingLevel = pi.getThinkingLevel();
    void updateGitDiffStats(ctx.cwd);

    const updateCodexUsage = async () => {
      try {
        codexUsage = await fetchCodexUsage();
        requestFooterRender?.();
      } catch {
        // Leave the previous value visible if the Codex usage endpoint is unavailable.
      }
    };
    void updateCodexUsage();
    if (usageTimer) clearInterval(usageTimer);
    usageTimer = setInterval(updateCodexUsage, 60_000);

    ctx.ui.setFooter((tui, theme, footerData) => {
      requestFooterRender = () => tui.requestRender();
      (globalThis as Record<string, unknown>).__piRequestFooterRender =
        requestFooterRender;
      const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: () => {
          unsubBranch();
          if (usageTimer) clearInterval(usageTimer);
          usageTimer = undefined;
          requestFooterRender = undefined;
          delete (globalThis as Record<string, unknown>)
            .__piRequestFooterRender;
        },
        invalidate() {},

        render(width: number): string[] {
          let inputTokens = 0;
          let outputTokens = 0;
          let cost = 0;

          for (const entry of ctx.sessionManager.getBranch()) {
            if (
              entry.type === "message" &&
              entry.message.role === "assistant"
            ) {
              const msg = entry.message as AssistantMessage;
              if (msg.provider && msg.provider !== "openai-codex") continue;
              inputTokens += msg.usage.input;
              outputTokens += msg.usage.output;
              cost += msg.usage.cost.total;
            }
          }

          const branch = footerData.getGitBranch();
          const path = shortPath(process.cwd());
          const model = ctx.model?.id ?? "no model";
          const thinking =
            thinkingLevel === "off"
              ? "thinking off"
              : `thinking ${thinkingLevel}`;

          const contextUsage = ctx.getContextUsage();
          const contextText = contextUsage
            ? ` ctx ${formatTokens(contextUsage.tokens)}${contextUsage.percent === null ? "" : `/${contextUsage.percent.toFixed(0)}%`}`
            : "";
          const line1Left =
            theme.fg("accent", `${model} - ${thinking}`) +
            theme.fg("dim", contextText);
          const gitDiffText = gitDiffStats
            ? theme.fg("success", `+${formatTokens(gitDiffStats.additions)} `) +
              theme.fg("error", `-${formatTokens(gitDiffStats.deletions)} `)
            : "";
          const voice = getVoiceStatus();
          if (voice && (voice.recording || voice.transcribing)) {
            setTimeout(() => tui.requestRender(), 250).unref?.();
          }
          const voiceText =
            voice && Date.now() - voice.updatedAt < 120_000
              ? theme.fg(
                  voice.recording
                    ? "error"
                    : voice.transcribing
                      ? "warning"
                      : "success",
                  `${voice.recording ? "🎙️ " : ""}${voice.status}`,
                ) + theme.fg("dim", "  ")
              : "";
          const line1Right =
            voiceText +
            (gitDiffText === "" && !branch
              ? theme.fg("dim", "no git branch")
              : gitDiffText +
                (branch
                  ? theme.bold(theme.fg("text", branch))
                  : theme.fg("dim", "no git branch")));
          const line1Pad = " ".repeat(
            Math.max(
              1,
              width - visibleWidth(line1Left) - visibleWidth(line1Right),
            ),
          );

          const line2Left = theme.fg("dim", path);
          const line2Right =
            theme.fg(
              "dim",
              `↑${formatTokens(inputTokens)} ↓${formatTokens(outputTokens)} $${cost.toFixed(3)}`,
            ) +
            (codexUsage
              ? theme.fg("dim", "  Codex ") +
                theme.fg(
                  usageColor(codexUsage.primaryPercent),
                  `${codexUsage.primaryPercent}%`,
                ) +
                (codexUsage.secondaryPercent === undefined
                  ? ""
                  : theme.fg("dim", "/") +
                    theme.fg(
                      usageColor(codexUsage.secondaryPercent),
                      `${codexUsage.secondaryPercent}%`,
                    )) +
                (codexUsage.resetAfterSeconds === undefined
                  ? ""
                  : theme.fg(
                      "dim",
                      ` reset ${formatDuration(codexUsage.resetAfterSeconds)}`,
                    ))
              : "");
          const line2Pad = " ".repeat(
            Math.max(
              1,
              width - visibleWidth(line2Left) - visibleWidth(line2Right),
            ),
          );

          return [
            truncateToWidth(line1Left + line1Pad + line1Right, width),
            truncateToWidth(line2Left + line2Pad + line2Right, width),
          ];
        },
      };
    });
  });

  pi.registerCommand("default-footer", {
    description: "Restore pi's default footer/status bar",
    handler: async (_args, ctx) => {
      ctx.ui.setFooter(undefined);
      ctx.ui.notify("Default footer restored", "info");
    },
  });

  pi.registerCommand("custom-footer", {
    description: "Re-enable the custom footer/status bar",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Restart pi or run /reload to re-enable the custom footer",
        "info",
      );
    },
  });
}
