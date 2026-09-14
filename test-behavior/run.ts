import { resolveLiveAgentCredentials } from "../test-live-agent/liveAgentCredentials";
import {
  getConversationSystemPref,
  setConversationSystemPref,
} from "../src/claudeCode/prefs";
import {
  getLastUsedModelEntryId,
  setLastUsedModelEntryId,
  getRuntimeModelEntries,
} from "../src/utils/modelProviders";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import {
  setWorkflowTestSendInterceptor,
  setWorkflowTestFinalRequestInterceptor,
} from "../src/modules/contextPanel/workflowTestHooks";
import {
  sha256Text,
  sha256Bytes,
} from "../src/agent/store/journalRecoveryBlobStore";
import { catalog, selectSteps } from "./catalog";
import {
  check,
  redact,
  runSteps,
  reportExitCode,
  type StepResult,
} from "./core";
import { createFixtures, snapshot } from "./native";
import { LiveDriver, type Writer } from "./driver";
import { executeJourneyStep, type JourneyContext } from "./journeys";
import {
  setLastUsedReasoningLevelForProvider,
  setLastUsedRuntimeMode,
} from "../src/modules/contextPanel/prefHelpers";
import { createEvidenceWriter, validateReportLocation } from "./evidence";
import { snapshotFiles } from "./oracles";

declare const Zotero: any;
declare const IOUtils: any;
declare const PathUtils: any;
let started = false;

