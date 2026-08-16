import { CodexAppServerProcess } from "./codexAppServerProcess";
import { getRuntimePlatformInfo } from "./runtimePlatform";

type IOUtilsLike = {
  exists?: (path: string) => Promise<boolean>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
  read?: (path: string) => Promise<Uint8Array>;
  remove?: (path: string, options?: { ignoreAbsent?: boolean }) => Promise<void>;
};

type PathUtilsLike = {
  homeDir?: string;
  join?: (...parts: string[]) => string;
};

const LEGACY_CODEX_HOME_DIR = ".llm-for-zotero-legacy";

function getIOUtils(): IOUtilsLike {
  const io =
    (globalThis as { IOUtils?: IOUtilsLike }).IOUtils ||
    (ztoolkit.getGlobal("IOUtils") as IOUtilsLike | undefined);
  if (!io?.exists || !io.makeDirectory || !io.read || !io.remove) {
    throw new Error("IOUtils is unavailable for isolated Codex auth setup");
  }
  return io;
}

function getPathUtils(): PathUtilsLike {
  return (
    (globalThis as { PathUtils?: PathUtilsLike }).PathUtils ||
    (ztoolkit.getGlobal("PathUtils") as PathUtilsLike | undefined) ||
    {}
  );
}

function getProcessEnvironment(): Record<string, string | undefined> {
  const direct = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  const toolkit = (
    ztoolkit.getGlobal("process") as
      | { env?: Record<string, string | undefined> }
      | undefined
  )?.env;
  const env: Record<string, string | undefined> = {
    ...(toolkit || {}),
    ...(direct || {}),
  };
  const services = (
    globalThis as {
      Services?: { env?: { get?: (name: string) => string | undefined } };
    }
  ).Services;
  for (const key of ["CODEX_HOME", "HOME", "USERPROFILE"]) {
    try {
      const value = services?.env?.get?.(key);
      if (typeof value === "string" && value.trim()) {
        env[key] = value.trim();
      }
    } catch {
      /* ignore unavailable environment entries */
    }
  }
  return env;
}

function joinLocalPath(...parts: string[]): string {
  const pathUtils = getPathUtils();
  if (pathUtils.join) return pathUtils.join(...parts);
  const separator = getRuntimePlatformInfo().pathSeparator;
  return parts
    .filter(Boolean)
    .map((part, index) =>
      index === 0
        ? part.replace(/[\\/]+$/, "")
        : part.replace(/^[\\/]+|[\\/]+$/g, ""),
    )
    .join(separator);
}

function resolvePrimaryCodexHome(): string {
  const env = getProcessEnvironment();
  const configured = env.CODEX_HOME?.trim();
  if (configured) return configured;
  const home =
    env.HOME?.trim() ||
    env.USERPROFILE?.trim() ||
    getPathUtils().homeDir?.trim();
  if (!home) {
    throw new Error("Unable to resolve the primary Codex home directory");
  }
  return joinLocalPath(home, ".codex");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function waitForProcess(proc: any): Promise<number | undefined> {
  const result = await proc.wait();
  if (typeof result === "number") return result;
  if (typeof result?.exitCode === "number") return result.exitCode;
  return undefined;
}

async function createAuthHardLink(params: {
  sourcePath: string;
  destinationPath: string;
}): Promise<void> {
  const info = getRuntimePlatformInfo();
  const Subprocess = await CodexAppServerProcess.loadSubprocessModule();
  const invocation =
    info.platform === "windows"
      ? {
          command: info.shellPath,
          arguments: [
            "/d",
            "/c",
            "mklink",
            "/H",
            params.destinationPath,
            params.sourcePath,
          ],
        }
      : {
          command: "/bin/ln",
          arguments: [params.sourcePath, params.destinationPath],
        };
  const proc = await Subprocess.call(invocation);
  const exitCode = await waitForProcess(proc);
  if (exitCode !== undefined && exitCode !== 0) {
    throw new Error(`Unable to create isolated Codex auth link (${exitCode})`);
  }
}

/**
 * Returns a minimal CODEX_HOME that shares only the real login file.
 *
 * A hard link is intentional: Codex refreshes auth.json in place, so both the
 * regular CLI and the isolated legacy transport continue to observe the same
 * credentials without copying tokens into a second independently refreshed
 * file. Config, skills, plugins, and MCP servers remain isolated.
 */
export async function prepareLegacyCodexIsolatedEnvironment(): Promise<
  Record<string, string>
> {
  const io = getIOUtils();
  const primaryHome = resolvePrimaryCodexHome();
  const sourceAuthPath = joinLocalPath(primaryHome, "auth.json");
  if (!(await io.exists!(sourceAuthPath))) {
    throw new Error(
      "Codex auth token not found. Run `codex login` before using the legacy Codex provider.",
    );
  }

  const isolatedHome = joinLocalPath(primaryHome, LEGACY_CODEX_HOME_DIR);
  await io.makeDirectory!(isolatedHome, {
    createAncestors: true,
    ignoreExisting: true,
  });
  const isolatedAuthPath = joinLocalPath(isolatedHome, "auth.json");

  if (await io.exists!(isolatedAuthPath)) {
    const [sourceBytes, isolatedBytes] = await Promise.all([
      io.read!(sourceAuthPath),
      io.read!(isolatedAuthPath),
    ]);
    if (!bytesEqual(sourceBytes, isolatedBytes)) {
      await io.remove!(isolatedAuthPath, { ignoreAbsent: true });
    }
  }
  if (!(await io.exists!(isolatedAuthPath))) {
    await createAuthHardLink({
      sourcePath: sourceAuthPath,
      destinationPath: isolatedAuthPath,
    });
  }

  return { CODEX_HOME: isolatedHome };
}
