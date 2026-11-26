export type AppLogLevel = "error" | "warn" | "info" | "debug" | "trace";

export type AppLogSink = (level: AppLogLevel, args: readonly unknown[]) => void;

export type AppLogger = {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
  isEnabled: (level: AppLogLevel) => boolean;
};

const LOG_LEVEL_PREF = "extensions.zotero.llmforzotero.logLevel";
const LEVEL_RANK: Record<AppLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

let configuredSink: AppLogSink | null = null;

function getZotero():
  | {
      Prefs?: { get?: (key: string, global?: boolean) => unknown };
      debug?: (...args: unknown[]) => void;
    }
  | undefined {
  return (
    globalThis as {
      Zotero?: {
        Prefs?: { get?: (key: string, global?: boolean) => unknown };
        debug?: (...args: unknown[]) => void;
      };
    }
  ).Zotero;
}

export function getAppLogLevel(): AppLogLevel {
  try {
    const value = getZotero()?.Prefs?.get?.(LOG_LEVEL_PREF, true);
    if (typeof value !== "string") return "warn";
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "warn" ||
      normalized === "info" ||
      normalized === "debug" ||
      normalized === "trace"
    ) {
      return normalized;
    }
  } catch {
    // Logging must remain available while preferences are unavailable.
  }
  return "warn";
}

export function isAppLogLevelEnabled(level: AppLogLevel): boolean {
  return LEVEL_RANK[level] <= LEVEL_RANK[getAppLogLevel()];
}

function fallbackSink(level: AppLogLevel, args: readonly unknown[]): void {
  const message = [`[llm-for-zotero] [${level}]`, ...args]
    .map(formatLogValue)
    .join(" ");
  const zotero = getZotero();
  try {
    if (typeof zotero?.debug === "function") {
      zotero.debug.call(zotero, message);
      return;
    }
    const consoleMethod = level === "error" ? console.error : console.warn;
    consoleMethod(message);
  } catch {
    // Logging must never interrupt the operation being observed.
  }
}

export function formatAppLogError(value: {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
}): string {
  const name =
    typeof value.name === "string" && value.name ? value.name : "Error";
  const message =
    typeof value.message === "string"
      ? value.message
      : String(value.message ?? "");
  const summary = `${name}: ${message}`;
  const stack = typeof value.stack === "string" ? value.stack : "";
  if (!stack) return summary;
  return stack.includes(summary) ? stack : `${summary}\n${stack}`;
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return formatAppLogError(value);
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return serialized;
  } catch {
    // Fall back to the host's string conversion for cyclic or exotic values.
  }
  try {
    return String(value);
  } catch {
    return "<unprintable>";
  }
}

function emit(level: AppLogLevel, scope: string, args: unknown[]): void {
  if (!isAppLogLevelEnabled(level)) return;
  const scopedArgs =
    scope && typeof args[0] === "string"
      ? [`${scope}: ${args[0]}`, ...args.slice(1)]
      : args;
  try {
    (configuredSink || fallbackSink)(level, scopedArgs);
  } catch {
    // Logging is best-effort and must not change application control flow.
  }
}

export function createAppLogger(scope = ""): AppLogger {
  return {
    error: (...args) => emit("error", scope, args),
    warn: (...args) => emit("warn", scope, args),
    info: (...args) => emit("info", scope, args),
    debug: (...args) => emit("debug", scope, args),
    trace: (...args) => emit("trace", scope, args),
    isEnabled: isAppLogLevelEnabled,
  };
}

export const appLogger = createAppLogger();

export function setAppLogSink(sink: AppLogSink | null): void {
  configuredSink = sink;
}

/** Narrow Zotero.DB query option seam shared by maintenance owners. */
export function getMaintenanceQueryOptions(): { debug: boolean } {
  return { debug: isAppLogLevelEnabled("trace") };
}
