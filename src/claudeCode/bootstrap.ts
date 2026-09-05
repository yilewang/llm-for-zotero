import {
  ensureClaudeProjectSkillStructure,
  getClaudeProjectInstructionFile,
  getClaudeProjectCommandsDir,
  getClaudeProjectSettingsFile,
  getClaudeProjectSkillsDir,
  getClaudeRuntimeRootDir,
} from "./projectSkills";
import { getClaudeManagedInstructionTemplatePref } from "./prefs";

type IOUtilsLike = {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<Uint8Array<ArrayBufferLike> | ArrayBuffer>;
  write?: (path: string, data: Uint8Array<ArrayBufferLike>) => Promise<number>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
};

const MANAGED_BEGIN_MARKER = "<!-- LLM-FOR-ZOTERO:CLAUDE-MANAGED-BEGIN -->";
const MANAGED_END_MARKER = "<!-- LLM-FOR-ZOTERO:CLAUDE-MANAGED-END -->";
const CLAUDE_MANAGED_CONTRACT_VERSION = 2;
const CLAUDE_MANAGED_VERSION_MARKER = `<!-- LLM-FOR-ZOTERO:CLAUDE-CONTRACT-VERSION:${CLAUDE_MANAGED_CONTRACT_VERSION} -->`;
const CLAUDE_MANAGED_FINGERPRINT_PREFIX =
  "<!-- LLM-FOR-ZOTERO:CLAUDE-STOCK-FINGERPRINT:";
// Behavior-section fingerprints for the two unmodified v1 stock templates.
const KNOWN_STOCK_BEHAVIOR_FINGERPRINTS = new Set([
  "fnv1a32-15002f10",
  "fnv1a32-bcaf2d1b",
]);

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
}

function getBootstrapSettingsTemplate(): string {
  return (
    JSON.stringify(
      {
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        permissions: {
          defaultMode: "default",
        },
        env: {
          ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        },
        enabledPlugins: {},
      },
      null,
      2,
    ) + "\n"
  );
}

function getConfigModelInstructionLines(): string[] {
  const runtimeRoot = getClaudeRuntimeRootDir();
  const settingsFile = getClaudeProjectSettingsFile();
  const skillsDir = getClaudeProjectSkillsDir();
  const commandsDir = getClaudeProjectCommandsDir();
  return [
    "## Config model",
    `- Shared Zotero profile runtime root: \`${runtimeRoot}\`.`,
    `- Project-level Claude config for this Zotero profile lives in \`${settingsFile}\`.`,
    `- Shared Zotero skills go in \`${skillsDir}/\`; shared commands go in \`${commandsDir}/\`.`,
    "- Different Zotero profiles use different Claude runtime roots and different local conversation folders.",
    "- Local config is scoped to the current conversation runtime folder under the profile runtime root.",
  ];
}

export function getDefaultClaudeManagedInstructionBlock(): string {
  const fingerprintless = [
    "# Claude Code in Zotero",
    CLAUDE_MANAGED_VERSION_MARKER,
    "",
    "This managed block contains stable profile configuration only.",
    "Live Zotero behavior, citation rules, tool routing, selected resources, and model limitations are supplied by the bridge on each turn.",
    "",
    ...getConfigModelInstructionLines(),
  ].join("\n");
  const lines = fingerprintless.split("\n");
  lines.splice(
    2,
    0,
    `${CLAUDE_MANAGED_FINGERPRINT_PREFIX}${fingerprintText(fingerprintless)} -->`,
  );
  return lines.join("\n");
}

