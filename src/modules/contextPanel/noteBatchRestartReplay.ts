/**
 * Native acceptance fixture for a note batch that survives a real Zotero
 * restart. The model is scripted; the runtime, note_write_batch, its notes,
 * the change journal and the panel's send flow are the real ones.
 *
 * Two functions, one for each Zotero process (test-workflows/
 * noteBatchRestart.workflow.test.ts): `startNoteBatchUntilQuit` writes a
 * batch of notes and ends this Zotero process while the batch writes;
 * `resumeNoteBatchAfterRestart` runs in the next process and answers
 * "continue".
 */
import { getConversationKey } from "./chat";
import { listAgentRunsForConversation } from "../../agent/store/traceStore";
import { listResumableBatches } from "../../agent/store/batchItemStore";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../../agent/originalAgentPermissionMode";
import { scriptedJobTurn } from "./longJobReplay";
import { ExecutionCheckpointFold } from "../../agent/execution/checkpointEvents";
import type { CollectionContextRef } from "../../shared/types";
import type { TaskPaperScopeSet } from "../../agent/context/taskPaperScopeListing";
import type {
  AgentModelMessage,
  AgentModelStep,
  AgentToolCall,
} from "../../agent/types";

const NOTE_ALL = "Write a short reading note on each paper";

type PanelRef = { body: HTMLElement; item: Zotero.Item };
type JobInput = {
  collection: CollectionContextRef;
  papers: Array<{ itemId: number; title: string }>;
  inputTokenCap: number;
};

function contentText(message: AgentModelMessage): string {
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

function scopeOf(input: JobInput): TaskPaperScopeSet {
  const ids = input.papers.map((paper) => paper.itemId);
  return {
    wholeLibrary: false,
    itemIds: ids,
    withText: ids.length,
    papers: Object.fromEntries(
      input.papers.map((paper) => [
        paper.itemId,
        { title: paper.title, text: "pdf" as const },
      ]),
    ),
  };
}

function toolStep(calls: AgentToolCall[]): AgentModelStep {
  return {
    kind: "tool_calls",
    calls,
    assistantMessage: { role: "assistant", content: "", tool_calls: calls },
  };
}

function final(text: string): AgentModelStep {
  return {
    kind: "final",
    text,
    assistantMessage: { role: "assistant", content: text },
  };
}

let callCounter = 0;
function readCall(itemId: number, libraryID: number): AgentToolCall {
  return {
    id: `read-${itemId}-${(callCounter += 1)}`,
    name: "paper_read",
    arguments: { target: { itemId, contextItemId: itemId, libraryID } },
  };
}
/**
 * One note_write_batch over `papers`. A child note is written onto each
 * paper. A standalone note is filed into `collectionId` and cites its paper,
 * so its body is built from that paper's current metadata. With
 * `notesPerPaper: 2` each paper gets two child notes in a row, the second
 * with its own body, so the batch has rows `item:N` and `item:N#2`.
 */
function batchCall(
  papers: number[],
  target: "item" | "standalone" = "item",
  collectionId?: number,
  notesPerPaper: 1 | 2 = 1,
): AgentToolCall {
  return {
    id: `batch-${(callCounter += 1)}`,
    name: "note_write_batch",
    arguments: {
      target,
      notes: papers.flatMap((itemId) =>
        target === "standalone"
          ? [
              {
                targetItemId: itemId,
                collections: collectionId ? [collectionId] : [],
                content: `# Paper ${itemId}\n\nReading note on the finding of {{cite item=${itemId}}}.`,
              },
            ]
          : [
              {
                targetItemId: itemId,
                content: `# Paper ${itemId}\n\nReading note on the finding of paper ${itemId}.`,
              },
              ...(notesPerPaper === 2
                ? [
                    {
                      targetItemId: itemId,
                      content: `# Paper ${itemId}, second note\n\nA second reading note on paper ${itemId}.`,
                    },
                  ]
                : []),
            ],
      ),
    },
  };
}

/** The `resume.blocked` rows a note_write_batch result reports, if any. */
function resumeBlocked(
  content: unknown,
): Array<{ itemKey: string; reason: string }> {
  const seen = new Set<unknown>();
  const visit = (
    value: unknown,
  ): Array<{ itemKey: string; reason: string }> => {
    if (!value || typeof value !== "object" || seen.has(value)) return [];
    seen.add(value);
    const resume = (value as { resume?: { blocked?: unknown } }).resume;
    if (resume && Array.isArray(resume.blocked))
      return resume.blocked.map(
        (entry: { itemKey?: unknown; reason?: unknown }) => ({
          itemKey: String(entry?.itemKey ?? ""),
          reason: String(entry?.reason ?? ""),
        }),
      );
    for (const child of Object.values(value)) {
      const found = visit(child);
      if (found.length) return found;
    }
    return [];
  };
  return visit(content);
}

/** The notes a note_write_batch result reports with status "error". */
function failedNotes(
  content: unknown,
): Array<{ itemKey: string; reason: string }> {
  const seen = new Set<unknown>();
  const found: Array<{ itemKey: string; reason: string }> = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const notes = (value as { notes?: unknown }).notes;
    if (Array.isArray(notes))
      for (const note of notes as Array<Record<string, unknown>>)
        if (note?.status === "error")
          found.push({
            itemKey: String(note.itemKey ?? ""),
            reason: String(note.reason ?? ""),
          });
    for (const child of Object.values(value)) visit(child);
  };
  visit(content);
  return found;
}

