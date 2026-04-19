import { DEFAULT_SYSTEM_PROMPT } from "../utils/llmDefaults";
import {
  ensureClaudeProjectSkillStructure,
  getClaudeProjectInstructionFile,
  getClaudeProjectSettingsFile,
} from "./projectSkills";

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
    "- Project config is shared by all Zotero Claude runtimes launched from this installation.",
    "- Local config is scoped to the current conversation runtime folder.",
    "- Put shared Zotero skills in `.claude/skills/` or `.claude/commands/` under the runtime root.",
  ].join("\n");
}

function getBootstrapInstructionManagedBlock(): string {
  return [
    "# Claude Code in Zotero",
    "",
    "This Claude runtime is embedded inside Zotero and is specialized for reading, comparing, and editing around academic papers.",
    "",
    "## Shared Zotero behavior",
    DEFAULT_SYSTEM_PROMPT,
    "",
    "## Claude runtime paper guidance",
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
    "## Config model",
    "- Project config is shared by all Zotero Claude runtimes launched from this installation.",
    "- Local config is scoped to the current conversation runtime folder.",
    "- Put shared Zotero skills in `.claude/skills/` or `.claude/commands/` under the runtime root.",
  ].join("\n");
}

function getBootstrapInstructionTemplate(): string {
  return `${MANAGED_BEGIN_MARKER}\n${getBootstrapInstructionManagedBlock()}\n${MANAGED_END_MARKER}\n`;
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  const io = getIOUtils();
  if (!io?.exists || !io?.write) return;
  const exists = await io.exists(path).catch(() => false);
  if (exists) return;
  await io.write(path, new TextEncoder().encode(content));
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
  if (!io?.exists || !io?.write || !io?.read) return;
  const path = getClaudeProjectInstructionFile();
  const managedBlock = getBootstrapInstructionManagedBlock();
  const exists = await io.exists(path).catch(() => false);
  if (!exists) {
    await io.write(path, new TextEncoder().encode(getBootstrapInstructionTemplate()));
    return;
  }
  const raw = await io.read(path).catch(() => null);
  if (!raw) return;
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const current = new TextDecoder("utf-8").decode(bytes);
  const currentTrimmed = current.trim();
  const next =
    currentTrimmed === getLegacyBootstrapInstructionTemplate().trim()
      ? getBootstrapInstructionTemplate()
      : spliceManagedInstructionBlock(current, managedBlock);
  if (next === current) return;
  await io.write(path, new TextEncoder().encode(next));
}

export async function ensureClaudeProjectBootstrap(): Promise<void> {
  await ensureClaudeProjectSkillStructure();
  await writeIfMissing(getClaudeProjectSettingsFile(), getBootstrapSettingsTemplate());
  await ensureManagedClaudeInstructionBlock();
}
