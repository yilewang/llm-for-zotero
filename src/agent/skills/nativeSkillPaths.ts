import { joinLocalPath } from "../../utils/localPath";

export const NATIVE_SKILL_FILE_NAME = "SKILL.md";

type ZoteroLike = {
  DataDirectory?: { dir?: string };
  Profile?: { dir?: string };
};

function getZoteroLike(): ZoteroLike {
  return (globalThis as unknown as { Zotero?: ZoteroLike }).Zotero || {};
}

export function buildSkillProfileSignature(profileDir: string): string {
  const normalized = profileDir.trim().replace(/\\/g, "/");
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `profile-${(hash >>> 0).toString(16)}`;
}

export function getSkillStorageBaseDir(): string {
  const zotero = getZoteroLike();
  const dataDir = zotero.DataDirectory?.dir;
  if (typeof dataDir === "string" && dataDir.trim()) return dataDir.trim();
  const profileDir = zotero.Profile?.dir;
  if (typeof profileDir === "string" && profileDir.trim()) {
    return profileDir.trim();
  }
  throw new Error("Cannot resolve Zotero data directory for skills");
}

export function getSkillProfileSignature(): string {
  const zotero = getZoteroLike();
  const profileDir =
    typeof zotero.Profile?.dir === "string" && zotero.Profile.dir.trim()
      ? zotero.Profile.dir.trim()
      : getSkillStorageBaseDir();
  return buildSkillProfileSignature(profileDir);
}

export function getZoteroAgentRuntimeRootDir(): string {
  return joinLocalPath(
    getSkillStorageBaseDir(),
    "agent-runtime",
    getSkillProfileSignature(),
  );
}

export function getCanonicalUserSkillsDir(): string {
  return joinLocalPath(getZoteroAgentRuntimeRootDir(), ".agents", "skills");
}

export function getLegacyUserSkillsDir(): string {
  return joinLocalPath(getSkillStorageBaseDir(), "llm-for-zotero", "skills");
}

export function getCanonicalSkillDir(skillId: string): string {
  return joinLocalPath(getCanonicalUserSkillsDir(), skillId);
}

export function getCanonicalSkillFilePath(skillId: string): string {
  return joinLocalPath(getCanonicalSkillDir(skillId), NATIVE_SKILL_FILE_NAME);
}
