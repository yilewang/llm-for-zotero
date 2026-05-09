import { config } from "../../../package.json";

type SubprocessProc = {
  pid?: number;
  stdin?: { close?: () => Promise<void> | void };
  kill?: () => void;
  wait?: () => Promise<{ exitCode: number }>;
};

let spawnedProc: SubprocessProc | null = null;
let spawnedPid: number | null = null;
let spawnedAt = 0;

function getBoolPref(key: string, fallback: boolean): boolean {
  try {
    const v = Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true);
    if (typeof v === "boolean") return v;
    if (typeof v === "string")
      return v.trim().toLowerCase() === "true" ? true : false;
    return fallback;
  } catch {
    return fallback;
  }
}

function getStringPref(key: string): string {
  try {
    const v = Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true);
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

function parsePort(bridgeUrl: string): number {
  try {
    const u = new URL(bridgeUrl);
    const p = Number.parseInt(u.port || "19787", 10);
    return Number.isFinite(p) ? p : 19787;
  } catch {
    return 19787;
  }
}

async function isBridgeReachable(
  bridgeUrl: string,
  timeoutMs = 1500,
): Promise<boolean> {
  try {
    const ctrl =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    const normalized = bridgeUrl.replace(/\/$/, "");
    const res = await fetch(`${normalized}/healthz`, {
      method: "GET",
      signal: ctrl?.signal,
    });
    if (timer) clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function loadSubprocess(): Promise<unknown | null> {
  try {
    const CU = (globalThis as { ChromeUtils?: { importESModule?: (url: string) => Record<string, unknown>; import?: (url: string) => Record<string, unknown> } }).ChromeUtils;
    if (CU?.importESModule) {
      try {
        const mod = CU.importESModule(
          "resource://gre/modules/Subprocess.sys.mjs",
        );
        return (mod as Record<string, unknown>).Subprocess || mod.default || mod;
      } catch {
        /* fallthrough */
      }
    }
    if (CU?.import) {
      const mod = CU.import("resource://gre/modules/Subprocess.jsm");
      return (mod as Record<string, unknown>).Subprocess || mod;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Convention: the adapter checkout sits as a sibling of Zotero's
// `agent-runtime/` and `agent-state/` directories, i.e. directly under the
// Zotero install root. Deriving zoteroRoot = dirname(adapterPath) lets us
// drive the bridge on machines whose Zotero install isn't at the adapter's
// `${HOME}/Zotero` default (notably custom-drive Windows installs).
function deriveZoteroRoot(adapterPath: string): string {
  const trimmed = adapterPath.replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx > 0 ? trimmed.substring(0, idx) : "";
}

function isWindows(): boolean {
  try {
    const z = Zotero as unknown as { isWin?: boolean };
    if (typeof z.isWin === "boolean") return z.isWin;
  } catch {
    /* ignore */
  }
  try {
    const nav = (globalThis as { navigator?: { platform?: string } }).navigator;
    const plat = nav?.platform?.toLowerCase() || "";
    if (plat.includes("win")) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export type SpawnAdapterResult =
  | { spawned: true; pid: number | null }
  | { spawned: false; reason: string };

export async function maybeSpawnAdapter(params: {
  bridgeUrl: string;
  adapterPath: string;
}): Promise<SpawnAdapterResult> {
  const { bridgeUrl, adapterPath } = params;
  if (!adapterPath) {
    return { spawned: false, reason: "adapterPath is empty" };
  }

  if (await isBridgeReachable(bridgeUrl)) {
    return { spawned: false, reason: "bridge already reachable" };
  }

  const Subprocess = (await loadSubprocess()) as
    | {
        call?: (opts: {
          command: string;
          arguments: string[];
          workdir?: string;
          environment?: Record<string, string>;
          environmentAppend?: boolean;
        }) => Promise<SubprocessProc>;
      }
    | null;

  if (!Subprocess?.call) {
    return { spawned: false, reason: "Subprocess API unavailable" };
  }

  const zoteroRoot = deriveZoteroRoot(adapterPath);
  let command: string;
  let args: string[];
  if (isWindows()) {
    command = "C:\\Windows\\System32\\cmd.exe";
    args = ["/c", "npm", "run", "serve:bridge"];
    if (zoteroRoot) {
      // npm forwards args after `--` to the underlying script.
      args.push("--", "--zotero-root", zoteroRoot);
    }
  } else {
    command = "/bin/sh";
    const tail = zoteroRoot
      ? ` -- --zotero-root '${zoteroRoot.replace(/'/g, "'\\''")}'`
      : "";
    args = ["-c", `npm run serve:bridge${tail}`];
  }

  try {
    const proc = await Subprocess.call({
      command,
      arguments: args,
      workdir: adapterPath,
      environmentAppend: true,
    });
    spawnedProc = proc;
    spawnedPid = typeof proc.pid === "number" ? proc.pid : null;
    spawnedAt = Date.now();

    // Wait up to 20s for healthz to become reachable
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await isBridgeReachable(bridgeUrl, 800)) {
        return { spawned: true, pid: spawnedPid };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return {
      spawned: true,
      pid: spawnedPid,
    };
  } catch (err) {
    return {
      spawned: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function stopSpawnedAdapter(): Promise<void> {
  if (!spawnedProc) return;
  const proc = spawnedProc;
  const pid = spawnedPid;
  spawnedProc = null;
  spawnedPid = null;
  spawnedAt = 0;

  try {
    proc.kill?.();
  } catch {
    /* ignore */
  }

  // Windows: Subprocess.kill only kills cmd.exe, not the node child.
  // Use taskkill /T to kill the whole tree.
  if (isWindows() && typeof pid === "number") {
    try {
      const Subprocess = (await loadSubprocess()) as
        | {
            call?: (opts: {
              command: string;
              arguments: string[];
            }) => Promise<SubprocessProc>;
          }
        | null;
      if (Subprocess?.call) {
        const killer = await Subprocess.call({
          command: "C:\\Windows\\System32\\taskkill.exe",
          arguments: ["/PID", String(pid), "/T", "/F"],
        });
        try {
          await killer.wait?.();
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
}

export function getSpawnedAdapterState(): {
  spawned: boolean;
  pid: number | null;
  spawnedAt: number;
} {
  return {
    spawned: !!spawnedProc,
    pid: spawnedPid,
    spawnedAt,
  };
}
