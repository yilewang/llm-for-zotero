/**
 * Live reproduction of the 2026-10-02 library-chat lag report.
 *
 * Seeds the same 12 papers (PDF + MinerU full.md from a fixture directory),
 * opens a Library chat in the real panel, switches to Agent mode, picks the
 * live model, and sends the exact prompt through the composer. While the turn
 * runs it samples main-thread stalls (timer drift + rAF gaps), counts
 * Zotero.DB.queryAsync calls by statement, and records a Gecko profile.
 *
 * Acceptance (host-owned per-paper digests): the summaries part reports
 * digest 12 of 12, every paper row has a digest summary and a verified
 * evidence passage, the answer names every paper, one accepted
 * submit_document, wall time within 325 s, and no main-thread stall over
 * 300 ms between the first and last digest ledger update. Each failed check
 * is collected into summary.json's `violations` before the test asserts.
 *
 *   LLM_FOR_ZOTERO_TEST_ENTRIES=test-live/perf \
 *   LLM_FOR_ZOTERO_LIVE_MODEL=deepseek-flash \
 *   LLM_FOR_ZOTERO_LIVE_PROFILE_PATH=<prefs.js with the provider> \
 *   LLM_FOR_ZOTERO_PERF_REPORT_DIR=<dir> \
 *   LLM_FOR_ZOTERO_PERF_PAPERS_DIR=<dir with name.pdf, name.md, name.json> \
 *   node scripts/run-workflow-tests.mjs --agent-live
 */
import { assert } from "chai";
import { resolveLiveAgentCredentials } from "../agent/liveAgentCredentials";
import {
  writeMineruCacheFiles,
  writeMineruSourceProvenanceForAttachment,
} from "../../src/services/mineru/mineruCache";
import type { WorkflowTestApi } from "../../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;
declare const IOUtils: any;
declare const PathUtils: any;
declare const Services: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero";
const MODEL_ENTRY_ID = "live-perf-model";
const PROMPT = "summarize all papers for me and write a literature review";
/** 1.3 times the 250 s baseline of the 2026-10-02 report. */
const MAX_TURN_MS = 325_000;
/** Longest main-thread stall allowed while the host writes the digests. */
const MAX_DIGEST_STALL_MS = 300;

function env(name: string): string {
  try {
    return String(Services.env.get(name) || "");
  } catch {
    return "";
  }
}

const reportDir = env("LLM_FOR_ZOTERO_PERF_REPORT_DIR");
const papersDir = env("LLM_FOR_ZOTERO_PERF_PAPERS_DIR");
const requestedModel = env("LLM_FOR_ZOTERO_LIVE_MODEL") || "deepseek-flash";
const profilerEnabled = env("LLM_FOR_ZOTERO_PERF_PROFILER") !== "0";

async function write(name: string, value: unknown) {
  const path = PathUtils.join(reportDir, name);
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  await IOUtils.writeUTF8(path, text);
  return path;
}

type Histogram = Record<string, number>;
function bucket(ms: number): string {
  if (ms < 50) return "<50";
  if (ms < 100) return "50-100";
  if (ms < 250) return "100-250";
  if (ms < 500) return "250-500";
  if (ms < 1000) return "500-1000";
  return ">=1000";
}

