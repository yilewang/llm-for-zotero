import { getRuntimeModelEntries } from "../utils/modelProviders";
import { resolveCodexAppServerBinaryPath } from "../utils/codexAppServerProcess";
import { getCodexBinaryPathPref } from "./prefs";

function getCodexAppServerProviderBinaryPath(): string {
  for (const entry of getRuntimeModelEntries()) {
    if (entry.authMode !== "codex_app_server") continue;
    const path = resolveCodexAppServerBinaryPath(entry.apiBase);
    if (path) return path;
  }
  return "";
}

export function getConfiguredCodexAppServerBinaryPath(): string {
  return getEffectiveCodexAppServerBinaryPath();
}

export function getEffectiveCodexAppServerBinaryPath(
  preferredPath?: string | null,
): string {
  return (
    resolveCodexAppServerBinaryPath(preferredPath) ||
    resolveCodexAppServerBinaryPath(getCodexBinaryPathPref()) ||
    getCodexAppServerProviderBinaryPath()
  );
}

/**
 * The codex binary of the app-server process that Codex conversations share,
 * from the caller's path or else the configured one (the same resolution as
 * getEffectiveCodexAppServerBinaryPath). The process pool keys processes by
 * this path, so every turn, thread operation and catalog read for the same
 * codex lands on one process. A thread has one writer process: an archive
 * sent to a second process fails with "already has an active writer".
 */
export function resolveSharedCodexAppServerPath(
  codexPath?: string | null,
): string | undefined {
  return getEffectiveCodexAppServerBinaryPath(codexPath) || undefined;
}
