import { DEFAULT_SYSTEM_PROMPT } from "../utils/llmDefaults";
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

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
}

function getBootstrapSettingsTemplate(): string {
  return JSON.stringify(
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
  ) + "\n";
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

function getLegacyBootstrapInstructionTemplate(): string {
  return [
    "# Claude Code in Zotero",
    "",
    "This Claude runtime is embedded inside Zotero and is specialized for reading, comparing, and editing around academic papers.",
    "",
    "## Shared Zotero behavior",
    DEFAULT_SYSTEM_PROMPT,
    "",
    "## Config model",
    "- Project config is shared by all Claude runtimes within the current Zotero profile.",
    "- Different Zotero profiles use different Claude runtime roots and different local conversation folders.",
    "- Local config is scoped to the current conversation runtime folder.",
    "- Put shared Zotero skills in `.claude/skills/` or `.claude/commands/` under the runtime root.",
  ].join("\n");
}

export function getDefaultClaudeManagedInstructionBlock(): string {
  return [
    "# Claude Code in Zotero",
    "",
    "This Claude runtime is embedded inside Zotero and is specialized for reading, comparing, and editing around academic papers.",
    "",
    "## Shared Zotero behavior",
    DEFAULT_SYSTEM_PROMPT,
    "",
    "## Claude runtime paper guidance",
    "- Treat the user's Zotero library as the primary source of truth for library, collection, note, and paper questions. Do not default to describing the local runtime folder, plugin workspace, or project files unless the user is clearly asking about code or the runtime itself.",
    "- Assume Claude can answer from the whole Zotero library, not only the currently open paper. For library-wide requests, reason across library metadata, collections, notes, selected papers, pinned papers, and conversation-visible retrieval results before defaulting to generic workspace exploration.",
    "- When available, treat Zotero SQL-backed library metadata, MinerU parsed-text caches, and semantic embedding caches or retrieval indexes as valid evidence sources for whole-library questions.",
    "- For broad library questions, first reason about the active Zotero scope: current paper, selected papers, pinned papers, current library, notes, local caches, and any available retrieval indexes. Prefer answering from those sources before falling back to generic workspace exploration.",
    "- If the user's request is ambiguous between their Zotero library and the local project/runtime, prefer the Zotero interpretation unless surrounding evidence clearly points to code, files, or development work.",
    "- For summary-like requests such as summarize, key points, main idea, takeaway, overview, or authors, prefer concise synthesis grounded in the source instead of exact blockquotes.",
    "- Do not hunt for page numbers or exact quotations unless the user explicitly asks for evidence, quotes, exact wording, page references, or passage location.",
    "- If a paper is marked for full-text reading on this turn, treat it as a high-priority reading target before answering.",
    "- Treat selected papers as available turn context, and treat pinned papers as persistent background context.",
    "- Do not upgrade selected or pinned papers into mandatory full-text reads unless they are explicitly in the full-text group for this turn.",
    "- For broad questions about one paper, prefer one useful read then answer.",
    "- For specific questions about methods, results, metrics, datasets, or exact claims, keep retrieval targeted and minimal.",
    "- For multi-paper work, prefer breadth first and follow up only on the comparison dimension the user actually asked about.",
    "- For figures and tables, prefer localized section reads over scanning the whole paper.",
    "- For library or collection analysis, prefer one local aggregation pass over enumerating large result sets in chat.",
    "- Default to the shortest path that can produce a correct answer.",
    "",
    ...getConfigModelInstructionLines(),
  ].join("\n");
}

function normalizeManagedInstructionBlockContent(content: string): string {
  return String(content || "").replace(/\r\n?/g, "\n").trim();
}

function getManagedInstructionBlockFromSettings(): string {
  return (
    normalizeManagedInstructionBlockContent(getClaudeManagedInstructionTemplatePref()) ||
    getDefaultClaudeManagedInstructionBlock()
  );
}

function getBootstrapInstructionTemplate(managedBlock = getManagedInstructionBlockFromSettings()): string {
  return `${MANAGED_BEGIN_MARKER}\n${managedBlock}\n${MANAGED_END_MARKER}\n`;
}

function upgradeManagedInstructionBlock(content: string): string {
  const normalized = normalizeManagedInstructionBlockContent(content);
  if (!normalized) return getDefaultClaudeManagedInstructionBlock();
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

function spliceManagedInstructionBlock(onDiskRaw: string, managedBlock: string): string {
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
    await io.write(path, new TextEncoder().encode(getBootstrapInstructionTemplate()));
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

export async function readClaudeProjectManagedInstructionBlock(): Promise<string | null> {
  const io = getIOUtils();
  if (!io?.exists || !io?.read) return null;
  const path = getClaudeProjectInstructionFile();
  const exists = await io.exists(path).catch(() => false);
  if (!exists) return null;
  const raw = await io.read(path).catch(() => null);
  if (!raw) return null;
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const current = new TextDecoder("utf-8").decode(bytes);
  if (current.trim() === getLegacyBootstrapInstructionTemplate().trim()) {
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
    await io.write(path, new TextEncoder().encode(getBootstrapInstructionTemplate(managedBlock)));
    return;
  }
  const raw = await io.read(path).catch(() => null);
  if (!raw) return;
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const current = new TextDecoder("utf-8").decode(bytes);
  const currentTrimmed = current.trim();
  const next =
    currentTrimmed === getLegacyBootstrapInstructionTemplate().trim()
      ? getBootstrapInstructionTemplate(managedBlock)
      : spliceManagedInstructionBlock(current, managedBlock);
  if (next === current) return;
  await io.write(path, new TextEncoder().encode(next));
}

export async function ensureClaudeProjectBootstrap(): Promise<void> {
  await ensureClaudeProjectSkillStructure();
  await writeIfMissing(getClaudeProjectSettingsFile(), getBootstrapSettingsTemplate());
  await ensureManagedClaudeInstructionBlock();
}
