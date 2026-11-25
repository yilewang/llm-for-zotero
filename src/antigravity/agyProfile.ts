/**
 * The agy profile the plugin owns: where agy reads its config and keeps its
 * data when Zotero starts it.
 *
 * Why agy needs one. agy offers the model an MCP server's tools in two ways.
 * A server a client passes when it opens a session gets only the tools whose
 * definitions fit agy's tool budget; the rest are dropped without an error,
 * and the budget shrinks as the user installs agy plugins. A server listed
 * in agy's own `mcp_config.json` keeps every tool: the ones marked `eager`
 * are offered directly, and the model reaches the others through agy's
 * `call_mcp_tool`. So the Zotero server goes in a config file.
 *
 * That file carries the conversation's scope token, and agy reads it once at
 * start, so each conversation has its own config folder (a few KB) and its
 * own agy process. agy's data (its built-in files, session history, logs)
 * is shared by every conversation of the Zotero profile:
 *
 *   <runtime root>/antigravity-profile/
 *     data/                              agy's data folder (`--app-data-dir`)
 *     sessions/<name>/                   one per conversation (`--gemini-dir`)
 *       config/mcp_config.json
 *
 * agy's sign-in comes from the system keychain, so it is the user's own.
 * The user's agy plugins, rules, and settings live in their own profile and
 * do not apply here, which is what keeps the tool budget the same for
 * everyone.
 */

import { getZoteroAgentRuntimeRootDir } from "../agent/skills/nativeSkillPaths";
import { fnv1a32 } from "../utils/fnv1a";
import { ensureDir, readFileBytes, writeFileBytes } from "../utils/geckoFs";
import { joinLocalPath } from "../utils/localPath";
import { getRuntimePlatformInfo } from "../utils/runtimePlatform";

/**
 * The Zotero tools agy offers the model directly, most needed first. They
 * cover reading, search, paging a long result, citing, and note writing, and
 * fit agy's tool budget (about 42 KB of the 58 KB a profile without plugins
 * has). Every other Zotero tool stays reachable through agy's
 * `call_mcp_tool`.
 */
export const ANTIGRAVITY_EAGER_ZOTERO_TOOL_NAMES = [
  "paper_read",
  "library_retrieve",
  "library_search",
  "library_read",
  "context_read",
  "read_attachment",
  "literature_search",
  "literature_read",
  "note_write",
  "undo",
  "library_cite",
] as const;

/** One HTTP MCP server for agy's `mcp_config.json`. */
export type AgyMcpServer = {
  name: string;
  url: string;
  headers: Record<string, string>;
  /** The tools agy offers the model directly; the rest load on demand. */
  eagerTools: readonly string[];
};

/** What an agy process needs to run on a profile folder. */
export type AgyProfile = {
  /** The folder agy reads its config from (`--gemini-dir`). */
  configDir: string;
  /** agy's data folder, as a path relative to `configDir`. */
  dataDirFromConfigDir: string;
  /** agy's data folder. */
  dataDir: string;
  /** Names the config's content; agy reads it once, at start. */
  configSignature: string;
};

const PROFILE_FOLDER = "antigravity-profile";
const DATA_FOLDER = "data";
const SESSIONS_FOLDER = "sessions";
/** The config folder of an agy that serves no conversation (the pickers). */
const NO_CONVERSATION_NAME = "no-conversation";

export function getAgyProfileRootDir(): string {
  return joinLocalPath(getZoteroAgentRuntimeRootDir(), PROFILE_FOLDER);
}

/** agy's data folder, shared by every conversation of the Zotero profile. */
export function getAgyDataDir(): string {
  return joinLocalPath(getAgyProfileRootDir(), DATA_FOLDER);
}

function configDirName(conversationKey: number | undefined): string {
  return conversationKey && Number.isFinite(conversationKey)
    ? `conversation-${Math.floor(conversationKey)}`
    : NO_CONVERSATION_NAME;
}

export function getAgyConfigDir(conversationKey?: number): string {
  return joinLocalPath(
    getAgyProfileRootDir(),
    SESSIONS_FOLDER,
    configDirName(conversationKey),
  );
}

/** The content of agy's `mcp_config.json` for these servers. */
export function buildAgyMcpConfig(servers: readonly AgyMcpServer[]): {
  mcpServers: Record<string, unknown>;
} {
  return {
    mcpServers: Object.fromEntries(
      servers.map((server) => [
        server.name,
        {
          url: server.url,
          headers: server.headers,
          tools: Object.fromEntries(
            server.eagerTools.map((tool) => [tool, { eager: true }]),
          ),
        },
      ]),
    ),
  };
}

/**
 * Writes the config for a conversation's agy (or, without a conversation,
 * for an agy that only lists models and commands) and returns its profile.
 * The file is rewritten only when its content changes.
 */
export async function prepareAgyProfile(params: {
  conversationKey?: number;
  servers: readonly AgyMcpServer[];
}): Promise<AgyProfile> {
  const configDir = getAgyConfigDir(params.conversationKey);
  const dataDir = getAgyDataDir();
  // agy reads `<gemini dir>/config/mcp_config.json`.
  const agyConfigDir = joinLocalPath(configDir, "config");
  const configFile = joinLocalPath(agyConfigDir, "mcp_config.json");
  const text = `${JSON.stringify(buildAgyMcpConfig(params.servers), null, 2)}\n`;
  await ensureDir(agyConfigDir);
  await ensureDir(dataDir);
  const existing = await readFileBytes(configFile);
  if (!existing || new TextDecoder().decode(existing) !== text) {
    const written = await writeFileBytes(
      configFile,
      new TextEncoder().encode(text),
      { atomic: true },
    );
    if (!written) {
      throw new Error(
        `Could not write the Antigravity MCP config: ${configFile}`,
      );
    }
  }
  const separator =
    getRuntimePlatformInfo().platform === "windows" ? "\\" : "/";
  return {
    configDir,
    // agy takes its data folder only as a path relative to the config one.
    dataDirFromConfigDir: ["..", "..", DATA_FOLDER].join(separator),
    dataDir,
    configSignature: fnv1a32(text),
  };
}
