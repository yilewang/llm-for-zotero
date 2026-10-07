/**
 * Real profile copy: this build starts on a copy of a user's Zotero DB (see
 * `scripts/run-db-upgrade-tests.mjs --real-profile`). Read-only checks, no
 * model calls. Every message, result and assertion carries counts only:
 * never a title, a message text, or a conversation key.
 *
 * Limit: the copy opens under the scaffold's test profile, not the profile
 * that wrote it. Conversation identity includes the profile, so history,
 * search and the deletion sweep treat the copy's conversations as another
 * profile's (the same on main). Startup and row counts are asserted for
 * every conversation; opening and search are asserted only for conversations
 * of this profile and reported as counts for the rest.
 *
 * Inputs (set by the runner):
 *   LLM_FOR_ZOTERO_REAL_PROFILE_EXPECTED  JSON of row counts per conversation,
 *                                         read with node:sqlite before launch
 *   LLM_FOR_ZOTERO_REAL_PROFILE_RESULT    where this test writes its counts
 *   LLM_FOR_ZOTERO_REAL_PROFILE_OPEN_LIMIT  optional cap on opened conversations
 */
import { assert } from "chai";
import {
  CATALOG_TABLES,
  env,
  persistenceSnapshot,
  readCatalogTitle,
  setPrefs,
  waitFor,
  workflowApi,
  type LiveSystem,
} from "../test-live-runtimes/runtimeLiveShared";
import {
  openHistoryConversation,
  readStoredDebugOutput,
  scanStartupLog,
} from "./dbUpgradeShared";

declare const Zotero: any;
declare const IOUtils: any;

type Counts = {
  system: LiveSystem;
  key: number;
  pendingDeletion: boolean;
  catalogRows: number;
  messageRows: number;
  searchIndexRows: number;
  registryRows: number;
};

const FIELDS = [
  "catalogRows",
  "messageRows",
  "searchIndexRows",
  "registryRows",
] as const;