/** The conversation key this panel's chat is stored under. */
export function panelConversationKey(panel: PanelRef): number {
  return getConversationKey(panel.item);
}

/**
 * Ends this Zotero process once `killAfterNotes` new notes exist (a child
 * note of one of the papers, or with `standalone` a standalone note filed
 * into the collection):
 * - `crash`: SIGKILL aimed at this process id only; nothing runs after it.
 * - `quit`: a forced application quit.
 */
function endProcessAfterNotes(params: {
  paperIds: ReadonlySet<number>;
  standalone: boolean;
  collectionId: number;
  killAfterNotes: number;
  variant: "crash" | "quit";
}): { notesSeen: () => number } {
  let notesSeen = 0;
  let ended = false;
  Zotero.Notifier.registerObserver(
    {
      notify(event: string, type: string, addedIds: Array<number | string>) {
        if (event !== "add" || type !== "item" || ended) return;
        for (const id of addedIds) {
          const added = Zotero.Items.get(Number(id));
          if (!added?.isNote()) continue;
          if (
            params.standalone
              ? !added.parentID &&
                added.getCollections().includes(params.collectionId)
              : params.paperIds.has(Number(added.parentID))
          )
            notesSeen += 1;
        }
        if (notesSeen < params.killAfterNotes) return;
        ended = true;
        if (params.variant === "quit") {
          // eForceQuit: leave without waiting for windows or the batch.
          (
            Services as unknown as { startup: { quit: (mode: number) => void } }
          ).startup.quit(3);
          return;
        }
        // The kill names this process id only, never a process name. The
        // blocking call does not return: the kill ends this process.
        const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        file.initWithPath("/bin/kill");
        const process = Cc["@mozilla.org/process/util;1"].createInstance(
          Ci.nsIProcess,
        );
        process.init(file);
        process.run(true, ["-9", String(Services.appinfo.processID)], 2);
      },
    },
    ["item"],
    "llm-note-batch-restart",
  );
  return { notesSeen: () => notesSeen };
}

/**
 * Sends the first turn of a note job: the model reads every paper, then
 * writes all the notes in one note_write_batch. When the batch's
 * `killAfterNotes`th note exists, this Zotero process ends
 * (`endProcessAfterNotes`). The function does not return while the process
 * ends; if it returns, the process did not end.
 */
