/**
 * Shared helpers for the live runtime tests (upstream, Claude Code, Codex)
 * and the DB upgrade phases.
 *
 * This file only imports types from src, so a copy of it runs against an
 * older checkout too (the DB upgrade runner copies it next to its tests).
 */
import type {
  WorkflowTestApi,
  WorkflowTestConversationPersistenceSnapshot,
} from "../src/modules/contextPanel/workflowTestTypes";
import type { LiveAgentCredentials } from "../test-live-agent/liveAgentCredentials";

declare const Zotero: any;
declare const Services: any;

export const PREF_PREFIX = "extensions.zotero.llmforzotero";
export const LIVE_MODEL_ENTRY_ID = "live-runtime-model";

export type LiveSystem = "upstream" | "claude_code" | "codex";
export type LiveKind = "paper" | "library";

export const LIVE_SYSTEMS: readonly LiveSystem[] = [
  "upstream",
  "claude_code",
  "codex",
];

/** The persisted message table of each conversation store. */
export const MESSAGE_TABLES: Record<LiveSystem, string> = {
  upstream: "llm_for_zotero_chat_messages",
  claude_code: "llm_for_zotero_claude_messages",
  codex: "llm_for_zotero_codex_messages",
};

/** The persisted catalog tables of each conversation store. */
export const CATALOG_TABLES: Record<LiveSystem, string[]> = {
  upstream: [
    "llm_for_zotero_global_conversations",
    "llm_for_zotero_paper_conversations",
  ],
  claude_code: ["llm_for_zotero_claude_conversations"],
  codex: ["llm_for_zotero_codex_conversations"],
};

export function env(name: string): string {
  try {
    return String(Services.env.get(name) || "").trim();
  } catch {
    return "";
  }
}

export function workflowApi(): WorkflowTestApi {
  const api = Zotero.LLMForZotero?.api?.workflowTest;
  if (!api) throw new Error("The workflow test API is not installed");
  return api as WorkflowTestApi;
}

/** The systems a run covers: LLM_FOR_ZOTERO_LIVE_RUNTIME_SYSTEMS or all. */
export function selectedSystems(): LiveSystem[] {
  const requested = env("LLM_FOR_ZOTERO_LIVE_RUNTIME_SYSTEMS")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!requested.length) return [...LIVE_SYSTEMS];
  return LIVE_SYSTEMS.filter((system) => requested.includes(system));
}

export function shortSystemName(system: LiveSystem): string {
  return system === "claude_code" ? "claude" : system;
}

export function randomTag(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * The prefs a live runtime turn needs in a fresh scaffold profile: the
 * upstream model entry from the live credentials, both runtimes enabled, and
 * the Codex binary and model. Values come from env so no user path is
 * committed.
 */
export function liveRuntimePrefs(
  system: LiveSystem,
  credentials: LiveAgentCredentials,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const codexPath = env("LLM_FOR_ZOTERO_LIVE_CODEX_PATH");
  const claudeModel = env("LLM_FOR_ZOTERO_LIVE_CLAUDE_MODEL");
  return {
    conversationSystem: system,
    enableClaudeCodeMode: true,
    enableCodexAppServerMode: true,
    modelProviderGroups: JSON.stringify([
      {
        id: "live-runtime-provider",
        apiBase: credentials.apiBase,
        apiKey: credentials.apiKey,
        authMode: "api_key",
        providerProtocol: credentials.providerProtocol,
        models: [
          {
            id: LIVE_MODEL_ENTRY_ID,
            model: credentials.model,
            temperature: 0.3,
            maxTokens: 4096,
          },
        ],
      },
    ]),
    modelProviderGroupsMigrationVersion: 3,
    lastUsedModelEntryId: LIVE_MODEL_ENTRY_ID,
    lastUsedRuntimeMode: "chat",
    ...(codexPath ? { codexAppServerPath: codexPath } : {}),
    codexAppServerModel:
      env("LLM_FOR_ZOTERO_LIVE_CODEX_MODEL") || "gpt-6-astra",
    codexAppServerReasoning:
      env("LLM_FOR_ZOTERO_LIVE_CODEX_REASONING") || "low",
    ...(claudeModel ? { claudeCodeModel: claudeModel } : {}),
    ...extra,
  };
}

export function setPrefs(prefs: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(prefs)) {
    Zotero.Prefs.set(`${PREF_PREFIX}.${key}`, value, true);
  }
}

/** Sets prefs for one task and restores the earlier values afterwards. */
export async function withPrefs<T>(
  prefs: Record<string, unknown>,
  task: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, unknown>();
  for (const key of Object.keys(prefs)) {
    const fullKey = `${PREF_PREFIX}.${key}`;
    previous.set(fullKey, Zotero.Prefs.get(fullKey, true));
  }
  setPrefs(prefs);
  try {
    return await task();
  } finally {
    for (const [fullKey, value] of previous) {
      if (value === undefined) Zotero.Prefs.clear?.(fullKey, true);
      else Zotero.Prefs.set(fullKey, value, true);
    }
  }
}

