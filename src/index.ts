import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_INTERVAL_MS = 80;
const DISABLE_ENV = "PI_STATUS_DISABLED";

type RuntimeState = {
  enabled: boolean;
  running: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
  frameIndex: number;
};

function isDisabledByEnv(): boolean {
  const value = process.env[DISABLE_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function getBaseTitle(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const cwd = path.basename(ctx.cwd || process.cwd());
  const session = pi.getSessionName();
  return session ? `π - ${session} - ${cwd}` : `π - ${cwd}`;
}

function setBaseTitle(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setTitle(getBaseTitle(pi, ctx));
}

export default function piStatus(pi: ExtensionAPI) {
  const state: RuntimeState = {
    enabled: !isDisabledByEnv(),
    running: false,
    timer: undefined,
    frameIndex: 0,
  };

  function stop(ctx: ExtensionContext): void {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = undefined;
    }

    state.running = false;
    state.frameIndex = 0;
    setBaseTitle(pi, ctx);
  }

  function start(ctx: ExtensionContext): void {
    if (!ctx.hasUI || !state.enabled) return;

    stop(ctx);
    state.running = true;

    const tick = () => {
      const frame = SPINNER_FRAMES[state.frameIndex % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0]!;
      ctx.ui.setTitle(`${frame} ${getBaseTitle(pi, ctx)}`);
      state.frameIndex++;
    };

    tick();
    state.timer = setInterval(tick, DEFAULT_INTERVAL_MS);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!state.enabled) return;
    setBaseTitle(pi, ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    start(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    stop(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stop(ctx);
  });

  pi.registerCommand("pi-status", {
    description: "Show or toggle the pi-status tab title spinner: on, off, or no argument for status.",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();

      if (command === "on") {
        state.enabled = true;
        if (state.running) start(ctx);
        else setBaseTitle(pi, ctx);
        ctx.ui.notify("pi-status spinner enabled", "info");
        return;
      }

      if (command === "off") {
        state.enabled = false;
        stop(ctx);
        ctx.ui.notify("pi-status spinner disabled", "info");
        return;
      }

      if (command && command !== "status") {
        ctx.ui.notify("Usage: /pi-status [on|off|status]", "error");
        return;
      }

      const envNote = isDisabledByEnv() ? ` (${DISABLE_ENV} is set)` : "";
      const enabled = state.enabled ? "enabled" : "disabled";
      const running = state.running ? "running" : "idle";
      ctx.ui.notify(`pi-status is ${enabled}, ${running}${envNote}`, "info");
    },
  });
}
