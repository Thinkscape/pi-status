import { homedir } from "node:os";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text, matchesKey, Key } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ComponentConfig {
  id: string;
  enabled: boolean;
}

interface PiStatusConfig {
  separator: string;
  components: ComponentConfig[];
  ghosttySupport: boolean;
}

type RuntimeState = {
  enabled: boolean;
  running: boolean;
  destroyed: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
  idleTimer: ReturnType<typeof setTimeout> | undefined; // Recursive re-assert timeout when idle
  completionTimer: ReturnType<typeof setTimeout> | undefined;
  ghosttyKeepaliveTimer: ReturnType<typeof setInterval> | undefined;
  ghosttySuccessVisible: boolean;
  terminalInputUnsubscribe: (() => void) | undefined;
  titleRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  titleRefreshInterval: ReturnType<typeof setInterval> | undefined;
  titleRefreshStopTimer: ReturnType<typeof setTimeout> | undefined;
  frameIndex: number;
  turnIndex: number;
  modelName: string;
  thinkingLevel: string;
  gitBranch: string;
  tokenUsage: number;
  currentTool: string;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_INTERVAL_MS = 80;
const IDLE_REASSERT_START_MS = 200; // First re-assert check after agent_end (catches pi-autoname)
const IDLE_REASSERT_MAX_MS = 5000; // Max backoff between idle re-assert checks
const GHOSTTY_KEEPALIVE_MS = 1000;
const GHOSTTY_FOCUS_IN = "\x1b[I";
const GHOSTTY_FOCUS_OUT = "\x1b[O";
const DISABLE_ENV = "PI_STATUS_DISABLED";

const ALL_COMPONENT_IDS = [
  "spinner",
  "pi_symbol",
  "session",
  "cwd",
  "model",
  "thinking",
  "tokens",
  "turn",
  "git_branch",
  "tools_count",
  "current_tool",
] as const;

type ComponentId = (typeof ALL_COMPONENT_IDS)[number];

const COMPONENT_LABELS: Record<ComponentId, string> = {
  spinner: "Spinner (progress icon)",
  pi_symbol: "π symbol",
  session: "Session name",
  cwd: "Working directory",
  model: "Current model",
  thinking: "Thinking level",
  tokens: "Token usage",
  turn: "Turn number",
  git_branch: "Git branch",
  tools_count: "Active tool count",
  current_tool: "Current tool name",
};

const DEFAULT_CONFIG: PiStatusConfig = {
  separator: " - ",
  ghosttySupport: true,
  components: [
    { id: "spinner", enabled: true },
    { id: "pi_symbol", enabled: true },
    { id: "session", enabled: true },
    { id: "cwd", enabled: true },
    { id: "model", enabled: false },
    { id: "thinking", enabled: false },
    { id: "tokens", enabled: false },
    { id: "turn", enabled: false },
    { id: "git_branch", enabled: false },
    { id: "tools_count", enabled: false },
    { id: "current_tool", enabled: false },
  ],
};

// ---------------------------------------------------------------------------
// Config persistence: read / write pi settings.json
// ---------------------------------------------------------------------------

function getSettingsPaths(): { global: string; project: string } {
  return {
    global: path.join(homedir(), ".pi", "agent", "settings.json"),
    project: path.join(process.cwd(), ".pi", "settings.json"),
  };
}

function loadJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readMergedSettings(): Record<string, unknown> {
  const { global, project } = getSettingsPaths();
  const globalSettings = loadJsonSafe(global) ?? {};
  const projectSettings = loadJsonSafe(project) ?? {};
  // shallow merge: project overrides global
  return { ...globalSettings, ...projectSettings };
}

function readPiStatusConfig(): PiStatusConfig {
  const settings = readMergedSettings();
  const raw = settings["piStatus"] as PiStatusConfig | undefined;
  if (!raw || typeof raw !== "object") return structuredClone(DEFAULT_CONFIG);

  const separator = typeof raw.separator === "string" ? raw.separator : DEFAULT_CONFIG.separator;

  const rawComponents = Array.isArray(raw.components) ? raw.components : [];
  // Build component list: preserve order from user config, append any missing
  // new components from ALL_COMPONENT_IDS at the end (disabled by default).
  const existing = new Map(rawComponents.map((c) => [c.id, c.enabled]));
  const components: ComponentConfig[] = [];
  for (const c of rawComponents) {
    if (typeof c.id === "string" && ALL_COMPONENT_IDS.includes(c.id as ComponentId)) {
      components.push({ id: c.id, enabled: c.enabled !== false });
    }
  }
  for (const id of ALL_COMPONENT_IDS) {
    if (!existing.has(id)) {
      components.push({ id, enabled: DEFAULT_CONFIG.components.find((d) => d.id === id)?.enabled ?? false });
    }
  }

  return { separator, components, ghosttySupport: typeof raw.ghosttySupport === "boolean" ? raw.ghosttySupport : true };
}

function writePiStatusConfig(config: PiStatusConfig): void {
  const { project } = getSettingsPaths();
  // Prefer project settings if they exist, otherwise write to global.
  // If neither exists, create global.
  const targetPath = existsSync(project) ? project : getSettingsPaths().global;
  const existing = loadJsonSafe(targetPath) ?? {};
  existing["piStatus"] = config as unknown as Record<string, unknown>;
  writeFileSync(targetPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
}

function isDisabledByEnv(): boolean {
  const value = process.env[DISABLE_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

// ---------------------------------------------------------------------------
// Ghostty OSC 9;4 progress bar (native in Ghostty / libghostty terminals)
// ---------------------------------------------------------------------------

function ghosttyWrite(seq: string) {
  try {
    writeFileSync("/dev/tty", seq);
  } catch {
    // /dev/tty unavailable (e.g. non-interactive or subagent context)
  }
}

function setGhosttyProgress(state: number, value?: number) {
  const args = value !== undefined ? `${state};${value}` : `${state}`;
  ghosttyWrite(`\x1b]9;4;${args}\x07`);
}

function enableFocusReporting() {
  ghosttyWrite("\x1b[?1004h");
}

function disableFocusReporting() {
  ghosttyWrite("\x1b[?1004l");
}

// ---------------------------------------------------------------------------
// Component value resolvers
// ---------------------------------------------------------------------------

function resolveComponentValue(
  id: ComponentId,
  state: RuntimeState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): string {
  switch (id) {
    case "spinner": {
      if (!state.running) return "";
      return SPINNER_FRAMES[state.frameIndex % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0]!;
    }
    case "pi_symbol":
      return "π";
    case "session": {
      const name = pi.getSessionName();
      return name || "";
    }
    case "cwd": {
      try {
        return path.basename(ctx.cwd || process.cwd());
      } catch {
        return "";
      }
    }
    case "model":
      return state.modelName || "";
    case "thinking":
      return state.thinkingLevel || "";
    case "tokens": {
      if (!state.tokenUsage) return "";
      if (state.tokenUsage >= 1000) return `${(state.tokenUsage / 1000).toFixed(1)}k`;
      return `${state.tokenUsage}`;
    }
    case "turn":
      return state.running ? `${state.turnIndex}` : "";
    case "git_branch":
      return state.gitBranch || "";
    case "tools_count": {
      try {
        const count = pi.getActiveTools().length;
        return count ? `${count}t` : "";
      } catch {
        return "";
      }
    }
    case "current_tool":
      return state.currentTool || "";
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Title builder
// ---------------------------------------------------------------------------

async function refreshGitBranch(state: RuntimeState, pi: ExtensionAPI): Promise<void> {
  try {
    const result = await pi.exec("git", ["branch", "--show-current"], { timeout: 3000 });
    if (result.code === 0) {
      state.gitBranch = result.stdout.trim();
    } else {
      state.gitBranch = "";
    }
  } catch {
    state.gitBranch = "";
  }
}

function buildTitle(config: PiStatusConfig, state: RuntimeState, pi: ExtensionAPI, ctx: ExtensionContext): string {
  const parts: string[] = [];
  for (const comp of config.components) {
    if (!comp.enabled) continue;
    const value = resolveComponentValue(comp.id as ComponentId, state, pi, ctx);
    if (value) {
      parts.push(value);
    }
  }
  return parts.join(config.separator);
}

function setTitle(config: PiStatusConfig, state: RuntimeState, pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (state.destroyed) return;
  if (!ctx.hasUI) return;
  ctx.ui.setTitle(buildTitle(config, state, pi, ctx));
}

function isNameCommand(text: string | undefined): boolean {
  return /^\/name(?:\s|$)/.test(text?.trimStart() ?? "");
}

function isRenameCommand(text: string | undefined): boolean {
  return /^\/rename(?:\s|$)/.test(text?.trimStart() ?? "");
}

function scheduleTitleRefresh(
  configRef: () => PiStatusConfig,
  state: RuntimeState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  if (state.destroyed || !ctx.hasUI || !state.enabled) return;
  if (state.titleRefreshTimer) clearTimeout(state.titleRefreshTimer);
  state.titleRefreshTimer = setTimeout(() => {
    state.titleRefreshTimer = undefined;
    setTitle(configRef(), state, pi, ctx);
  }, 0);
}

function scheduleTitleRefreshWindow(
  configRef: () => PiStatusConfig,
  state: RuntimeState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  durationMs = 35_000,
): void {
  if (state.destroyed || !ctx.hasUI || !state.enabled) return;
  scheduleTitleRefresh(configRef, state, pi, ctx);
  if (state.titleRefreshInterval) clearInterval(state.titleRefreshInterval);
  if (state.titleRefreshStopTimer) clearTimeout(state.titleRefreshStopTimer);
  state.titleRefreshInterval = setInterval(() => {
    setTitle(configRef(), state, pi, ctx);
  }, 250);
  state.titleRefreshStopTimer = setTimeout(() => {
    if (state.titleRefreshInterval) {
      clearInterval(state.titleRefreshInterval);
      state.titleRefreshInterval = undefined;
    }
    state.titleRefreshStopTimer = undefined;
  }, durationMs);
}

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

export default function piStatus(pi: ExtensionAPI) {
  let config = readPiStatusConfig();

  const state: RuntimeState = {
    enabled: !isDisabledByEnv(),
    running: false,
    destroyed: false,
    timer: undefined,
    idleTimer: undefined,
    completionTimer: undefined,
    ghosttyKeepaliveTimer: undefined,
    ghosttySuccessVisible: false,
    terminalInputUnsubscribe: undefined,
    titleRefreshTimer: undefined,
    titleRefreshInterval: undefined,
    titleRefreshStopTimer: undefined,
    frameIndex: 0,
    turnIndex: 0,
    modelName: "",
    thinkingLevel: "",
    gitBranch: "",
    tokenUsage: 0,
    currentTool: "",
  };

  // Initialize thinking level
  try {
    state.thinkingLevel = pi.getThinkingLevel() ?? "";
  } catch {
    // ignore
  }

  function stop(ctx: ExtensionContext): void {
    if (state.destroyed) return;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = undefined;
    }
    if (state.completionTimer) {
      clearTimeout(state.completionTimer);
      state.completionTimer = undefined;
    }
    state.running = false;
    state.frameIndex = 0;
    state.currentTool = "";
    setTitle(config, state, pi, ctx);
    // Schedule recursive re-assert to catch pi-autoname naming (which triggers pi's title override)
    scheduleIdleReassert(ctx, IDLE_REASSERT_START_MS);
  }

  /**
   * Recursively re-check session name and re-apply our title when it changes.
   * Uses exponential backoff: starts at IDLE_REASSERT_START_MS, doubles each
   * check up to IDLE_REASSERT_MAX_MS. This catches pi-autoname's async naming
   * quickly (first check at 200ms) while using minimal resources when idle.
   */
  function scheduleIdleReassert(ctx: ExtensionContext, delay: number): void {
    if (state.destroyed || state.running || !state.enabled || !ctx.hasUI) return;
    state.idleTimer = setTimeout(() => {
      if (state.destroyed || state.running) return;
      // Always re-apply our configured title — pi may have overridden it
      // (e.g. on session_info_changed, rebind, or model switch)
      setTitle(config, state, pi, ctx);
      // Continue with exponential backoff
      scheduleIdleReassert(ctx, Math.min(delay * 2, IDLE_REASSERT_MAX_MS));
    }, delay);
  }

  function cancelIdleReassert(): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
  }

  function start(ctx: ExtensionContext): void {
    if (state.destroyed) return;
    if (!ctx.hasUI || !state.enabled) return;

    // Clean up any previous timer state.
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = undefined;
    }
    if (state.completionTimer) {
      clearTimeout(state.completionTimer);
      state.completionTimer = undefined;
    }
    // Cancel idle re-assert while spinner is running
    cancelIdleReassert();
    state.running = false;
    state.frameIndex = 0;
    state.currentTool = "";

    state.running = true;
    state.turnIndex = 1;

    const tick = () => {
      setTitle(config, state, pi, ctx);
      state.frameIndex++;
    };

    tick();
    state.timer = setInterval(tick, DEFAULT_INTERVAL_MS);
  }

  function ghosttyStopKeepalive(): void {
    if (state.ghosttyKeepaliveTimer) {
      clearInterval(state.ghosttyKeepaliveTimer);
      state.ghosttyKeepaliveTimer = undefined;
    }
  }

  function ghosttyClear(): void {
    ghosttyStopKeepalive();
    if (state.completionTimer) {
      clearTimeout(state.completionTimer);
      state.completionTimer = undefined;
    }
    state.ghosttySuccessVisible = false;
    setGhosttyProgress(0);
  }

  function ghosttyWorking(ctx: ExtensionContext): void {
    if (state.destroyed) return;
    if (!ctx.hasUI || !state.enabled || !config.ghosttySupport) return;
    if (state.completionTimer) {
      clearTimeout(state.completionTimer);
      state.completionTimer = undefined;
    }
    state.ghosttySuccessVisible = false;
    setGhosttyProgress(3);
    if (!state.ghosttyKeepaliveTimer) {
      state.ghosttyKeepaliveTimer = setInterval(() => {
        setGhosttyProgress(3);
      }, GHOSTTY_KEEPALIVE_MS);
    }
  }

  function ghosttyComplete(ctx: ExtensionContext): void {
    if (state.destroyed) return;
    if (!ctx.hasUI || !state.enabled || !config.ghosttySupport) return;
    ghosttyStopKeepalive();
    if (state.completionTimer) {
      clearTimeout(state.completionTimer);
      state.completionTimer = undefined;
    }
    setGhosttyProgress(1, 100);
    state.ghosttySuccessVisible = true;
  }

  function installTerminalInteractionHandler(ctx: ExtensionContext): void {
    if (state.destroyed) return;
    if (!ctx.hasUI || state.terminalInputUnsubscribe) return;
    state.terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      if (data === GHOSTTY_FOCUS_IN) {
        if (state.ghosttySuccessVisible) ghosttyClear();
        return { consume: true };
      }
      if (data === GHOSTTY_FOCUS_OUT) {
        return { consume: true };
      }
      if (matchesKey(data, Key.enter)) {
        const editorText = ctx.ui.getEditorText();
        if (isNameCommand(editorText)) {
          scheduleTitleRefresh(() => config, state, pi, ctx);
        } else if (isRenameCommand(editorText)) {
          scheduleTitleRefreshWindow(() => config, state, pi, ctx);
        }
      }
      if (state.ghosttySuccessVisible) ghosttyClear();
      return undefined;
    });
  }

  // ── Lifecycle events ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (state.destroyed) return;
    // Re-read config on session start (may have changed between sessions)
    config = readPiStatusConfig();

    installTerminalInteractionHandler(ctx);
    if (config.ghosttySupport && ctx.hasUI) enableFocusReporting();

    if (!state.enabled) return;

    // Refresh git branch
    await refreshGitBranch(state, pi);

    // Refresh model from ctx
    if (ctx.model) {
      state.modelName = ctx.model.id || `${ctx.model.provider}/${ctx.model.id}`;
    }

    // Refresh thinking
    try {
      state.thinkingLevel = pi.getThinkingLevel() ?? "";
    } catch { /* ignore */ }

    setTitle(config, state, pi, ctx);
    scheduleIdleReassert(ctx, IDLE_REASSERT_START_MS);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (state.destroyed) return;
    ghosttyWorking(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (state.destroyed) return;
    // Reassert Ghostty progress immediately. Do this before any awaited work
    // so a previous completion-clear timer cannot fire while pi is already working.
    ghosttyWorking(ctx);
    start(ctx);

    // Refresh git branch at start of each prompt
    await refreshGitBranch(state, pi);
    // Refresh token usage
    const usage = ctx.getContextUsage();
    if (usage) state.tokenUsage = usage.tokens ?? 0;
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (state.destroyed) return;
    stop(ctx);
    // In pi 0.75+, agent_end handlers are awaited as part of the active
    // lifecycle, so ctx.isIdle() is still false while this handler is running.
    // Treat agent_end itself as the end-of-run signal; only keep Ghostty in
    // progress mode when pi still reports queued work.
    if (ctx.hasPendingMessages()) {
      ghosttyWorking(ctx);
    } else {
      ghosttyComplete(ctx);
    }
  });

  pi.on("turn_start", async (event, ctx) => {
    if (state.destroyed) return;
    state.turnIndex = event.turnIndex;
    ghosttyWorking(ctx);
  });

  pi.on("context", async (_event, ctx) => {
    if (state.destroyed) return;
    ghosttyWorking(ctx);
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    if (state.destroyed) return;
    ghosttyWorking(ctx);
  });

  pi.on("after_provider_response", async (_event, ctx) => {
    if (state.destroyed) return;
    ghosttyWorking(ctx);
  });

  pi.on("message_start", async (_event, ctx) => {
    if (state.destroyed) return;
    ghosttyWorking(ctx);
  });

  pi.on("message_update", async (_event, ctx) => {
    if (state.destroyed) return;
    ghosttyWorking(ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (state.destroyed) return;
    state.currentTool = event.toolName;
    setTitle(config, state, pi, ctx);
    ghosttyWorking(ctx);
  });

  pi.on("tool_execution_update", async (_event, ctx) => {
    if (state.destroyed) return;
    ghosttyWorking(ctx);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    if (state.destroyed) return;
    state.currentTool = "";
    setTitle(config, state, pi, ctx);
    ghosttyWorking(ctx);
  });

  pi.on("tool_result", async (_event, ctx) => {
    if (state.destroyed) return;
    ghosttyWorking(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (state.destroyed) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) ghosttyWorking(ctx);
  });

  pi.on("model_select", async (event, _ctx) => {
    if (state.destroyed) return;
    state.modelName = event.model.id || `${event.model.provider}/${event.model.id}`;
    // Refresh title if idle
    if (!state.running && state.enabled && _ctx) {
      setTitle(config, state, pi, _ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    cancelIdleReassert();
    stop(ctx);
    ghosttyClear();
    disableFocusReporting();
    if (state.titleRefreshTimer) {
      clearTimeout(state.titleRefreshTimer);
      state.titleRefreshTimer = undefined;
    }
    if (state.titleRefreshInterval) {
      clearInterval(state.titleRefreshInterval);
      state.titleRefreshInterval = undefined;
    }
    if (state.titleRefreshStopTimer) {
      clearTimeout(state.titleRefreshStopTimer);
      state.titleRefreshStopTimer = undefined;
    }
    state.terminalInputUnsubscribe?.();
    state.terminalInputUnsubscribe = undefined;
    state.destroyed = true;
  });

  // ── Command: /pi-status ──────────────────────────────────────────────

  async function handleOn(ctx: ExtensionContext) {
    if (state.destroyed) return;
    state.enabled = true;
    if (state.running) start(ctx);
    else {
      setTitle(config, state, pi, ctx);
      scheduleIdleReassert(ctx, IDLE_REASSERT_START_MS);
    }
    ctx.ui.notify("pi-status enabled", "info");
  }

  async function handleOff(ctx: ExtensionContext) {
    if (state.destroyed) return;
    state.enabled = false;
    cancelIdleReassert();
    stop(ctx);
    ghosttyClear();
    ctx.ui.notify("pi-status disabled", "info");
  }

  async function handleComponents(ctx: ExtensionCommandContext) {
    if (state.destroyed) return;
    const comps = config.components.map((c) => ({ ...c }));

    await ctx.ui.custom((tui, theme, _kb, done) => {
      let cursor = 0;
      let previewFrame = 0;
      const container = new Container();

      const animTimer = setInterval(() => {
        previewFrame++;
        rebuild();
      }, DEFAULT_INTERVAL_MS);

      function cleanup() {
        clearInterval(animTimer);
      }

      function titlePreview(): string {
        const parts: string[] = [];
        for (const c of comps) {
          if (!c.enabled) continue;
          let val: string;
          if (c.id === "spinner") {
            val =
              SPINNER_FRAMES[previewFrame % SPINNER_FRAMES.length] ??
              SPINNER_FRAMES[0]!;
          } else {
            val = resolveComponentValue(c.id as ComponentId, state, pi, ctx);
          }
          if (val) parts.push(val);
        }
        const joined = parts.join(config.separator);
        return joined || theme.fg("dim", "(empty)");
      }

      function rebuild() {
        try {
          container.clear();

          // ── preview (single line) ──
          container.addChild(
            new Text(
              theme.fg("dim", "Preview: ") +
                theme.fg("accent", theme.bold(titlePreview())),
              1,
              0,
            ),
          );

          // ── component list ──
          const maxLabelW = Math.max(
            ...comps.map(
              (c) => (COMPONENT_LABELS[c.id as ComponentId] ?? c.id).length,
            ),
          );
          for (let i = 0; i < comps.length; i++) {
            const c = comps[i]!;
            const checked = c.enabled ? "✓" : " ";
            const label = (COMPONENT_LABELS[c.id as ComponentId] ?? c.id).padEnd(
              maxLabelW,
            );
            const marker = i === cursor ? "›" : " ";
            const line = `${marker} [${checked}] ${label}`;
            container.addChild(
              new Text(i === cursor ? theme.fg("accent", line) : line, 1, 0),
            );
          }

          // ── help ──
          container.addChild(
            new Text(
              theme.fg(
                "dim",
                "↑↓ move   Space toggle   Ctrl+↑/↓ reorder   Enter/Esc done",
              ),
              1,
              0,
            ),
          );

          tui.requestRender();
        } catch {
          // Silently ignore render errors to avoid freezing the TUI.
        }
      }

      function persist() {
        config.components = comps;
        writePiStatusConfig(config);
        setTitle(config, state, pi, ctx);
      }

      rebuild();

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, Key.up)) {
            cursor = Math.max(0, cursor - 1);
            rebuild();
            return;
          }
          if (matchesKey(data, Key.down)) {
            cursor = Math.min(comps.length - 1, cursor + 1);
            rebuild();
            return;
          }
          if (matchesKey(data, Key.space)) {
            comps[cursor]!.enabled = !comps[cursor]!.enabled;
            config.components = comps;
            setTitle(config, state, pi, ctx);
            rebuild();
            return;
          }
          if (matchesKey(data, Key.ctrl("up")) && cursor > 0) {
            [comps[cursor - 1], comps[cursor]] = [
              comps[cursor]!,
              comps[cursor - 1]!,
            ];
            cursor--;
            config.components = comps;
            setTitle(config, state, pi, ctx);
            rebuild();
            return;
          }
          if (
            matchesKey(data, Key.ctrl("down")) &&
            cursor < comps.length - 1
          ) {
            [comps[cursor], comps[cursor + 1]] = [
              comps[cursor + 1]!,
              comps[cursor]!,
            ];
            cursor++;
            config.components = comps;
            setTitle(config, state, pi, ctx);
            rebuild();
            return;
          }
          if (
            matchesKey(data, Key.escape) ||
            matchesKey(data, Key.enter)
          ) {
            cleanup();
            persist();
            done(undefined);
            return;
          }
        },
      };
    });

    ctx.ui.notify("Component settings updated", "info");
  }

  async function handleSeparator(ctx: ExtensionCommandContext) {
    if (state.destroyed) return;
    const newChar = await ctx.ui.input(
      `Current separator: "${config.separator}". Enter new separator:`,
      config.separator,
    );

    if (newChar === undefined || newChar === null) {
      ctx.ui.notify("Separator change cancelled", "warning");
      return;
    }

    if (newChar.length > 5) {
      ctx.ui.notify(
        "Separator too long (max 5 characters). Use a short string like '|', '·', ' - '",
        "error",
      );
      return;
    }

    config.separator = newChar || config.separator;
    writePiStatusConfig(config);
    setTitle(config, state, pi, ctx);
    ctx.ui.notify(`Separator changed to "${config.separator}"`, "info");
  }

  async function handleReset(ctx: ExtensionCommandContext) {
    if (state.destroyed) return;
    const ok = await ctx.ui.confirm(
      "Reset pi-status config?",
      "This restores the default status bar components and separator. Continue?",
    );

    if (!ok) {
      ctx.ui.notify("Reset cancelled", "warning");
      return;
    }

    config = structuredClone(DEFAULT_CONFIG);
    writePiStatusConfig(config);
    state.enabled = !isDisabledByEnv();
    if (state.enabled && !state.running) {
      setTitle(config, state, pi, ctx);
      scheduleIdleReassert(ctx, IDLE_REASSERT_START_MS);
    } else if (!state.enabled) {
      cancelIdleReassert();
    }
    ctx.ui.notify("pi-status config reset to defaults", "info");
  }

  async function handleGhostty(ctx: ExtensionCommandContext, enable: boolean) {
    if (state.destroyed) return;
    config.ghosttySupport = enable;
    writePiStatusConfig(config);
    if (enable) {
      installTerminalInteractionHandler(ctx);
      enableFocusReporting();
    } else {
      ghosttyClear();
      disableFocusReporting();
    }
    ctx.ui.notify(
      `Ghostty support ${enable ? "enabled" : "disabled"}`,
      "info",
    );
  }

  async function showMainMenu(ctx: ExtensionCommandContext) {
    if (state.destroyed) return;
    const action = await ctx.ui.custom<string>((tui, theme, _kb, done) => {
      let cursor = 0;
      const container = new Container();

      const enabledText = (enabled: boolean) =>
        enabled ? theme.fg("success", "enabled") : theme.fg("warning", "disabled");
      const statusText = () => {
        if (!state.enabled && isDisabledByEnv()) {
          return theme.fg("warning", "disabled") + theme.fg("dim", ` by ${DISABLE_ENV}`);
        }
        return enabledText(state.enabled);
      };

      const items = [
        {
          label: (selected: boolean) =>
            `${selected ? theme.fg("accent", "Status: ") : "Status: "}${statusText()}`,
          action: "toggle",
        },
        {
          label: (selected: boolean) =>
            `${selected ? theme.fg("accent", "Ghostty support: ") : "Ghostty support: "}${enabledText(config.ghosttySupport)}`,
          action: "ghostty",
        },
        { label: (selected: boolean) => selected ? theme.fg("accent", "Change components") : "Change components", action: "components" },
        { label: (selected: boolean) => selected ? theme.fg("accent", "Change separator") : "Change separator", action: "separator" },
        { label: (selected: boolean) => selected ? theme.fg("accent", "Reset to defaults") : "Reset to defaults", action: "reset" },
        { label: (selected: boolean) => selected ? theme.fg("accent", "Close") : "Close", action: "close" },
      ];

      function statusLine(): string {
        return "pi-status:";
      }

      function rebuild() {
        try {
          container.clear();
          container.addChild(new Text(statusLine(), 1, 0));
          container.addChild(new Text("", 0, 0));

          for (let i = 0; i < items.length; i++) {
            const item = items[i]!;
            const selected = i === cursor;
            const marker = selected ? theme.fg("accent", "›") : " ";
            const line = `  ${marker} ${item.label(selected)}`;
            container.addChild(new Text(line, 1, 0));
          }

          tui.requestRender();
        } catch {
          // Silently ignore render errors.
        }
      }

      rebuild();

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, Key.up)) {
            cursor = Math.max(0, cursor - 1);
            rebuild();
            return;
          }
          if (matchesKey(data, Key.down)) {
            cursor = Math.min(items.length - 1, cursor + 1);
            rebuild();
            return;
          }
          if (
            matchesKey(data, Key.space) ||
            matchesKey(data, Key.enter)
          ) {
            const item = items[cursor]!;
            if (item.action === "toggle") {
              state.enabled = !state.enabled;
              if (state.enabled) {
                if (state.running) start(ctx);
                else {
                  setTitle(config, state, pi, ctx);
                  scheduleIdleReassert(ctx, IDLE_REASSERT_START_MS);
                }
              } else {
                cancelIdleReassert();
                stop(ctx);
                ghosttyClear();
              }
              rebuild();
              return;
            }
            if (item.action === "ghostty") {
              config.ghosttySupport = !config.ghosttySupport;
              writePiStatusConfig(config);
              if (config.ghosttySupport) {
                installTerminalInteractionHandler(ctx);
                enableFocusReporting();
              } else {
                ghosttyClear();
                disableFocusReporting();
              }
              rebuild();
              return;
            }
            done(item.action);
            return;
          }
          if (matchesKey(data, Key.escape)) {
            done("close");
            return;
          }
        },
      };
    });

    if (action === "components") return handleComponents(ctx);
    if (action === "separator") return handleSeparator(ctx);
    if (action === "reset") return handleReset(ctx);
    // "close" or undefined — nothing further to do.
  }

  pi.registerCommand("pi-status", {
    description:
      "Control the tab title spinner. Subcommands: on, off, components, separator, reset, ghostty [on|off]. " +
      "No argument shows a menu.",
    handler: async (args, ctx) => {
      if (state.destroyed) return;
      const parts = args.trim().toLowerCase().split(/\s+/);
      const sub = parts[0]!;

      switch (sub) {
        case "on":
          return handleOn(ctx);
        case "off":
          return handleOff(ctx);
        case "components":
          return handleComponents(ctx);
        case "separator":
          return handleSeparator(ctx);
        case "reset":
          return handleReset(ctx);
        case "ghostty": {
          const arg = parts[1];
          if (arg === "on") return handleGhostty(ctx, true);
          if (arg === "off") return handleGhostty(ctx, false);
          ctx.ui.notify("Usage: /pi-status ghostty [on|off]", "error");
          return;
        }
        case "status":
        default:
          // Empty or unknown → show the interactive menu.
          return showMainMenu(ctx);
      }
    },
  });
}

// Re-export for config consumers
export { readPiStatusConfig, DEFAULT_CONFIG, ALL_COMPONENT_IDS, COMPONENT_LABELS };
export type { PiStatusConfig, ComponentConfig, ComponentId };
