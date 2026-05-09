declare const Zotero: any;

import { joinLocalPath } from "../utils/localPath";

export type ClaudeProjectSkillEntry = {
  name: string;
  filePath: string;
  openPath: string;
  description: string;
};

type IOUtilsLike = {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<Uint8Array<ArrayBufferLike> | ArrayBuffer>;
  write?: (path: string, data: Uint8Array<ArrayBufferLike>) => Promise<number>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
  getChildren?: (path: string) => Promise<string[]>;
  remove?: (
    path: string,
    options?: { recursive?: boolean; ignoreAbsent?: boolean },
  ) => Promise<void>;
};

type ProcessLike = { env?: Record<string, string | undefined> };
type PathUtilsLike = { homeDir?: string };
type ServicesLike = {
  dirsvc?: {
    get?: (key: string, iface?: unknown) => { path?: string } | undefined;
  };
};
type OSLike = {
  Constants?: {
    Path?: {
      homeDir?: string;
    };
  };
};

function getToolkitGlobal<T>(name: string): T | undefined {
  const toolkit = (globalThis as { ztoolkit?: { getGlobal?: (key: string) => unknown } })
    .ztoolkit;
  if (!toolkit?.getGlobal) return undefined;
  return toolkit.getGlobal(name) as T | undefined;
}

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils ||
    getToolkitGlobal<IOUtilsLike>("IOUtils");
}

function getProcess(): ProcessLike | undefined {
  const fromGlobal = (globalThis as { process?: ProcessLike }).process;
  if (fromGlobal?.env) return fromGlobal;
  return getToolkitGlobal<ProcessLike>("process")?.env
    ? getToolkitGlobal<ProcessLike>("process")
    : undefined;
}

function getPathUtils(): PathUtilsLike | undefined {
  const fromGlobal = (globalThis as { PathUtils?: PathUtilsLike }).PathUtils;
  if (fromGlobal?.homeDir) return fromGlobal;
  return getToolkitGlobal<PathUtilsLike>("PathUtils");
}

function getServices(): ServicesLike | undefined {
  const fromGlobal = (globalThis as { Services?: ServicesLike }).Services;
  if (fromGlobal?.dirsvc?.get) return fromGlobal;
  return getToolkitGlobal<ServicesLike>("Services");
}

function getOS(): OSLike | undefined {
  const fromGlobal = (globalThis as { OS?: OSLike }).OS;
  if (fromGlobal?.Constants?.Path?.homeDir) return fromGlobal;
  return getToolkitGlobal<OSLike>("OS");
}

function getNsIFile(): unknown {
  const ci = (globalThis as { Ci?: { nsIFile?: unknown } }).Ci;
  if (ci?.nsIFile) return ci.nsIFile;
  const components = (globalThis as {
    Components?: { interfaces?: { nsIFile?: unknown } };
  }).Components;
  return components?.interfaces?.nsIFile;
}

function getZoteroDataDir(): string | null {
  const dataDir = (
    Zotero as unknown as { DataDirectory?: { dir?: string } }
  ).DataDirectory?.dir?.trim();
  return dataDir || null;
}

export function getClaudeUserHomeDir(): string {
  const env = getProcess()?.env;
  const home =
    env?.HOME?.trim() ||
    env?.USERPROFILE?.trim() ||
    getPathUtils()?.homeDir?.trim() ||
    getOS()?.Constants?.Path?.homeDir?.trim() ||
    getServices()?.dirsvc?.get?.("Home", getNsIFile())?.path?.trim() ||
    (Zotero as unknown as { Profile?: { dir?: string } }).Profile?.dir?.trim() ||
    "";
  if (home) return home;
  throw new Error("Cannot resolve home directory for Claude runtime root");
}

export function getClaudeProfileDir(): string {
  const profileDir = (Zotero as unknown as { Profile?: { dir?: string } }).Profile?.dir?.trim();
  if (profileDir) return profileDir;
  throw new Error("Cannot resolve Zotero profile directory for Claude runtime root");
}

export function buildClaudeProfileSignature(profileDir: string): string {
  const normalized = profileDir.trim().replace(/\\/g, "/");
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `profile-${(hash >>> 0).toString(16)}`;
}

export function getClaudeProfileSignature(): string {
  return buildClaudeProfileSignature(getClaudeProfileDir());
}

export function getClaudeRuntimeRootDir(): string {
  const dataDir = getZoteroDataDir();
  if (dataDir) {
    return joinLocalPath(
      dataDir,
      "agent-runtime",
      getClaudeProfileSignature(),
    );
  }
  return joinLocalPath(
    getClaudeUserHomeDir(),
    "Zotero",
    "agent-runtime",
    getClaudeProfileSignature(),
  );
}

export function getClaudeProjectDir(): string {
  return joinLocalPath(getClaudeRuntimeRootDir(), ".claude");
}

export function getClaudeProjectSkillsDir(): string {
  return joinLocalPath(getClaudeProjectDir(), "skills");
}

export function getClaudeProjectCommandsDir(): string {
  return joinLocalPath(getClaudeProjectDir(), "commands");
}