export async function startNoteBatchUntilQuit(
  panel: PanelRef,
  input: JobInput & {
    killAfterNotes: number;
    variant: "crash" | "quit";
    target?: "item" | "standalone";
    notesPerPaper?: 1 | 2;
  },
): Promise<{ survived: true; notesSeen: number }> {
  const { body, item } = panel;
  body.style.left = "0";
  body.style.width = "420px";
  body.style.zIndex = "99999";
  const ids = input.papers.map((paper) => paper.itemId);
  const standalone = input.target === "standalone";
  setOriginalAgentPermissionMode("auto");
  const observer = endProcessAfterNotes({
    paperIds: new Set(ids),
    standalone,
    collectionId: input.collection.collectionId,
    killAfterNotes: input.killAfterNotes,
    variant: input.variant,
  });
  let declared = false;
  let readUpTo = 0;
  let batched = false;
  await scriptedJobTurn(panel, {
    collection: input.collection,
    scope: scopeOf(input),
    inputTokenCap: input.inputTokenCap,
    writeTool: "note_write_batch",
    paperCharacters: 1_200,
    question: `Write a short reading note for each paper in ${input.collection.name}`,
    step: () => {
      if (!declared) {
        declared = true;
        return toolStep([
          {
            id: "declare-1",
            name: "task_update",
            arguments: {
              tasks: [
                {
                  taskId: "read-all",
                  description: `Read each paper in ${input.collection.name}`,
                  expectedEffect: "read",
                  scope: true,
                },
                {
                  taskId: "note-all",
                  description: NOTE_ALL,
                  expectedEffect: "mutation",
                  expectedCapability: "zotero.notes",
                  scope: true,
                },
              ],
            },
          },
        ]);
      }
      if (readUpTo < ids.length) {
        const papers = ids.slice(readUpTo, readUpTo + 10);
        readUpTo += papers.length;
        return toolStep(papers.map((id) => readCall(id, item.libraryID)));
      }
      if (!batched) {
        batched = true;
        return toolStep([
          batchCall(
            ids,
            standalone ? "standalone" : "item",
            input.collection.collectionId,
            input.notesPerPaper,
          ),
        ]);
      }
      return final("Every paper has its note.");
    },
  });
  // Only reached when the process did not end.
  return { survived: true, notesSeen: observer.notesSeen() };
}

/**
 * The "continue" turn in the new process. The model resumes the stopped
 * batch by the id the host names (or by `resumeBatchId`), then writes a note
 * again on the papers in `rewritePapers`, whose notes the user trashed
 * meanwhile.
 *
 * With `retryPapers` the model does not resume: it issues a new
 * note_write_batch over those papers, as a model that re-sends the call
 * after a restart does. With `killAfterNotes` this process ends once that
 * many new notes exist on the papers (`endProcessAfterNotes`), and the
 * function does not return.
 */
