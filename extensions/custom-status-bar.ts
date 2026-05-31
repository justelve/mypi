import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
  let usageTimer: ReturnType<typeof setInterval> | undefined;

  pi.on("thinking_level_select", async (event) => {
    thinkingLevel = event.level;
    requestFooterRender?.();
  });

  pi.on("session_start", async (_event, ctx) => {
    thinkingLevel = pi.getThinkingLevel();

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
      const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: () => {
          unsubBranch();
          if (usageTimer) clearInterval(usageTimer);
          usageTimer = undefined;
          requestFooterRender = undefined;
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
            theme.fg("accent", `${model} `) +
            theme.fg("dim", `${contextText} (${thinking})`);
          const line1Right = branch
            ? theme.fg("success", branch)
            : theme.fg("dim", "no git branch");
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
