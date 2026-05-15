export type RuntimePlatform = "windows" | "macos" | "linux";

export type RuntimePlatformInfo = {
  platform: RuntimePlatform;
  label: string;
  shellPath: string;
  shellName: string;
  shellFlag: "-c" | "/c";
  pathSeparator: "/" | "\\";
  homeReference: string;
  listFilesExample: string;
  findPdfExample: string;
};

function resolveRuntimePlatform(): RuntimePlatform {
  const zotero = (
    globalThis as { Zotero?: { isWin?: boolean; isMac?: boolean } }
  ).Zotero;
  if (zotero?.isWin) return "windows";
  if (zotero?.isMac) return "macos";

  if (typeof navigator !== "undefined") {
    const navPlatform = (navigator.platform || "").toLowerCase();
    if (navPlatform.includes("win")) return "windows";
    if (navPlatform.includes("mac")) return "macos";
  }

  const processPlatform = (globalThis as { process?: { platform?: string } })
    .process?.platform;
  if (processPlatform === "win32") return "windows";
  if (processPlatform === "darwin") return "macos";
  return "linux";
}

function resolveWindowsSystemRoot(): string {
  const servicesRoot = (
    globalThis as {
      Services?: { env?: { get?: (name: string) => string | undefined } };
    }
  ).Services?.env?.get?.("SystemRoot");
  if (typeof servicesRoot === "string" && servicesRoot.trim()) {
    return servicesRoot.trim();
  }

  const envRoot = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env?.SystemRoot;
  if (typeof envRoot === "string" && envRoot.trim()) {
    return envRoot.trim();
  }

  return "C:\\Windows";
}

export function getRuntimePlatformInfo(): RuntimePlatformInfo {
  const platform = resolveRuntimePlatform();
  if (platform === "windows") {
    const systemRoot = resolveWindowsSystemRoot();
    return {
      platform,
      label: "Windows",
      shellPath: `${systemRoot}\\System32\\cmd.exe`,
      shellName: "cmd.exe",
      shellFlag: "/c",
      pathSeparator: "\\",
      homeReference: "%USERPROFILE%",
      listFilesExample: "dir %USERPROFILE%\\Desktop",
      findPdfExample: "dir %USERPROFILE%\\Desktop\\*.pdf",
    };
  }
  if (platform === "macos") {
    return {
      platform,
      label: "macOS",
      shellPath: "/bin/zsh",
      shellName: "zsh",
      shellFlag: "-c",
      pathSeparator: "/",
      homeReference: "~",
      listFilesExample: "ls ~/Desktop",
      findPdfExample: "ls ~/Desktop/*.pdf",
    };
  }
  return {
    platform,
    label: "Linux",
    shellPath: "/bin/bash",
    shellName: "bash",
    shellFlag: "-c",
    pathSeparator: "/",
    homeReference: "~",
    listFilesExample: "ls ~/Desktop",
    findPdfExample: 'find ~/Desktop -name "*.pdf"',
  };
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function buildRuntimePlatformGuidanceText(
  info: RuntimePlatformInfo = getRuntimePlatformInfo(),
  now: Date = new Date(),
): string {
  return [
    "Local shell environment:",
    `- Platform: ${info.label}`,
    `- Shell: ${info.shellPath} (${info.shellName})`,
    `- Native path separator: ${info.pathSeparator}`,
    `- Home path shorthand: ${info.homeReference}`,
    `- Current local date: ${formatLocalDate(now)}`,
    `- Example directory listing: ${info.listFilesExample}`,
    `- Example PDF discovery: ${info.findPdfExample}`,
    "Use the native shell syntax and native path separators for this platform when working with local files.",
  ].join("\n");
}