export function getClaudeProjectInstructionFile(): string {
  return joinLocalPath(getClaudeRuntimeRootDir(), "CLAUDE.md");
}

export function getClaudeProjectSettingsFile(): string {
  return joinLocalPath(getClaudeProjectDir(), "settings.json");
}

function parseDescription(raw: string): string {
  const match = raw.match(/^description:\s*(.+)$/m);
  if (match?.[1]?.trim()) return match[1].trim();
  return "Claude Code project skill";
}

function parseCommandName(raw: string, fallback: string): string {
  const skillName = raw.match(/^name:\s*([a-z0-9-]+)$/m)?.[1]?.trim();
  if (skillName) return skillName;
  const normalized = fallback.replace(/\.md$/i, "").trim();
  return normalized || "custom-skill";
}

async function ensureDir(path: string): Promise<void> {
  const io = getIOUtils();
  if (!io?.makeDirectory) return;
  await io.makeDirectory(path, { createAncestors: true, ignoreExisting: true });
}

export async function ensureClaudeProjectSkillStructure(): Promise<void> {
  await ensureDir(getClaudeProjectDir());
  await ensureDir(getClaudeProjectSkillsDir());
  await ensureDir(getClaudeProjectCommandsDir());
}

export async function listClaudeProjectSkillEntries(): Promise<ClaudeProjectSkillEntry[]> {
  const io = getIOUtils();
  if (!io?.exists || !io?.read || !io?.getChildren) return [];
  await ensureClaudeProjectSkillStructure();
  const skillsDir = getClaudeProjectSkillsDir();
  const commandsDir = getClaudeProjectCommandsDir();
  const entries: ClaudeProjectSkillEntry[] = [];

  const readMarkdownEntry = async (filePath: string, fallback: string): Promise<void> => {
    const data = await io.read?.(filePath);
    if (!data) return;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const raw = new TextDecoder("utf-8").decode(bytes);
    const isSkillFile = /[\\/]SKILL\.md$/i.test(filePath);
    entries.push({
      name: parseCommandName(raw, fallback),
      filePath,
      openPath: isSkillFile ? filePath.replace(/[\\/]SKILL\.md$/i, "") : filePath,
      description: parseDescription(raw),
    });
  };

  const walkSkillDirs = async (dirPath: string): Promise<void> => {
    let children: string[] = [];
    try {
      children = (await io.getChildren?.(dirPath)) || [];
    } catch {
      return;
    }
    for (const childPath of children) {
      const skillFile = joinLocalPath(childPath, "SKILL.md");
      if (await io.exists?.(skillFile)) {
        const skillName = childPath.split(/[\\/]/).pop() || "";
        if (skillName) {
          await readMarkdownEntry(skillFile, skillName);
        }
        continue;
      }
      await walkSkillDirs(childPath);
    }
  };

  try {
    if (await io.exists(skillsDir)) {
      await walkSkillDirs(skillsDir);
    }
  } catch {
    // ignore and continue to commands
  }

  try {
    if (await io.exists(commandsDir)) {
      const commandFiles = await io.getChildren(commandsDir);
      for (const filePath of commandFiles) {
        if (!filePath.endsWith(".md")) continue;
        const filename = filePath.split(/[\\/]/).pop() || filePath;
        await readMarkdownEntry(filePath, filename);
      }
    }
  } catch {
    // ignore
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createClaudeProjectSkillTemplate(): Promise<string | null> {
  const io = getIOUtils();
  if (!io?.exists || !io?.write || !io?.makeDirectory) return null;
  await ensureClaudeProjectSkillStructure();
  const encoder = new TextEncoder();
  let index = 1;
  while (index <= 999) {
    const dirPath = joinLocalPath(getClaudeProjectSkillsDir(), `zotero-skill-${index}`);
    const filePath = joinLocalPath(dirPath, "SKILL.md");
    const exists = await io.exists(filePath).catch(() => false);
    if (!exists) {
      await io.makeDirectory(dirPath, { createAncestors: true, ignoreExisting: true });
      const template = `---
name: zotero-skill-${index}
description: Claude Code skill for Zotero runtime
---

Describe when Claude should use this Zotero-specific skill.`;
      await io.write(filePath, encoder.encode(template));
      return filePath;
    }
    index += 1;
  }
  return null;
}

export async function deleteClaudeProjectSkillFile(filePath: string): Promise<boolean> {
  const io = getIOUtils();
  if (!io?.remove) return false;
  try {
    const normalizedPath = filePath.trim();
    const normalizedSkillsDir = getClaudeProjectSkillsDir();
    const isSkillEntry = /[\\/]SKILL\.md$/i.test(normalizedPath) &&
      normalizedPath.startsWith(normalizedSkillsDir);
    if (isSkillEntry) {
      const skillDir = normalizedPath.replace(/[\\/]SKILL\.md$/i, "");
      await io.remove(skillDir, { recursive: true, ignoreAbsent: true });
      return true;
    }
    await io.remove(normalizedPath, { ignoreAbsent: true });
    return true;
  } catch {
    return false;
  }
}
