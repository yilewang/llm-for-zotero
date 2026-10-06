/**
 * Shared state of the DB upgrade phases (see scripts/run-db-upgrade-tests.mjs).
 *
 * The seed phase runs on the older build and writes a record of what it
 * created into the data directory; the verify phase runs on the newer build
 * against a copy of that data directory and checks the record. Only type
 * imports reach into src, so these files also run against an older checkout.
 */
import type { WorkflowTestConversationPersistenceSnapshot } from "../src/modules/contextPanel/workflowTestTypes";
import {
  CATALOG_TABLES,
  MESSAGE_TABLES,
  panelElement,
  persistenceSnapshot,
  readCatalogTitle,
  readStoredMessages,
  waitFor,
  workflowApi,
  type LiveKind,
  type LiveSystem,
} from "../test-live-runtimes/runtimeLiveShared";

declare const Zotero: any;
declare const IOUtils: any;
declare const PathUtils: any;

export const RECORD_FILE = "llm-db-upgrade-record.json";

export type RecordedConversation = {
  label: string;
  system: LiveSystem;
  kind: LiveKind;
  key: number;
  title: string;
  marker: string;
  texts: Array<{ role: string; text: string }>;
  snapshot: WorkflowTestConversationPersistenceSnapshot;
  agentRun?: { runId: string; status: string; events: number } | null;
};

export type DbUpgradeRecord = {
  version: 1;
  phase: string;
  writtenAt: number;
  sourceCommit: string;
  libraryID: number;
  paperItemId: number;
  collectionId: number;
  agentNoteId: number;
  agentNoteTitle: string;
  conversations: RecordedConversation[];
  /** Deleted and swept on the older build: must stay absent. */
  completedDeletion: { system: LiveSystem; key: number; marker: string };
  /** Queued on the older build without a sweep: the newer startup finishes it. */
  pendingDeletion: { system: LiveSystem; key: number; marker: string };
  /** A queued turn deletion: its two rows go, the rest of the conversation stays. */
  pendingTurn: {
    system: LiveSystem;
    key: number;
    marker: string;
    userTimestamp: number;
    assistantTimestamp: number;
  };
  pendingRowsAtEnd: number;
  /** What the older build's startup restore chose for the paper at the end. */
  startupRestore: {
    system: string;
    kind: string;
    key: number;
    messageRows: number;
  };
  lastUsedPrefs: Record<string, unknown>;
};

export const LAST_USED_PREF_KEYS = [
  "conversationSystem",
  "lastUsedConversationModeMap",
  "lastUsedGlobalConversationMap",
  "lastUsedPaperConversationMap",
  "claudeCodeConversationModeMap",
  "claudeCodeGlobalConversationMap",
  "claudeCodePaperConversationMap",
  "codexAppServerConversationModeMap",
  "codexAppServerGlobalConversationMap",
  "codexAppServerPaperConversationMap",
];

export function recordPath(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, RECORD_FILE);
}

export async function writeRecord(record: DbUpgradeRecord): Promise<void> {
  await IOUtils.writeUTF8(recordPath(), JSON.stringify(record, null, 2));
}

/** A phase's findings, next to the record; the runner prints the file. */
export async function writeReport(
  phase: string,
  report: Record<string, unknown>,
): Promise<void> {
  await IOUtils.writeUTF8(
    PathUtils.join(
      Zotero.DataDirectory.dir,
      `llm-db-upgrade-report-${phase}.json`,
    ),
    JSON.stringify(report, null, 2),
  );
}

export async function readRecord(): Promise<DbUpgradeRecord> {
  return JSON.parse(String(await IOUtils.readUTF8(recordPath())));
}

export function readLastUsedPrefs(): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const key of LAST_USED_PREF_KEYS) {
    values[key] = Zotero.Prefs.get(
      `extensions.zotero.llmforzotero.${key}`,
      true,
    );
  }
  return values;
}

export async function recordConversation(params: {
  label: string;
  system: LiveSystem;
  kind: LiveKind;
  key: number;
  marker: string;
}): Promise<RecordedConversation> {
  const rows = await readStoredMessages(params.system, params.key);
  const lastRunId =
    [...rows]
      .reverse()
      .find((row) => row.role === "assistant" && row.agentRunId)?.agentRunId ||
    "";
  return {
    ...params,
    title: await readCatalogTitle(params.system, params.key),
    texts: rows.map((row) => ({ role: row.role, text: row.text })),
    snapshot: await persistenceSnapshot(params.system, params.key),
    agentRun: lastRunId ? await readAgentRunRecord(lastRunId) : null,
  };
}

export async function readAgentRunRecord(
  runId: string,
): Promise<{ runId: string; status: string; events: number } | null> {
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
    runId,
    status: String(runs[0].status || ""),
    events: Number(events?.[0]?.n || 0),
  };
}

/** Row counts of one conversation in every table that names its key. */
export async function rowsAnywhere(key: number): Promise<number> {
  let total = 0;
  for (const system of Object.keys(MESSAGE_TABLES) as LiveSystem[]) {
    for (const table of [MESSAGE_TABLES[system], ...CATALOG_TABLES[system]]) {
      const rows = (await Zotero.DB.queryAsync(
        `SELECT COUNT(*) AS n FROM ${table} WHERE conversation_key = ?`,
        [key],
      )) as any[];
      total += Number(rows?.[0]?.n || 0);
    }
  }
  return total;
}

/**
 * Opens a conversation from the panel's history menu, as a click on its
 * row does, and waits until the panel shows it.
 */
export async function openHistoryConversation(
  panelId: string,
  key: number,
): Promise<boolean> {
  const api = workflowApi();
  if ((await api.getDiagnostics(panelId)).conversationKey === key) return true;
  await api.listPanelHistory(panelId);
  const body = panelElement(panelId);
  const row = await waitFor(
    async () =>
      body.querySelector(
        `.llm-history-item[data-conversation-key="${key}"]`,
      ) as HTMLElement | null,
    (element) => Boolean(element),
    8_000,
    100,
  );
  if (!row) return false;
  const target =
    (row.querySelector(".llm-history-item-title") as HTMLElement | null) || row;
  const MouseEventCtor = body.ownerDocument.defaultView?.MouseEvent;
  if (MouseEventCtor) {
    target.dispatchEvent(
      new MouseEventCtor("click", { bubbles: true, cancelable: true }),
    );
  } else {
    target.click();
  }
  const diag = await waitFor(
    () => api.getDiagnostics(panelId),
    (value) => value.conversationKey === key,
    10_000,
    100,
  );
  return diag.conversationKey === key;
}

/** Reads the Zotero debug output stored since startup (debug.store). */
export async function readStoredDebugOutput(): Promise<string> {
  try {
    return String((await Zotero.Debug.get()) || "");
  } catch {
    return "";
  }
}

export type StartupLogFindings = {
  storing: boolean;
  lines: number;
  transactionTimeouts: number;
  storeInitFailures: number;
  deferredTaskFailures: number;
  startupPhases: number;
};

export function scanStartupLog(output: string): StartupLogFindings {
  const count = (pattern: RegExp) => (output.match(pattern) || []).length;
  return {
    storing: Boolean(Zotero.Debug?.storing),
    lines: output ? output.split("\n").length : 0,
    transactionTimeouts: count(/Timed out waiting for transaction/g),
    storeInitFailures: count(/LLM: Failed to initialize/g),
    deferredTaskFailures: count(/Deferred startup task failed/g),
    startupPhases: count(/LLM startup( deferred)?: /g),
  };
}