describe("real profile copy on this build", function () {
  this.timeout(3_600_000);
  const result: Record<string, unknown> = {};
  let expected: Record<string, Counts> = {};
  const api = () => workflowApi();

  before(async function () {
    const path = env("LLM_FOR_ZOTERO_REAL_PROFILE_EXPECTED");
    if (!path) {
      this.skip();
      return;
    }
    expected = JSON.parse(String(await IOUtils.readUTF8(path))).conversations;
  });

  after(async function () {
    const path = env("LLM_FOR_ZOTERO_REAL_PROFILE_RESULT");
    if (path) await IOUtils.writeUTF8(path, JSON.stringify(result, null, 2));
  });

  it("starts without a transaction timeout or a store failure", async function () {
    const findings = scanStartupLog(await readStoredDebugOutput());
    result.startupLog = findings;
    assert.isTrue(findings.storing, "the debug store is on");
    assert.equal(findings.transactionTimeouts, 0, "transaction timeouts");
    assert.equal(findings.storeInitFailures, 0, "store init failures");
    assert.equal(findings.deferredTaskFailures, 0, "deferred task failures");
  });

  it("keeps every conversation's catalog, message, search and registry rows", async function () {
    // A deletion that was pending in the copy is counted apart. The startup
    // sweep finishes it only when it belongs to this profile, so rows can
    // remain; the count is reported.
    const pendingState = await waitFor(
      () => api().getPendingDeletionState(),
      (state) => state.persistedRowCount === 0,
      30_000,
      1_000,
    );
    result.pendingRowsAfterStartup = pendingState.persistedRowCount;
    // Let the deferred startup maintenance settle before reading.
    await Zotero.Promise.delay(10_000);
    const diff: Record<string, { up: number; down: number }> = {};
    for (const field of FIELDS) diff[field] = { up: 0, down: 0 };
    let compared = 0;
    let changed = 0;
    let pendingSkipped = 0;
    for (const before of Object.values(expected)) {
      if (before.pendingDeletion) {
        pendingSkipped += 1;
        continue;
      }
      const after = await persistenceSnapshot(before.system, before.key);
      compared += 1;
      let same = true;
      for (const field of FIELDS) {
        if (after[field] > before[field]) diff[field].up += 1;
        if (after[field] < before[field]) diff[field].down += 1;
        if (after[field] !== before[field]) same = false;
      }
      if (!same) changed += 1;
    }
    let newConversations = 0;
    for (const system of Object.keys(CATALOG_TABLES) as LiveSystem[]) {
      for (const table of CATALOG_TABLES[system]) {
        const rows = (await Zotero.DB.queryAsync(
          `SELECT conversation_key AS k FROM ${table}`,
        )) as any[];
        for (const row of rows || [])
          if (!expected[`${system}:${Number(row.k)}`]) newConversations += 1;
      }
    }
    result.rows = {
      conversations: Object.keys(expected).length,
      compared,
      changed,
      pendingSkipped,
      newConversations,
      conversationsWithMoreRows: Object.fromEntries(
        FIELDS.map((field) => [field, diff[field].up]),
      ),
      conversationsWithFewerRows: Object.fromEntries(
        FIELDS.map((field) => [field, diff[field].down]),
      ),
    };
    assert.equal(
      changed,
      0,
      `conversations whose row counts changed: ${JSON.stringify(result.rows)}`,
    );
  });

  it("opens every listed conversation with its messages, and finds titles by search", async function () {
    // A conversation's identity includes the profile it was created in
    // ("lfz:<profile signature>:..."), and search and history keep other
    // profiles' conversations out (the same on main). The test profile is
    // never the user's own, so conversations of the copy are counted in two
    // groups: this profile's (asserted) and other profiles' (reported only).
    const limit = Number(env("LLM_FOR_ZOTERO_REAL_PROFILE_OPEN_LIMIT") || 0);
    const emptyCounts = () => ({
      attempted: 0,
      opened: 0,
      notListed: 0,
      noItem: 0,
      openFailed: 0,
      emptyButHasRows: 0,
      exactMessageCount: 0,
      searched: 0,
      searchFound: 0,
    });
    const groups = {
      thisProfile: emptyCounts(),
      otherProfile: emptyCounts(),
    };
    const searchedPerSystem: Record<string, number> = {};
    const anyRegularItem = new Map<number, number>();
    const itemForLibrary = async (libraryID: number) => {
      if (!anyRegularItem.has(libraryID)) {
        const rows = (await Zotero.DB.queryAsync(
          `SELECT itemID FROM items WHERE libraryID = ? AND itemTypeID NOT IN
             (SELECT itemTypeID FROM itemTypes WHERE typeName IN ('note', 'attachment', 'annotation'))
           AND itemID NOT IN (SELECT itemID FROM deletedItems) LIMIT 1`,
          [libraryID],
        )) as any[];
        anyRegularItem.set(libraryID, Number(rows?.[0]?.itemID || 0));
      }
      return anyRegularItem.get(libraryID) || 0;
    };
    const signatureOf = (conversationID: string) =>
      conversationID.startsWith("lfz:") ? conversationID.split(":")[1] : "";

    // This profile's signature, from one probe conversation stored in the
    // copy (the row checks are already done; the copy is deleted after).
    let currentSignature = "";
    try {
      setPrefs({ conversationSystem: "upstream" });
      const fixture = await api().createPaperWithPdfFixture({
        title: "Profile probe",
        pdfTitle: "profile-probe.pdf",
      });
      const panel = await api().renderPanelForItem(fixture.parentItemId);
      const probe = await api().seedPanelStoredTurn(
        panel.panelId,
        "profile probe",
        "profile probe",
      );
      for (const table of CATALOG_TABLES.upstream) {
        const rows = (await Zotero.DB.queryAsync(
          `SELECT conversation_id AS id FROM ${table} WHERE conversation_key = ?`,
          [probe.conversationKey],
        )) as any[];
        if (rows?.length)
          currentSignature = signatureOf(String(rows[0].id || ""));
      }
    } catch {
      currentSignature = "";
    }
    await api().reset();
    // Without the signature every conversation is reported, none asserted.
    result.profileSignatureKnown = Boolean(currentSignature);

    for (const before of Object.values(expected)) {
      if (before.pendingDeletion || before.catalogRows === 0) continue;
      const total =
        groups.thisProfile.attempted + groups.otherProfile.attempted;
      if (limit && total >= limit) break;
      let scope: {
        kind: string;
        libraryID: number;
        paperItemID: number;
        conversationID: string;
      } | null = null;
      for (const table of CATALOG_TABLES[before.system]) {
        const kindColumn = table.includes("_global_")
          ? "'global' AS kind"
          : table.includes("_paper_")
            ? "'paper' AS kind"
            : "kind";
        const paperColumn = table.includes("_global_")
          ? "0 AS paperItemID"
          : "paper_item_id AS paperItemID";
        const rows = (await Zotero.DB.queryAsync(
          `SELECT ${kindColumn}, library_id AS libraryID, ${paperColumn}, conversation_id AS conversationID FROM ${table} WHERE conversation_key = ?`,
          [before.key],
        )) as any[];
        if (rows?.length) {
          scope = {
            kind: String(rows[0].kind),
            libraryID: Number(rows[0].libraryID),
            paperItemID: Number(rows[0].paperItemID || 0),
            conversationID: String(rows[0].conversationID || ""),
          };
          break;
        }
      }
      const counts =
        scope &&
        currentSignature &&
        signatureOf(scope.conversationID) === currentSignature
          ? groups.thisProfile
          : groups.otherProfile;
      counts.attempted += 1;
      if (!scope) {
        counts.openFailed += 1;
        continue;
      }
      const itemId =
        scope.kind === "paper"
          ? Zotero.Items.get(scope.paperItemID)
            ? scope.paperItemID
            : 0
          : await itemForLibrary(scope.libraryID);
      if (!itemId) {
        counts.noItem += 1;
        continue;
      }
      setPrefs({ conversationSystem: before.system });
      const panel = await api().renderPanelForItem(itemId);
      let diag = await api().getDiagnostics(panel.panelId);
      if ((scope.kind === "global") !== (diag.conversationKind === "global"))
        diag = await api().togglePanelConversationMode(panel.panelId);
      const listed = (await api().listPanelHistory(panel.panelId)).some(
        (row) => row.conversationKey === before.key,
      );
      if (!listed && diag.conversationKey !== before.key) {
        counts.notListed += 1;
        await api().reset();
        continue;
      }
      const opened = await openHistoryConversation(panel.panelId, before.key);
      if (!opened) {
        counts.openFailed += 1;
        await api().reset();
        continue;
      }
      counts.opened += 1;
      const visible = await waitFor(
        () => api().getPanelVisibleMessageCount(panel.panelId),
        (count) => count > 0 || before.messageRows === 0,
        8_000,
      );
      if (before.messageRows > 0 && visible === 0) counts.emptyButHasRows += 1;
      if (visible === before.messageRows) counts.exactMessageCount += 1;
      const title = await readCatalogTitle(before.system, before.key);
      const searchKey = `${counts === groups.thisProfile}:${before.system}`;
      if (title.trim() && (searchedPerSystem[searchKey] || 0) < 3) {
        searchedPerSystem[searchKey] = (searchedPerSystem[searchKey] || 0) + 1;
        counts.searched += 1;
        const search = await api().searchPanelHistory(
          panel.panelId,
          title.trim().slice(0, 60),
        );
        if (
          search.entries.some((entry) => entry.conversationKey === before.key)
        )
          counts.searchFound += 1;
      }
      // Each panel is torn down before the next, so a long run stays light.
      await api().reset();
    }
    result.open = groups;
    const own = groups.thisProfile;
    assert.equal(own.openFailed, 0, `open failures: ${JSON.stringify(groups)}`);
    assert.equal(
      own.emptyButHasRows,
      0,
      `opened but empty: ${JSON.stringify(groups)}`,
    );
    assert.equal(
      own.searchFound,
      own.searched,
      `title searches: ${JSON.stringify(groups)}`,
    );
    assert.equal(
      groups.otherProfile.emptyButHasRows,
      0,
      `another profile's conversation opened empty: ${JSON.stringify(groups)}`,
    );
  });
});