function normalizeManagedInstructionBlockContent(content: string): string {
  return String(content || "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function fingerprintText(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function behaviorSectionForFingerprint(content: string): string {
  const normalized = normalizeManagedInstructionBlockContent(content);
  const configIndex = normalized.indexOf("\n## Config model");
  return (
    configIndex >= 0 ? normalized.slice(0, configIndex) : normalized
  ).trim();
}

function hasValidStockFingerprint(content: string): boolean {
  const normalized = normalizeManagedInstructionBlockContent(content);
  const fingerprintPattern = new RegExp(
    `^${CLAUDE_MANAGED_FINGERPRINT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\s>]+) -->$`,
    "m",
  );
  const match = normalized.match(fingerprintPattern);
  if (!match) return false;
  const fingerprintless = normalized
    .replace(`${match[0]}\n`, "")
    .replace(`\n${match[0]}`, "")
    .trim();
  return fingerprintText(fingerprintless) === match[1];
}

function isKnownStockInstructionBlock(content: string): boolean {
  const normalized = normalizeManagedInstructionBlockContent(content);
  const managed = extractManagedInstructionBlock(normalized) || normalized;
  if (hasValidStockFingerprint(managed)) return true;
  return KNOWN_STOCK_BEHAVIOR_FINGERPRINTS.has(
    fingerprintText(behaviorSectionForFingerprint(managed)),
  );
}

function getManagedInstructionBlockFromSettings(): string {
  return (
    normalizeManagedInstructionBlockContent(
      getClaudeManagedInstructionTemplatePref(),
    ) || getDefaultClaudeManagedInstructionBlock()
  );
}

function getBootstrapInstructionTemplate(
  managedBlock = getManagedInstructionBlockFromSettings(),
): string {
  return `${MANAGED_BEGIN_MARKER}\n${managedBlock}\n${MANAGED_END_MARKER}\n`;
}

function upgradeManagedInstructionBlock(content: string): string {
  const normalized = normalizeManagedInstructionBlockContent(content);
  if (!normalized) return getDefaultClaudeManagedInstructionBlock();
  if (isKnownStockInstructionBlock(normalized)) {
    return getDefaultClaudeManagedInstructionBlock();
  }
  if (normalized.includes("Shared Zotero profile runtime root:")) {
    return normalized;
  }
  const configModelIndex = normalized.indexOf("\n## Config model");
  const configModelAtStart = normalized.startsWith("## Config model");
  const replacement = getConfigModelInstructionLines().join("\n");
  if (configModelIndex >= 0) {
    return `${normalized.slice(0, configModelIndex)}\n${replacement}`;
  }
  if (configModelAtStart) {
    return replacement;
  }
  return `${normalized}\n\n${replacement}`;
}

export function upgradeManagedInstructionBlockForTests(
  content: string,
): string {
  return upgradeManagedInstructionBlock(content);
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  const io = getIOUtils();
  if (!io?.exists || !io?.write) return;
  const exists = await io.exists(path).catch(() => false);
  if (exists) return;
  await io.write(path, new TextEncoder().encode(content));
}

function extractManagedInstructionBlock(onDiskRaw: string): string | null {
  const beginIdx = onDiskRaw.indexOf(MANAGED_BEGIN_MARKER);
  const endIdx = onDiskRaw.indexOf(MANAGED_END_MARKER);
  if (beginIdx < 0 || endIdx <= beginIdx) return null;
  const content = onDiskRaw.slice(
    beginIdx + MANAGED_BEGIN_MARKER.length,
    endIdx,
  );
  const normalized = normalizeManagedInstructionBlockContent(content);
  return normalized || null;
}

function spliceManagedInstructionBlock(
  onDiskRaw: string,
  managedBlock: string,
): string {
  const beginIdx = onDiskRaw.indexOf(MANAGED_BEGIN_MARKER);
  const endIdx = onDiskRaw.indexOf(MANAGED_END_MARKER);
  if (beginIdx >= 0 && endIdx > beginIdx) {
    const before = onDiskRaw.slice(0, beginIdx);
    const after = onDiskRaw.slice(endIdx + MANAGED_END_MARKER.length);
    return `${before}${MANAGED_BEGIN_MARKER}\n${managedBlock}\n${MANAGED_END_MARKER}${after}`;
  }
  const trimmed = onDiskRaw.trimEnd();
  const prefix = trimmed ? `${trimmed}\n\n` : "";
  return `${prefix}${MANAGED_BEGIN_MARKER}\n${managedBlock}\n${MANAGED_END_MARKER}\n`;
}

async function ensureManagedClaudeInstructionBlock(): Promise<void> {
  const io = getIOUtils();
  if (!io?.exists || !io?.write || !io?.read) {
    await writeIfMissing(
      getClaudeProjectInstructionFile(),
      getBootstrapInstructionTemplate(),
    );
    return;
  }
  const path = getClaudeProjectInstructionFile();
  const exists = await io.exists(path).catch(() => false);
  if (!exists) {
    await io.write(
      path,
      new TextEncoder().encode(getBootstrapInstructionTemplate()),
    );
    return;
  }
  const raw = await io.read(path).catch(() => null);
  if (!raw) return;
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const current = new TextDecoder("utf-8").decode(bytes);
  const currentManaged = extractManagedInstructionBlock(current);
  if (!currentManaged) return;
  const upgradedManaged = upgradeManagedInstructionBlock(currentManaged);
  if (upgradedManaged === currentManaged) return;
  const next = spliceManagedInstructionBlock(current, upgradedManaged);
  if (next === current) return;
  await io.write(path, new TextEncoder().encode(next));
}

export async function readClaudeProjectManagedInstructionBlock(): Promise<
  string | null
> {
  const io = getIOUtils();
  if (!io?.exists || !io?.read) return null;
  const path = getClaudeProjectInstructionFile();
  const exists = await io.exists(path).catch(() => false);
  if (!exists) return null;
  const raw = await io.read(path).catch(() => null);
  if (!raw) return null;
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const current = new TextDecoder("utf-8").decode(bytes);
  if (isKnownStockInstructionBlock(current)) {
    return getDefaultClaudeManagedInstructionBlock();
  }
  return extractManagedInstructionBlock(current);
}

export async function updateClaudeProjectManagedInstructionBlock(
  content: string,
): Promise<void> {
  const io = getIOUtils();
  if (!io?.exists || !io?.write || !io?.read) return;
  const path = getClaudeProjectInstructionFile();
  const managedBlock =
    normalizeManagedInstructionBlockContent(content) ||
    getDefaultClaudeManagedInstructionBlock();
  const exists = await io.exists(path).catch(() => false);
  if (!exists) {
    await io.write(
      path,
      new TextEncoder().encode(getBootstrapInstructionTemplate(managedBlock)),
    );
    return;
  }
  const raw = await io.read(path).catch(() => null);
  if (!raw) return;
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const current = new TextDecoder("utf-8").decode(bytes);
  const currentTrimmed = current.trim();
  const next = isKnownStockInstructionBlock(currentTrimmed)
    ? getBootstrapInstructionTemplate(managedBlock)
    : spliceManagedInstructionBlock(current, managedBlock);
  if (next === current) return;
  await io.write(path, new TextEncoder().encode(next));
}

export async function ensureClaudeProjectBootstrap(): Promise<void> {
  await ensureClaudeProjectSkillStructure();
  await writeIfMissing(
    getClaudeProjectSettingsFile(),
    getBootstrapSettingsTemplate(),
  );
  await ensureManagedClaudeInstructionBlock();
}