export async function runBehaviorSuite(requestPath: string): Promise<void> {
  if (started) return;
  started = true;
  const request = JSON.parse(await Zotero.File.getContentsAsync(requestPath));
  const secrets: string[] = [];
  const reportDir = request.reportDir as string;
  validateReportLocation(request.root, reportDir, requestPath);
  const write: Writer = createEvidenceWriter(reportDir, secrets, IOUtils);
  let rows: StepResult[] = [];
  const selected = selectSteps(request.tier, request.select);
  const original = {
    system: getConversationSystemPref(),
    mode: getOriginalAgentPermissionMode(),
    model: getLastUsedModelEntryId(),
    preferences: [
      "lastUsedRuntimeMode",
      "lastUsedReasoningLevelByProvider",
      "lastUsedReasoningLevel",
      "lastUsedConversationModeMap",
    ].map((key) => ({
      key: `extensions.zotero.llmforzotero.${key}`,
      value: Zotero.Prefs.get(`extensions.zotero.llmforzotero.${key}`, true),
    })),
  };
  let preferencesChanged = false;
  let completed = false;
  const checkpoint = async (results: StepResult[]) => {
    rows = results;
    await write("run.json", {
      schemaVersion: 1,
      request,
      completed,
      results,
      coverage: catalog.map((row) => ({
        ...row,
        result: results.find((result) => result.id === row.id) || {
          status: selected.some((selection) => selection.id === row.id)
            ? completed
              ? "BLOCKED"
              : "PENDING"
            : "SKIPPED_BY_SELECTION",
        },
      })),
    });
    await write(
      "summary.md",
      `# Manually invoked Zotero behavior report\n\nRun: ${request.runId}\nModel: ${request.model}, reasoning: ${request.reasoning}\n\nThis report is advisory and never gates release.\n\n${results.map((row) => `- ${row.status} — ${row.id}: ${row.detail} (${Math.round(row.durationMs / 1000)}s)`).join("\n")}\n\nSelected ${selected.length}/${catalog.length} contracts. Unselected contracts are SKIPPED_BY_SELECTION, not passes.\n\nSee run.json, events.jsonl, per-step native snapshots and vault/.\n`,
      true,
    );
  };
  try {
    check(
      __env__ === "development",
      "Behavior suite requires a development build",
    );
    check(
      String(Zotero.DataDirectory.dir).replace(/\/$/, "") ===
        request.data.replace(/\/$/, ""),
      "Zotero data directory differs from requested disposable profile",
    );
    check(
      PathUtils.profileDir === request.profile &&
        /\.zotero-dev$/.test(PathUtils.profileDir),
      "Refusing to mutate a non-zotero-dev profile",
    );
    // A dev reload must not replay already-started mutations.
    check(
      !(await IOUtils.exists(`${reportDir}/started.json`)),
      "This run already started. Invoke the command again for a fresh run; inspect partial evidence before retrying.",
    );
    await write("started.json", {
      at: new Date().toISOString(),
      zoteroVersion: Zotero.version,
      profile: PathUtils.profileDir,
      data: Zotero.DataDirectory.dir,
    });
    const bundle = await Zotero.File.getContentsAsync(
      `${request.root}/.scaffold/build/addon/content/scripts/llmforzotero.js`,
    );
    await write("build.json", {
      commit: request.commit,
      sourceFingerprint: request.fingerprint,
      dirty: request.dirty,
      runtimeBundleSHA256: await sha256Text(bundle),
      zoteroVersion: Zotero.version,
      platform: Zotero.platform,
      buildEnvironment: __env__,
    });
    const creds = await resolveLiveAgentCredentials({
      requestedModel: request.model,
      profilePath: `${request.profile}/prefs.js`,
    });
    check(
      creds && creds.model === request.model && creds.apiKey,
      `Missing configured credentials for ${request.model}; no live scenario ran`,
    );
    secrets.push(creds.apiKey);
    creds.reasoningLevel = request.reasoning;
    const entry = getRuntimeModelEntries().find(
      (row) => row.model === request.model && row.apiBase === creds.apiBase,
    );
    check(entry, "Requested model is not selectable in the UI");
    const harness = Zotero.LLMForZotero.api.workflowTest;
    check(harness, "Development workflow harness is unavailable");
    preferencesChanged = true;
    setConversationSystemPref("upstream");
    setOriginalAgentPermissionMode("auto");
    setLastUsedModelEntryId(entry.entryId);
    setLastUsedRuntimeMode("agent");
    setLastUsedReasoningLevelForProvider("deepseek", request.reasoning);
    await IOUtils.makeDirectory(`${reportDir}/vault`, { ignoreExisting: true });
    const fixtures = await createFixtures(request.runId.slice(-8), harness);
    await write("fixtures.json", {
      root: {
        id: fixtures.root.id,
        key: fixtures.root.key,
        name: fixtures.root.name,
      },
      items: Object.fromEntries(
        Object.entries(fixtures.items).map(([key, item]) => [
          key,
          {
            id: item.id,
            key: item.key,
            libraryID: item.libraryID,
            title: item.getField("title"),
          },
        ]),
      ),
      collections: Object.fromEntries(
        Object.entries(fixtures.collections).map(([key, c]) => [
          key,
          { id: c.id, key: c.key, name: c.name },
        ]),
      ),
      primary: fixtures.primary,
    });
    const context: JourneyContext = {
      fixtures,
      driver: new LiveDriver(creds, write, 720000, async () => ({
        native: await snapshot(),
        files: await snapshotFiles(`${reportDir}/vault`, IOUtils, sha256Bytes),
      })),
      harness,
      write,
      request,
    };
    await checkpoint([]);
    await runSteps(
      selected.map((step) => ({
        id: step.id,
        dependsOn: step.dependsOn,
        run: () => executeJourneyStep(step.id, context),
      })),
      checkpoint,
    );
  } catch (error) {
    rows.push({
      id: "suite.preflight",
      status: "BLOCKED",
      detail: String(error),
      startedAt: new Date().toISOString(),
      durationMs: 0,
    });
    await checkpoint(rows);
  } finally {
    if (preferencesChanged) {
      setConversationSystemPref(original.system);
      setOriginalAgentPermissionMode(original.mode);
      setLastUsedModelEntryId(original.model);
      for (const { key, value } of original.preferences) {
        if (value === undefined) Zotero.Prefs.clear(key, true);
        else Zotero.Prefs.set(key, value, true);
      }
      setWorkflowTestSendInterceptor(null);
      setWorkflowTestFinalRequestInterceptor(null);
    }
    await write(
      "manual-review.md",
      "# Human review\n\nNo automated prose-quality verdict is issued.\nRead generated notes, vault Markdown and research.review/review.md when present.\nAssess synthesis, unsupported claims, coverage, references, lost discussion points, figure crops and readable layout.\nRecord your judgment and document path here.\n\nComputer-use inspection is separate evidence: a programmatically captured screenshot alone is not a visual pass.\n\nDeferred coverage: real process restart/resume, post-effect timeout/retry, stale approval payload changes, duplicate-item merge, group-library fixtures and command execution are not covered by this version of the live suite.\n",
      true,
    );
    completed = true;
    await checkpoint(rows);
    await write("done.json", {
      completedAt: new Date().toISOString(),
      exitCode: reportExitCode(rows),
      results: rows,
    });
  }
}