export async function resumeNoteBatchAfterRestart(
  panel: PanelRef,
  input: JobInput & {
    rewritePapers: number[];
    resumeBatchId?: string;
    retryPapers?: number[];
    killAfterNotes?: number;
  },
) {
  const key = getConversationKey(panel.item);
  const previousMode = getOriginalAgentPermissionMode();
  setOriginalAgentPermissionMode("auto");
  if (input.killAfterNotes)
    endProcessAfterNotes({
      paperIds: new Set(input.papers.map((paper) => paper.itemId)),
      standalone: false,
      collectionId: input.collection.collectionId,
      killAfterNotes: input.killAfterNotes,
      variant: "crash",
    });
  try {
    const priorRun = (await listAgentRunsForConversation(key)).at(-1);
    const resumable = await listResumableBatches(key);
    let resumeBatchId = "";
    let resumed = false;
    let rewritten = false;
    const turn = await scriptedJobTurn(panel, {
      collection: input.collection,
      scope: scopeOf(input),
      inputTokenCap: input.inputTokenCap,
      writeTool: "note_write_batch",
      paperCharacters: 1_200,
      question: "continue",
      step: (messages) => {
        if (!resumed && input.retryPapers?.length) {
          resumed = true;
          return toolStep([batchCall(input.retryPapers)]);
        }
        if (!resumed) {
          resumed = true;
          resumeBatchId =
            input.resumeBatchId ||
            /resumeBatchId=([^;\s]+)/.exec(
              messages.map(contentText).join("\n"),
            )?.[1] ||
            "";
          if (resumeBatchId)
            return toolStep([
              {
                id: `batch-${(callCounter += 1)}`,
                name: "note_write_batch",
                arguments: { resumeBatchId },
              },
            ]);
        }
        if (!rewritten && input.rewritePapers.length) {
          rewritten = true;
          return toolStep([batchCall(input.rewritePapers)]);
        }
        return final("Every paper has its note.");
      },
    });
    const appliedBy = (
      receipts:
        | readonly import("../../agent/types").AgentActionReceipt[]
        | undefined,
    ) =>
      (receipts || []).flatMap((receipt) =>
        receipt.verification === "verified" &&
        (receipt.status === "applied" || receipt.status === "partial")
          ? receipt.appliedTargets.map((target) =>
              Number(target.replace(/^item:/, "")),
            )
          : [],
      );
    const batchResults = turn.events.flatMap((event) =>
      event.type === "tool_result" && event.name === "note_write_batch"
        ? [
            {
              ok: event.ok,
              error: String(
                (event.content as { error?: unknown } | undefined)?.error || "",
              ),
              applied: appliedBy(event.actionReceipts),
              // The rows a resume refused before writing, with the reason.
              blocked: resumeBlocked(event.content),
              // The notes the call reported as not written, with the reason.
              failedNotes: failedNotes(event.content),
            },
          ]
        : [],
    );
    // The ledger the resumed run published first, before any model step,
    // and the one it ended with.
    const firstCheckpoint = turn.events.flatMap((event) =>
      event.type === "execution_checkpoint" ? [event.checkpoint] : [],
    )[0];
    const fold = new ExecutionCheckpointFold();
    for (const event of turn.events) fold.apply(event);
    const notePartOf = (checkpoint: typeof firstCheckpoint | undefined) =>
      checkpoint?.tasks.find((task) => task.taskId.endsWith(":task:note-all"));
    const notePart = notePartOf(firstCheckpoint);
    const finalNotePart = notePartOf(fold.latest);
    // What each receipt of this turn's note writes names, by receipt id.
    const toolReceipts = Object.fromEntries(
      turn.events.flatMap((event) =>
        event.type === "tool_result" && event.name === "note_write_batch"
          ? (event.actionReceipts || []).map((receipt) => [
              receipt.id,
              {
                status: receipt.status,
                verification: receipt.verification,
                reasons: [...(receipt.reasons || [])],
                appliedTargets: [...receipt.appliedTargets],
                alreadySatisfiedTargets: [...receipt.alreadySatisfiedTargets],
              },
            ])
          : [],
      ),
    );
    return {
      conversationKey: key,
      priorRun: priorRun
        ? {
            runId: priorRun.runId,
            status: priorRun.status,
            finalText: priorRun.finalText || "",
          }
        : null,
      resumableBatchIds: resumable.map((batch) => batch.batchId),
      resumeBatchId,
      runStatus: turn.runStatus,
      end: turn.end,
      batchResults,
      initialNotePart: notePart
        ? {
            status: notePart.status,
            doneTargets: [...(notePart.doneTargets || [])],
            receiptIds: [...(notePart.receiptIds || [])],
          }
        : null,
      finalNotePart: finalNotePart
        ? {
            status: finalNotePart.status,
            doneTargets: [...(finalNotePart.doneTargets || [])],
            receiptIds: [...(finalNotePart.receiptIds || [])],
          }
        : null,
      toolReceipts,
    };
  } finally {
    setOriginalAgentPermissionMode(previousMode);
  }
}
