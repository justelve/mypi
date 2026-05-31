import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ThinkingSelectorComponent } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

const DEFAULT_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
];

export default function (pi: ExtensionAPI) {
  pi.registerCommand("effort", {
    description: "Set model thinking/effort level",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          "/effort is only available in interactive mode",
          "warning",
        );
        return;
      }

      const currentLevel = pi.getThinkingLevel();
      const availableLevels = ctx.model
        ? getSupportedThinkingLevels(ctx.model)
        : DEFAULT_LEVELS;

      const selected = await ctx.ui.custom<ThinkingLevel | null>(
        (tui, _theme, _keybindings, done) => {
          const selector = new ThinkingSelectorComponent(
            currentLevel,
            availableLevels,
            (level) => done(level),
            () => done(null),
          );

          const selectList = selector.getSelectList();

          return {
            render: (width: number) => selector.render(width),
            invalidate: () => selector.invalidate(),
            handleInput: (data: string) => {
              // ThinkingSelectorComponent is a Container; keyboard input needs to be
              // forwarded to its inner SelectList explicitly.
              selectList.handleInput?.(data);
              tui.requestRender();
            },
          };
        },
      );

      if (!selected) return;

      pi.setThinkingLevel(selected);
      ctx.ui.notify(`Thinking level: ${pi.getThinkingLevel()}`, "info");
    },
  });
}
