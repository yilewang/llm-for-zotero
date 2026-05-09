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
