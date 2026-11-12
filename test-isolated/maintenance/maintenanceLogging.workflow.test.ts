import { assert } from "chai";
import { appLogger } from "../../src/core/logging";
import { getNextConversationCleanupJobDueAt } from "../../src/core/conversations/conversationCleanupJobs";
import { logConversationStoreWarning } from "../../src/shared/conversationStore/diagnostics";

declare const Zotero: any;
declare const IOUtils: any;
declare const PathUtils: any;

const OBSERVATION_MS = 12_000;
const STARTUP_SETTLE_MS = 2_000;
const LOG_LEVEL_PREF = "extensions.zotero.llmforzotero.logLevel";

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isMaintenanceQuery(sql: string): boolean {
  return /llm_for_zotero_(?:conversation_cleanup_jobs|attachment_blobs|attachment_refs|agent_trace_exports|agent_trace_file_cleanup)/i.test(
    sql,
  );
}

function assertDisposableProfile(): void {
  const dataDir = String(Zotero.DataDirectory?.dir || "");
  assert.match(
    dataDir,
    /(?:^|[\\/])\.scaffold[\\/]/u,
    `maintenance tests require a disposable scaffold profile, got ${dataDir || "<empty>"}`,
  );
}

describe("workflow: idle maintenance", function () {
  this.timeout(30_000);

  it("performs no recurring five-second database or trace-directory sweep", async function () {
    assertDisposableProfile();
    await wait(STARTUP_SETTLE_MS);

    const originalQueryAsync = Zotero.DB.queryAsync;
    const originalGetChildren = IOUtils.getChildren;
    const maintenanceSql: string[] = [];
    const traceDirectoryListings: string[] = [];
    const startedAt = Date.now();
    const reportPath = PathUtils.join(
      Zotero.DataDirectory.dir,
      "issue470-maintenance-report.json",
    );

    Zotero.DB.queryAsync = async function (sql: string, ...args: unknown[]) {
      if (isMaintenanceQuery(String(sql))) maintenanceSql.push(String(sql));
      return originalQueryAsync.call(this, sql, ...args);
    };
    IOUtils.getChildren = async function (path: string, ...args: unknown[]) {
      if (/(?:^|[\\/])trace-debug[\\/]?$/u.test(String(path))) {
        traceDirectoryListings.push(String(path));
      }
      return originalGetChildren.call(this, path, ...args);
    };

    try {
      await wait(OBSERVATION_MS);
    } finally {
      Zotero.DB.queryAsync = originalQueryAsync;
      IOUtils.getChildren = originalGetChildren;
      const report = {
        scenario: "issue-470-idle-maintenance",
        startedAt,
        observedMs: Date.now() - startedAt,
        maintenanceQueryCount: maintenanceSql.length,
        traceDirectoryListingCount: traceDirectoryListings.length,
        maintenanceSql,
        traceDirectoryListings,
      };
      await IOUtils.writeUTF8(reportPath, JSON.stringify(report, null, 2));
    }

    assert.deepEqual(
      {
        maintenanceQueryCount: maintenanceSql.length,
        traceDirectoryListingCount: traceDirectoryListings.length,
      },
      {
        maintenanceQueryCount: 0,
        traceDirectoryListingCount: 0,
      },
      `idle maintenance metrics were written to ${reportPath}`,
    );
  });

  it("applies live log levels to the installed plugin and maintenance SQL", async function () {
    assertDisposableProfile();
    const previousLevel = Zotero.Prefs.get(LOG_LEVEL_PREF, true);
    const messages: string[] = [];
    const onDebug = (message: unknown) => messages.push(String(message));
    const installedToolkit = Zotero.LLMForZotero?.data?.ztoolkit;
    assert.isFunction(
      installedToolkit?.log,
      "the startup-configured plugin toolkit should be installed",
    );
    const unique = `issue470-native-${Date.now()}`;
    const sqlPattern =
      /MIN\s*\(\s*next_attempt_at\s*\).*llm_for_zotero_conversation_cleanup_jobs/is;

    Zotero.Debug.addListener(onDebug);
    try {
      Zotero.Prefs.set(LOG_LEVEL_PREF, "warn", true);
      appLogger.debug(`${unique}-imported-debug-hidden`);
      installedToolkit.log(`${unique}-toolkit-debug-hidden`);
      Zotero.debug(`${unique}-unrelated-zotero-debug-visible`);
      logConversationStoreWarning(`${unique}-application-warning-visible`);
      const warningError = new Error(`${unique}-error-message`);
      warningError.stack = `${unique}-error-stack@resource://llm-for-zotero/logging.js:42:7`;
      appLogger.warn(`${unique}-warning-with-error`, warningError);
      await wait(25);

      assert.isFalse(
        messages.some((message) =>
          message.includes(`${unique}-imported-debug-hidden`),
        ),
      );
      assert.isFalse(
        messages.some((message) =>
          message.includes(`${unique}-toolkit-debug-hidden`),
        ),
      );
      assert.isTrue(
        messages.some((message) =>
          message.includes(`${unique}-unrelated-zotero-debug-visible`),
        ),
        "the plugin preference must not suppress unrelated Zotero debug output",
      );
      assert.isTrue(
        messages.some((message) =>
          message.includes(`${unique}-application-warning-visible`),
        ),
      );
      const warningMessage = messages.find((message) =>
        message.includes(`${unique}-warning-with-error`),
      );
      assert.include(warningMessage || "", `${unique}-error-message`);
      assert.include(warningMessage || "", `${unique}-error-stack`);

      Zotero.Prefs.set(LOG_LEVEL_PREF, "debug", true);
      installedToolkit.log(`${unique}-toolkit-debug-visible`, warningError);
      appLogger.debug(`${unique}-imported-debug-visible`);
      await wait(25);
      const toolkitMessage = messages.find((message) =>
        message.includes(`${unique}-toolkit-debug-visible`),
      );
      assert.include(toolkitMessage || "", `${unique}-error-message`);
      assert.include(toolkitMessage || "", `${unique}-error-stack`);
      assert.isTrue(
        messages.some((message) =>
          message.includes(`${unique}-imported-debug-visible`),
        ),
      );

      const beforeSuppressedQuery = messages.length;
      await getNextConversationCleanupJobDueAt({
        includeAttentionRequired: true,
      });
      await wait(25);
      assert.isFalse(
        messages
          .slice(beforeSuppressedQuery)
          .some((message) => sqlPattern.test(message)),
        "debug level should keep routine maintenance SQL suppressed",
      );

      Zotero.Prefs.set(LOG_LEVEL_PREF, "trace", true);
      const beforeTraceQuery = messages.length;
      await getNextConversationCleanupJobDueAt({
        includeAttentionRequired: true,
      });
      await wait(25);
      assert.isTrue(
        messages
          .slice(beforeTraceQuery)
          .some((message) => sqlPattern.test(message)),
        "trace level should restore routine maintenance SQL diagnostics",
      );

      Zotero.Prefs.set(LOG_LEVEL_PREF, "warn", true);
      installedToolkit.log(`${unique}-toolkit-debug-hidden-again`);
      await wait(25);
      assert.isFalse(
        messages.some((message) =>
          message.includes(`${unique}-toolkit-debug-hidden-again`),
        ),
        "an existing installed logger should read the changed preference live",
      );
    } finally {
      Zotero.Debug.removeListener(onDebug);
      if (previousLevel === undefined) Zotero.Prefs.clear(LOG_LEVEL_PREF, true);
      else Zotero.Prefs.set(LOG_LEVEL_PREF, previousLevel, true);
    }
  });
});
