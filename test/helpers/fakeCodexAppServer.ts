/**
 * A scripted Codex app server behind the stdio child surface, for workflow
 * tests that run real Codex turns through the panel without codex.
 *
 * It answers every request the plugin sends: `thread/start` opens a new
 * thread, `turn/start` streams the next scripted answer and completes the
 * turn, and any other method gets an empty result. Archiving follows codex
 * 0.167 (probed 2026-11-27): only the process that holds a thread may
 * archive it (another gets "already has an active writer"), and an archived
 * thread is gone ("no rollout found"). Every request is kept,
 * so a test can read what each turn sent (`requests`, `turnStarts`).
 */
import {
  createFakeStdioProcess,
  type FakeStdioProcess,
} from "./fakeStdioProcess";

export type FakeCodexRequest = {
  method: string;
  params: Record<string, unknown>;
};

export type FakeCodexAppServer = {
  /** Starts a new app-server child; pass to the plugin's spawn seam. */
  launch: () => FakeStdioProcess;
  /** Every request the plugin sent, across children, in order. */
  requests: () => FakeCodexRequest[];
  /** The `turn/start` requests, in order. */
  turnStarts: () => FakeCodexRequest[];
  /** The text items of a `turn/start` input, joined. */
  turnText: (request: FakeCodexRequest) => string;
  /** How many children were launched. */
  launches: () => number;
  /** While true, `thread/archive` fails, as when codex cannot be reached. */
  setArchiveFails: (fails: boolean) => void;
  /** `thread/archive` answers after this many ms (0: at once). */
  setArchiveDelayMs: (ms: number) => void;
  /** While true, a started turn does not finish until `releaseTurns`. */
  setHoldTurns: (hold: boolean) => void;
  /** Finishes the turns held so far. */
  releaseTurns: () => void;
  /** The next `count` thread starts fail, as when codex cannot start one. */
  failThreadStarts: (count: number) => void;
};

const USER_AGENT = "codex_cli_rs/0.164.0 (Mac OS 15.0.0; arm64) workflow-test";

export function createFakeCodexAppServer(script: {
  /** The answers of successive turns; the last repeats. */
  answers: string[];
}): FakeCodexAppServer {
  const requests: FakeCodexRequest[] = [];
  // Each live thread and the child (app-server process) that writes it.
  const writers = new Map<string, FakeStdioProcess>();
  let threads = 0;
  let turns = 0;
  let launches = 0;
  let archiveFails = false;
  let archiveDelayMs = 0;
  let holdTurns = false;
  let failingThreadStarts = 0;
  const heldTurns: Array<() => void> = [];

  const answerFor = (index: number) =>
    script.answers[Math.min(index, script.answers.length - 1)] || "";

  const reply = (
    child: FakeStdioProcess,
    message: Record<string, unknown>,
  ): void => {
    const method = String(message.method || "");
    const id = message.id;
    const params = (message.params || {}) as Record<string, unknown>;
    if (id === undefined || !method) return; // a notification or a response
    requests.push({ method, params });
    const respond = (result: unknown) => child.emit({ id, result });
    const fail = (message: string) =>
      child.emit({ id, error: { code: -32600, message } });
    switch (method) {
      case "initialize":
        respond({ userAgent: USER_AGENT });
        return;
      case "thread/start":
      case "thread/fork": {
        if (method === "thread/start" && failingThreadStarts > 0) {
          failingThreadStarts -= 1;
          fail("could not start a thread");
          return;
        }
        threads += 1;
        writers.set(`fake-thread-${threads}`, child);
        respond({
          thread: { id: `fake-thread-${threads}`, path: null },
          model: String(params.model || "gpt-fake"),
        });
        return;
      }
      case "turn/start": {
        const threadId = String(params.threadId || "");
        const turnId = `fake-turn-${++turns}`;
        const itemId = `fake-message-${turns}`;
        const text = answerFor(turns - 1);
        respond({ turn: { id: turnId, status: "inProgress" } });
        // After the response, as codex does: the turn's events.
        const finish = () => {
          child.emit({
            method: "turn/started",
            params: { threadId, turn: { id: turnId, status: "inProgress" } },
          });
          child.emit({
            method: "item/started",
            params: {
              threadId,
              turnId,
              item: { type: "agentMessage", id: itemId, text: "" },
            },
          });
          child.emit({
            method: "item/agentMessage/delta",
            params: { threadId, turnId, itemId, delta: text },
          });
          child.emit({
            method: "item/completed",
            params: {
              threadId,
              turnId,
              item: { type: "agentMessage", id: itemId, text },
            },
          });
          child.emit({
            method: "turn/completed",
            params: { threadId, turn: { id: turnId, status: "completed" } },
          });
        };
        if (holdTurns) heldTurns.push(finish);
        else setTimeout(finish, 20);
        return;
      }
      case "thread/archive": {
        const threadId = String(params.threadId || "");
        const answer = () => {
          if (archiveFails) {
            fail("codex app-server is not answering");
            return;
          }
          const writer = writers.get(threadId);
          if (!writer) {
            fail(`no rollout found for thread id ${threadId}`);
            return;
          }
          if (writer !== child) {
            fail(`thread ${threadId} already has an active writer`);
            return;
          }
          writers.delete(threadId);
          respond({});
        };
        if (archiveDelayMs) setTimeout(answer, archiveDelayMs);
        else answer();
        return;
      }
      case "permissionProfile/list":
        // The built-in profiles a current codex lists.
        respond({
          data: [
            { id: ":read-only", description: "Read files only." },
            { id: ":workspace", description: "Write in the workspace." },
            { id: ":danger-full-access", description: "No sandbox." },
          ],
        });
        return;
      default:
        if (method.endsWith("/list")) {
          respond({ data: [] });
          return;
        }
        respond({});
    }
  };

  return {
    launch: () => {
      launches += 1;
      const child = createFakeStdioProcess();
      child.onSent((message) => reply(child, message));
      return child;
    },
    requests: () => [...requests],
    turnStarts: () =>
      requests.filter((request) => request.method === "turn/start"),
    turnText: (request) =>
      (Array.isArray(request.params.input) ? request.params.input : [])
        .map((item: { type?: unknown; text?: unknown }) =>
          item?.type === "text" && typeof item.text === "string"
            ? item.text
            : "",
        )
        .filter(Boolean)
        .join("\n"),
    launches: () => launches,
    setArchiveFails: (fails) => {
      archiveFails = fails;
    },
    setArchiveDelayMs: (ms) => {
      archiveDelayMs = ms;
    },
    setHoldTurns: (hold) => {
      holdTurns = hold;
    },
    releaseTurns: () => {
      for (const finish of heldTurns.splice(0)) finish();
    },
    failThreadStarts: (count) => {
      failingThreadStarts = count;
    },
  };
}