/** Errors thrown inside Zotero lose their message at the runner boundary. */
export function describeError(error: unknown): string {
  const message = String((error as Error)?.message || error);
  const stack = String((error as Error)?.stack || "");
  return stack && !stack.includes(message)
    ? `${message}\n${stack}`
    : stack || message;
}

export async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await Zotero.Promise.delay(intervalMs);
    value = await read();
  }
  return value;
}

/** The panel's DOM element, for the few reads the workflow API lacks. */
export function panelElement(panelId: string): HTMLElement {
  const docs = [
    Zotero.getMainWindow?.()?.document,
    (globalThis as { document?: Document }).document,
  ].filter(Boolean) as Document[];
  for (const doc of docs) {
    const element = doc.querySelector(
      `[data-workflow-panel-id="${panelId}"]`,
    ) as HTMLElement | null;
    if (element) return element;
  }
  throw new Error(`Panel ${panelId} is not in the document`);
}

export type StoredMessageRow = {
  id: number;
  role: string;
  text: string;
  timestamp: number;
  agentRunId: string;
};

export async function readStoredMessages(
  system: LiveSystem,
  conversationKey: number,
): Promise<StoredMessageRow[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT id, role, text, timestamp, agent_run_id AS agentRunId
     FROM ${MESSAGE_TABLES[system]}
     WHERE conversation_key = ?
     ORDER BY timestamp ASC, id ASC`,
    [conversationKey],
  )) as any[];
  return (rows || []).map((row) => ({
    id: Number(row.id),
    role: String(row.role),
    text: String(row.text || ""),
    timestamp: Number(row.timestamp),
    agentRunId: String(row.agentRunId || ""),
  }));
}

export async function readCatalogTitle(
  system: LiveSystem,
  conversationKey: number,
): Promise<string> {
  for (const table of CATALOG_TABLES[system]) {
    const rows = (await Zotero.DB.queryAsync(
      `SELECT title, first_user_title AS firstUserTitle FROM ${table} WHERE conversation_key = ?`,
      [conversationKey],
    )) as any[];
    if (rows?.length)
      return String(rows[0].title || rows[0].firstUserTitle || "");
  }
  return "";
}

export async function persistenceSnapshot(
  system: LiveSystem,
  conversationKey: number,
): Promise<WorkflowTestConversationPersistenceSnapshot> {
  return workflowApi().getWorkflowConversationPersistenceSnapshot(
    system,
    conversationKey,
  );
}

export type ApprovedCard = { requestId: string; text: string };

/**
 * Approves every confirmation card that appears in the panel until `until`
 * settles: the footer Apply button, or the paged review's confirm button.
 */
export async function approveCardsUntil<T>(
  panelId: string,
  until: Promise<T>,
  approved: ApprovedCard[],
): Promise<T> {
  let settled = false;
  const watched = until.finally(() => {
    settled = true;
  });
  const seen = new Set<string>();
  while (!settled) {
    let body: HTMLElement | null = null;
    try {
      body = panelElement(panelId);
    } catch {
      body = null;
    }
    const cards = Array.from(
      body?.querySelectorAll(".llm-agent-hitl-card[data-request-id]") || [],
    ) as HTMLElement[];
    for (const card of cards) {
      const requestId = card.dataset.requestId || "";
      if (!requestId || seen.has(requestId)) continue;
      const button = (card.querySelector('button[data-kind="save"]') ||
        card.querySelector(
          ".llm-agent-hitl-paged-confirm-btn",
        )) as HTMLButtonElement | null;
      if (!button || button.disabled) continue;
      seen.add(requestId);
      approved.push({
        requestId,
        text: (card.textContent || "").replace(/\s+/g, " ").slice(0, 200),
      });
      button.click();
    }
    await Promise.race([
      watched.catch(() => undefined),
      Zotero.Promise.delay(250),
    ]);
  }
  return watched;
}

/** One row of an agent run and its event count. */
export async function readAgentRun(runId: string): Promise<{
  status: string;
  events: number;
} | null> {
  if (!runId) return null;
  const runs = (await Zotero.DB.queryAsync(
    "SELECT status FROM llm_for_zotero_agent_runs WHERE run_id = ?",
    [runId],
  )) as any[];
  if (!runs?.length) return null;
  const events = (await Zotero.DB.queryAsync(
    "SELECT COUNT(*) AS n FROM llm_for_zotero_agent_run_events WHERE run_id = ?",
    [runId],
  )) as any[];
  return {
    status: String(runs[0].status || ""),
    events: Number(events?.[0]?.n || 0),
  };
}

/** The settled activity disclosures ("Worked for ...") in the panel. */
export function readActivityDisclosures(panelId: string): string[] {
  const body = panelElement(panelId);
  return (
    Array.from(
      body.querySelectorAll(".llm-agent-activity-details > summary"),
    ) as HTMLElement[]
  ).map((summary) => (summary.textContent || "").trim());
}
