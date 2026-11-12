import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type ZoteroProfilePaths = {
  profileDir: string;
  runtimeCwd: string;
  stateDir: string;
};

export type LegacyAdapterPaths = {
  homeDir: string;
  zoteroRoot: string;
  runtimeCwd: string;
  stateDir: string;
};

type IniSection = {
  name: string;
  values: Record<string, string>;
};

function parseIniSections(raw: string): IniSection[] {
  const sections: IniSection[] = [];
  let current: IniSection | null = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      current = { name: sectionMatch[1].trim(), values: {} };
      sections.push(current);
      continue;
    }
    const kvMatch = line.match(/^([^=]+)=(.*)$/);
    if (!kvMatch || !current) continue;
    current.values[kvMatch[1].trim()] = kvMatch[2].trim();
  }
  return sections;
}

export function resolveLegacyAdapterPaths(
  homeDirInput?: string,
  cwdInput?: string,
): LegacyAdapterPaths {
  const homeDir = (homeDirInput || homedir()).trim();
  const cwd = resolve(cwdInput || process.cwd());
  const zoteroRoot = homeDir ? resolve(homeDir, "Zotero") : cwd;
  const hasLegacyZoteroRoot = homeDir ? existsSync(zoteroRoot) : false;
  return {
    homeDir,
    zoteroRoot,
    runtimeCwd: hasLegacyZoteroRoot
      ? resolve(zoteroRoot, "agent-runtime")
      : cwd,
    stateDir: hasLegacyZoteroRoot
      ? resolve(zoteroRoot, "agent-state")
      : homeDir
        ? resolve(homeDir, "agent-state")
        : resolve(cwd, ".adapter-state"),
  };
}

export function resolveDefaultZoteroProfilePaths(
  homeDirInput?: string,
): ZoteroProfilePaths | null {
  const homeDir = (homeDirInput || homedir()).trim();
  if (!homeDir) return null;
  const zoteroAppDir = resolve(
    homeDir,
    "Library",
    "Application Support",
    "Zotero",
  );
  const profilesIni = resolve(zoteroAppDir, "profiles.ini");
  if (!existsSync(profilesIni)) return null;
  try {
    const raw = readFileSync(profilesIni, "utf8");
    const sections = parseIniSections(raw);
    const profileSection =
      sections.find(
        (section) =>
          /^Profile\d+$/i.test(section.name) && section.values.Default === "1",
      ) || sections.find((section) => /^Profile\d+$/i.test(section.name));
    if (!profileSection) return null;
    const profilePath = profileSection.values.Path?.trim();
    if (!profilePath) return null;
    const isRelative = profileSection.values.IsRelative !== "0";
    const profileDir = isRelative
      ? resolve(zoteroAppDir, profilePath)
      : resolve(profilePath);
    return {
      profileDir,
      runtimeCwd: resolve(profileDir, "agent-runtime"),
      stateDir: resolve(profileDir, "agent-state"),
    };
  } catch {
    return null;
  }
}