/** Timer-drift + rAF-gap sampler for one window. */
function startStallSampler(win: any) {
  const timerHist: Histogram = {};
  const rafHist: Histogram = {};
  const timeline: Array<{ t: number; stall: number }> = [];
  /** Each timer lateness of 50 ms or more, at its wall-clock end. */
  const samples: Array<{ at: number; ms: number }> = [];
  const start = win.performance.now();
  let expected = start + 50;
  let timerStalls = 0;
  let timerStallTotal = 0;
  let timerMax = 0;
  let rafMax = 0;
  let rafFrames = 0;
  let rafGapTotal = 0;
  const interval = win.setInterval(() => {
    const now = win.performance.now();
    const late = now - expected;
    expected = now + 50;
    const key = bucket(late);
    timerHist[key] = (timerHist[key] || 0) + 1;
    if (late >= 50) {
      timerStalls += 1;
      timerStallTotal += late;
      timeline.push({ t: Math.round(now - start), stall: Math.round(late) });
      samples.push({ at: Date.now(), ms: Math.round(late) });
    }
    timerMax = Math.max(timerMax, late);
  }, 50);
  let last = win.performance.now();
  let running = true;
  const onFrame = () => {
    if (!running) return;
    const now = win.performance.now();
    const gap = now - last;
    last = now;
    rafFrames += 1;
    rafGapTotal += gap;
    const key = bucket(gap);
    rafHist[key] = (rafHist[key] || 0) + 1;
    rafMax = Math.max(rafMax, gap);
    win.requestAnimationFrame(onFrame);
  };
  win.requestAnimationFrame(onFrame);
  return {
    stop() {
      running = false;
      win.clearInterval(interval);
      const elapsed = win.performance.now() - start;
      return {
        elapsedMs: Math.round(elapsed),
        timer: {
          histogram: timerHist,
          stalls50msPlus: timerStalls,
          stalledMsTotal: Math.round(timerStallTotal),
          stalledShare: Number((timerStallTotal / elapsed).toFixed(3)),
          maxLateMs: Math.round(timerMax),
        },
        raf: {
          histogram: rafHist,
          frames: rafFrames,
          meanGapMs: Number((rafGapTotal / Math.max(1, rafFrames)).toFixed(1)),
          maxGapMs: Math.round(rafMax),
        },
        worstStalls: [...timeline]
          .sort((a, b) => b.stall - a.stall)
          .slice(0, 25),
        timeline,
        samples,
      };
    },
  };
}

/** Lowercase, whitespace-collapsed text for title matching. */
function normalizeText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Counts Zotero.DB.queryAsync calls and awaited time by statement head. */
function startDbCounter() {
  const original = Zotero.DB.queryAsync;
  const byStatement: Record<string, { calls: number; awaitedMs: number }> = {};
  let total = 0;
  Zotero.DB.queryAsync = async function (sql: string, ...rest: any[]) {
    const head = String(sql || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 70);
    const t = Date.now();
    try {
      return await original.call(this, sql, ...rest);
    } finally {
      const entry = (byStatement[head] ||= { calls: 0, awaitedMs: 0 });
      entry.calls += 1;
      entry.awaitedMs += Date.now() - t;
      total += 1;
    }
  };
  return {
    stop() {
      Zotero.DB.queryAsync = original;
      const top = Object.entries(byStatement)
        .sort((a, b) => b[1].calls - a[1].calls)
        .slice(0, 15)
        .map(([statement, stats]) => ({ statement, ...stats }));
      return { totalCalls: total, top };
    },
  };
}

async function withPrefs<T>(
  prefs: Record<string, unknown>,
  task: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, unknown>();
  for (const [key, value] of Object.entries(prefs)) {
    const fullKey = `${PREF_PREFIX}.${key}`;
    previous.set(fullKey, Zotero.Prefs.get(fullKey, true));
    Zotero.Prefs.set(fullKey, value, true);
  }
  try {
    return await task();
  } finally {
    for (const [fullKey, value] of previous) {
      if (value === undefined) Zotero.Prefs.clear?.(fullKey, true);
      else Zotero.Prefs.set(fullKey, value, true);
    }
  }
}

describe("live perf: agent library chat lag", function () {
  this.timeout(900_000);

  it("records stalls, DB writes and a profile for the 12-paper review prompt", async function () {
    if (!reportDir || !papersDir) {
      this.skip();
      return;
    }
    const creds = await resolveLiveAgentCredentials({ requestedModel });
    assert.isOk(
      creds,
      `model ${requestedModel} must be configured in the live profile`,
    );
    const api = Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
    await api.reset();
    const libraryID = Zotero.Libraries.userLibraryID;
    const win = Zotero.getMainWindow();

    // Seed the papers.
    const names = (await IOUtils.getChildren(papersDir))
      .map((p: string) => PathUtils.filename(p))
      .filter((n: string) => n.endsWith(".json"))
      .map((n: string) => n.slice(0, -5))
      .sort();
    assert.isAbove(names.length, 0, "fixture papers present");
    const refs: any[] = [];
    const seedStart = Date.now();
    for (const name of names) {
      const meta = JSON.parse(
        String(await IOUtils.readUTF8(`${papersDir}/${name}.json`)),
      );
      const markdown = String(
        await IOUtils.readUTF8(`${papersDir}/${name}.md`),
      );
      const item = new Zotero.Item("journalArticle");
      item.libraryID = libraryID;
      item.setField("title", meta.title);
      item.setField("date", String(meta.date || "").slice(0, 4));
      item.setCreators(
        (meta.creators || []).map((c: any) => ({
          creatorType: "author",
          firstName: c.firstName || "",
          lastName: c.lastName || "",
        })),
      );
      const itemId = Number(await item.saveTx());
      const attachment = await Zotero.Attachments.importFromFile({
        file: `${papersDir}/${name}.pdf`,
        parentItemID: itemId,
        contentType: "application/pdf",
      });
      await writeMineruCacheFiles(attachment.id, markdown, [
        { relativePath: "full.md", data: new TextEncoder().encode(markdown) },
      ]);
      await writeMineruSourceProvenanceForAttachment(attachment);
      refs.push({
        libraryID,
        itemId,
        contextItemId: attachment.id,
        title: meta.title,
        firstCreator: String(meta.creators?.[0]?.lastName || ""),
        year: String(meta.date || "").slice(0, 4),
      });
    }
    const seedMs = Date.now() - seedStart;

    await withPrefs(
      {
        conversationSystem: "upstream",
        enableAgentMode: true,
        enableClaudeCodeMode: false,
        enableCodexAppServerMode: false,
        modelProviderGroups: JSON.stringify([
          {
            id: "live-perf-provider",
            apiBase: creds!.apiBase,
            apiKey: creds!.apiKey,
            authMode: "api_key",
            providerProtocol: creds!.providerProtocol,
            models: [
              {
                id: MODEL_ENTRY_ID,
                model: creds!.model,
                temperature: 0.3,
                outputTokenLimit: { mode: "auto" },
              },
            ],
          },
        ]),
        modelProviderGroupsMigrationVersion: 3,
        lastUsedModelEntryId: MODEL_ENTRY_ID,
        lastUsedRuntimeMode: "agent",
        lastUsedReasoningLevelByProvider: JSON.stringify({ deepseek: "auto" }),
      },
      async () => {
        const panel = await api.renderPanelForItem(refs[0].itemId);
        let diag = await api.getDiagnostics(panel.panelId);
        if (diag.conversationKind !== "global") {
          diag = await api.togglePanelConversationMode(panel.panelId);
        }
        assert.equal(
          diag.conversationKind,
          "global",
          "panel is a Library chat",
        );
        await api.setTaskProgressComposerContexts({
          panelId: panel.panelId,
          paperContexts: refs,
        });
        const contexts = await api.readTaskProgressComposerContexts({
          panelId: panel.panelId,
        });
        assert.equal(
          contexts.paperItemIds.length,
          refs.length,
          "all papers attached",
        );
        await api.selectPanelModelEntry(panel.panelId, MODEL_ENTRY_ID);
        diag = await api.getDiagnostics(panel.panelId);
        // The built-in runtime is Agent whenever the Agent feature is on.
        assert.equal(diag.runtimeMode, "agent", "Agent mode is on");
        const conversationKey = diag.panelConversationKey;

        // Instrumentation.
        const sampler = startStallSampler(win);
        const db = startDbCounter();
        let profilePath: string | null = null;
        if (profilerEnabled && Services.profiler) {
          try {
            await Services.profiler.StartProfiler(
              16 * 1024 * 1024,
              1,
              ["js", "stackwalk", "cpu", "processcpu"],
              ["GeckoMain"],
            );
          } catch (error) {
            await write("profiler-error.txt", String(error));
          }
        }
        const t0 = Date.now();
        let turn: any = null;
        let turnError: string | null = null;
        try {
          turn = await api.sendLiveChatTurn(panel.panelId, PROMPT, 840_000);
        } catch (error) {
          turnError = String((error as Error)?.stack || error);
        }
        const turnMs = Date.now() - t0;
        const warnings: string[] = [];
        const violations: string[] = [];
        const stalls = sampler.stop();
        const dbStats = db.stop();
        if (profilerEnabled && Services.profiler?.IsActive?.()) {
          try {
            profilePath = PathUtils.join(reportDir, "profile.json");
            await Services.profiler.dumpProfileToFileAsync(profilePath);
          } catch (error) {
            await write("profiler-dump-error.txt", String(error));
            profilePath = null;
          } finally {
            Services.profiler.StopProfiler();
          }
        }

        // Run events as persisted.
        const runs = await Zotero.DB.queryAsync(
          "SELECT run_id, status, created_at, completed_at FROM llm_for_zotero_agent_runs WHERE conversation_key = ? ORDER BY created_at DESC LIMIT 1",
          [String(conversationKey)],
        );
        const runId = runs?.[0]?.run_id;
        // The harness can throw after the run already completed (a late
        // wrapper or DOM check). Record that as a warning and read the answer
        // from the conversation instead of failing the run.
        if (turnError && runs?.[0]?.status === "completed") {
          warnings.push(
            `sendLiveChatTurn threw after the run completed: ${turnError}`,
          );
          const history = await api.getConversationHistoryTexts(
            Number(conversationKey),
          );
          const lastAssistant = (
            texts: Array<{ role: string; text: string }>,
          ) =>
            [...texts].reverse().find((entry) => entry.role === "assistant")
              ?.text || "";
          turn = {
            answerText:
              lastAssistant(history.memory) || lastAssistant(history.stored),
            assistantFinalized: undefined,
          };
          turnError = null;
        }
        const eventRows = runId
          ? await Zotero.DB.queryAsync(
              "SELECT event_type, COUNT(*) AS n, SUM(LENGTH(payload_json)) AS bytes FROM llm_for_zotero_agent_run_events WHERE run_id = ? GROUP BY event_type ORDER BY n DESC",
              [runId],
            )
          : [];
        const events = (eventRows || []).map((r: any) => ({
          type: r.event_type,
          count: r.n,
          bytes: r.bytes,
        }));
        const toolCalls = runId
          ? await Zotero.DB.queryAsync(
              "SELECT seq, event_type, created_at, SUBSTR(payload_json, 1, 400) AS head FROM llm_for_zotero_agent_run_events WHERE run_id = ? AND event_type IN ('tool_call','tool_error','message_rollback','status') ORDER BY seq",
              [runId],
            )
          : [];
        const snapshot = conversationKey
          ? await api.getTaskProgressSnapshot(conversationKey)
          : null;
        const digestWindowRows = runId
          ? await Zotero.DB.queryAsync(
              "SELECT MIN(created_at) AS first_at, MAX(created_at) AS last_at, COUNT(*) AS n FROM llm_for_zotero_agent_run_events WHERE run_id = ? AND event_type = 'paper_ledger_update' AND payload_json LIKE ?",
              [runId, '%"granularity":"digest"%'],
            )
          : [];

        // Acceptance checks, collected so one failure still records the rest.
        const check = (ok: unknown, message: string) => {
          if (!ok) violations.push(message);
        };
        check(!turnError, `the turn failed: ${turnError}`);
        const steps = snapshot?.checklist?.steps || [];
        const summaries = steps.find((step) => step.outcome?.digest);
        check(summaries, "a digest part was declared");
        if (summaries?.outcome) {
          check(
            summaries.outcome.targets === refs.length,
            `summaries targets ${summaries.outcome.targets}, expected ${refs.length}`,
          );
          check(
            summaries.outcome.doneTargets === refs.length,
            `summaries ${summaries.outcome.doneTargets} of ${refs.length} done`,
          );
          check(
            summaries.status === "completed",
            `summaries status is ${summaries.status}`,
          );
        }
        const answerText = normalizeText(turn?.answerText || "");
        const missingTitles: string[] = [];
        for (const ref of refs) {
          const row = snapshot?.paperRows?.[`${libraryID}:${ref.itemId}`];
          check(row, `no paper row for ${ref.title}`);
          const reads = row?.reads || [];
          check(
            reads.find((read) => read.granularity === "digest" && read.snippet),
            `${ref.title} has no digest summary`,
          );
          check(
            reads.find(
              (read) =>
                read.granularity === "passage" && read.method === "digest",
            ),
            `${ref.title} has no verified digest evidence passage`,
          );
          const titleHead = normalizeText(ref.title).slice(0, 40);
          if (!answerText.includes(titleHead)) missingTitles.push(ref.title);
        }
        check(
          !missingTitles.length,
          `the answer does not name: ${missingTitles.join(" | ")}`,
        );
        const submitRows = (toolCalls || []).filter((row: any) =>
          String(row.head || "").includes('"name":"submit_document"'),
        );
        const submitCalls = submitRows.filter(
          (row: any) => row.event_type === "tool_call",
        ).length;
        const submitErrors = submitRows.filter(
          (row: any) => row.event_type === "tool_error",
        ).length;
        check(
          submitCalls === 1,
          `${submitCalls} submit_document calls, expected 1`,
        );
        check(
          submitErrors === 0,
          `${submitErrors} submit_document tool errors, expected 0`,
        );
        check(
          turnMs <= MAX_TURN_MS,
          `turn took ${turnMs} ms, over ${MAX_TURN_MS} ms`,
        );
        const digestFirstAt = Number(digestWindowRows?.[0]?.first_at) || 0;
        const digestLastAt = Number(digestWindowRows?.[0]?.last_at) || 0;
        const digestUpdates = Number(digestWindowRows?.[0]?.n) || 0;
        // A late timer tick at `at` covers the stall [at - ms, at].
        const digestStalls = digestUpdates
          ? stalls.samples.filter(
              (sample) =>
                sample.at >= digestFirstAt &&
                sample.at - sample.ms <= digestLastAt,
            )
          : [];
        const digestMaxStallMs = digestStalls.reduce(
          (max, sample) => Math.max(max, sample.ms),
          0,
        );
        check(digestUpdates > 0, "no digest paper_ledger_update was recorded");
        check(
          digestMaxStallMs <= MAX_DIGEST_STALL_MS,
          `main-thread stall of ${digestMaxStallMs} ms during the digest phase, over ${MAX_DIGEST_STALL_MS} ms`,
        );

        await write("summary.json", {
          model: creds!.model,
          protocol: creds!.providerProtocol,
          papers: refs.length,
          seedMs,
          turnMs,
          turnError,
          answerChars: turn?.answerText?.length || 0,
          assistantFinalized: turn?.assistantFinalized,
          stalls,
          db: dbStats,
          run: runs?.[0]
            ? {
                runId: runs[0].run_id,
                status: runs[0].status,
                createdAt: runs[0].created_at,
                completedAt: runs[0].completed_at,
              }
            : null,
          events,
          profilePath,
          taskProgress: snapshot,
          digestPhase: {
            updates: digestUpdates,
            firstAt: digestFirstAt || null,
            lastAt: digestLastAt || null,
            durationMs: digestUpdates ? digestLastAt - digestFirstAt : null,
            maxStallMs: digestMaxStallMs,
            stalls: digestStalls,
          },
          submitDocument: { calls: submitCalls, errors: submitErrors },
          missingTitles,
          warnings,
          violations,
        });
        await write(
          "tool-timeline.json",
          (toolCalls || []).map((r: any) => ({
            seq: r.seq,
            tOffsetS: runs?.[0]
              ? Number(((r.created_at - runs[0].created_at) / 1000).toFixed(1))
              : null,
            head: r.head,
          })),
        );
        await write("answer.md", turn?.answerText || turnError || "");
        assert.deepEqual(violations, [], violations.join("\n"));
      },
    );
  });
});
