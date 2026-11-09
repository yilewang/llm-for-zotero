import type { ChatMessage, ModelTurnOutcome, UsageStats } from "../shared/llm";
import { getUserSkillsRuntimeRootDir } from "../agent/skills/userSkills";
import { withConversationWriteLock } from "../shared/conversationWriteFence";
import {
  getAntigravityConversationSummary,
  upsertAntigravityConversationSummary,
} from "./store";
import {
  AGY_INLINE_PROMPT_LIMIT,
  AgyTextAccumulator,
  buildAgyFileContextPrompt,
  fingerprintSystemContext,
  splitAgyPrompt,
  toUsageStats,
} from "./agyStream";
import { ensureDir, removePathQuietly, writeFileBytes } from "../utils/geckoFs";
import { runAgyTurn, type AgyTurnOptions } from "./agyProcess";
import { toAntigravityModelPref } from "./modelCatalog";
import {
  getAntigravityBinaryPathPref,
  getAntigravityEffortPref,
  getAntigravityPermissionModePref,
  getAntigravityRuntimeModelPref,
} from "./prefs";

/**
 * The system context last sent into each agy conversation, by conversation
 * key. In memory only: after a restart the context is sent once more, which
 * costs tokens but never loses it.
 */
const sentSystemContextByConversation = new Map<number, string>();

export function forgetAntigravitySentContext(conversationKey: number): void {
  sentSystemContextByConversation.delete(conversationKey);
}

export function resolveAntigravityRuntimeCwd(): string | undefined {
  try {
    // The same root Codex uses: agy also discovers `.agents/skills` there.
    return getUserSkillsRuntimeRootDir();
  } catch {
    return undefined;
  }
}

export type AntigravityPanelTurn = {
  conversationKey: number;
  messages: ChatMessage[];
  model?: string;
  signal?: AbortSignal;
  /**
   * Start a new agy conversation instead of resuming the stored one. A retry
   * or an edit rewrites history agy already holds, so it starts over with
   * the transcript the panel shows.
   */
  freshConversation?: boolean;
};

/** One tool step of an agy turn, as the panel's activity trace shows it. */
export type AntigravityActivity = {
  stepIndex: number;
  toolName: string;
  summary?: string;
  phase: "started" | "completed";
  failed: boolean;
};

export type AntigravityPanelCallbacks = {
  isLive: () => boolean;
  onDelta: (delta: string) => void;
  onStatus: (text: string) => void;
  onUsage?: (usage: UsageStats) => void;
  onActivity?: (activity: AntigravityActivity) => void;
};

/** A step's state once it stopped running: done, or failed some way. */
function isFinishedStepState(state: string): boolean {
  return /^(DONE|COMPLETED?|SUCCESS|ERROR|FAILED|CANCELL?ED|DENIED)$/i.test(
    state,
  );
}

async function rememberConversationId(
  conversationKey: number,
  conversationId: string,
): Promise<void> {
  if (!conversationId) return;
  await withConversationWriteLock(conversationKey, async () => {
    const summary = await getAntigravityConversationSummary(conversationKey);
    if (!summary || summary.providerSessionId === conversationId) return;
    await upsertAntigravityConversationSummary({
      conversationKey: summary.conversationKey,
      instanceID: summary.instanceID,
      libraryID: summary.libraryID,
      kind: summary.kind,
      paperItemID: summary.paperItemID,
      createdAt: summary.createdAt,
      updatedAt: Date.now(),
      title: summary.title,
      providerSessionId: conversationId,
      scopedConversationKey: summary.scopedConversationKey,
      scopeType: summary.scopeType,
      scopeId: summary.scopeId,
      scopeLabel: summary.scopeLabel,
      cwd: summary.cwd,
      model: summary.model,
      effort: summary.effort,
    });
  });
}

function formatToolStatus(toolName: string, summary?: string): string {
  const label = toolName.replace(/_/g, " ").trim() || "a tool";
  return summary ? `Antigravity: ${summary}` : `Antigravity: using ${label}`;
}

/** A file holding a turn's context for agy to read, and its folder. */
export type AgyContextFile = { path: string; dir: string };

function joinLocalPath(...parts: string[]): string {
  const pathUtils = (
    globalThis as { PathUtils?: { join?: (...parts: string[]) => string } }
  ).PathUtils;
  return pathUtils?.join
    ? pathUtils.join(...parts)
    : parts.join("/").replace(/\/+/g, "/");
}

/**
 * Writes the context into its own folder under Zotero's temp directory, so
 * `--add-dir` opens that one file to agy and nothing else.
 */
async function writeAgyContextFile(
  text: string,
): Promise<AgyContextFile | null> {
  const temp = (
    globalThis as { Zotero?: { getTempDirectory?: () => { path?: string } } }
  ).Zotero?.getTempDirectory?.()?.path?.trim();
  if (!temp) return null;
  const dir = joinLocalPath(
    temp,
    `llm-for-zotero-agy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const path = joinLocalPath(dir, "context.md");
  try {
    if (!(await ensureDir(dir))) return null;
    if (!(await writeFileBytes(path, new TextEncoder().encode(text)))) {
      await removePathQuietly(dir);
      return null;
    }
  } catch {
    await removePathQuietly(dir);
    return null;
  }
  return { path, dir };
}

export type AntigravityTurnDeps = {
  runTurn: (options: AgyTurnOptions) => ReturnType<typeof runAgyTurn>;
  getStoredConversationId: (conversationKey: number) => Promise<string>;
  rememberConversationId: (
    conversationKey: number,
    conversationId: string,
  ) => Promise<void>;
  writeContextFile: (text: string) => Promise<AgyContextFile | null>;
  removeContextFile: (file: AgyContextFile) => Promise<void>;
  readSettings: () => {
    binaryPath: string;
    model: string;
    effort: ReturnType<typeof getAntigravityEffortPref>;
    permissionMode: ReturnType<typeof getAntigravityPermissionModePref>;
    cwd?: string;
  };
};

const DEFAULT_TURN_DEPS: AntigravityTurnDeps = {
  runTurn: runAgyTurn,
  getStoredConversationId: async (conversationKey) =>
    (
      await getAntigravityConversationSummary(conversationKey)
    )?.providerSessionId?.trim() || "",
  rememberConversationId,
  writeContextFile: writeAgyContextFile,
  removeContextFile: (file) => removePathQuietly(file.dir),
  readSettings: () => ({
    binaryPath: getAntigravityBinaryPathPref(),
    model: getAntigravityRuntimeModelPref(),
    effort: getAntigravityEffortPref(),
    permissionMode: getAntigravityPermissionModePref(),
    cwd: resolveAntigravityRuntimeCwd(),
  }),
};

/** One Antigravity turn from the panel, shared by the send and retry flows. */
export async function runAntigravityPanelTurn(
  turn: AntigravityPanelTurn,
  panel: AntigravityPanelCallbacks,
  overrides: Partial<AntigravityTurnDeps> = {},
): Promise<ModelTurnOutcome> {
  const deps = { ...DEFAULT_TURN_DEPS, ...overrides };
  const settings = deps.readSettings();
  const storedConversationId = turn.freshConversation
    ? ""
    : await deps.getStoredConversationId(turn.conversationKey);
  const resumed = Boolean(storedConversationId);
  const contextFingerprint = fingerprintSystemContext(turn.messages);
  const includeSystem =
    !resumed ||
    sentSystemContextByConversation.get(turn.conversationKey) !==
      contextFingerprint;
  const { context, question } = splitAgyPrompt({
    messages: turn.messages,
    resumed,
    includeSystem,
  });
  const inlinePrompt = context
    ? `${context}\n\n<question>\n${question}\n</question>`
    : question;
  // agy cuts a long inline message and keeps its head, so a long paper
  // goes in as a file agy reads in full. Should the file not be written,
  // the question leads, and a cut loses only the end of the context.
  let contextFile: AgyContextFile | null = null;
  let prompt = inlinePrompt;
  if (inlinePrompt.length > AGY_INLINE_PROMPT_LIMIT) {
    const fileText =
      question.length > AGY_INLINE_PROMPT_LIMIT / 2
        ? `${context}\n\n<question>\n${question}\n</question>`
        : context;
    contextFile = await deps.writeContextFile(fileText);
    prompt = contextFile
      ? buildAgyFileContextPrompt({
          question:
            fileText === context
              ? question
              : "The question is at the end of the file below.",
          contextPath: contextFile.path,
          contextChars: fileText.length,
        })
      : `<question>\n${question}\n</question>\n\n${context}`;
  }

  const { permissionMode, effort } = settings;
  const accumulator = new AgyTextAccumulator();
  panel.onStatus("Antigravity is thinking");
  const result = await deps
    .runTurn({
      binaryPath: settings.binaryPath,
      prompt,
      ...(contextFile ? { addDirs: [contextFile.dir] } : {}),
      model: toAntigravityModelPref(turn.model ?? settings.model) || undefined,
      effort: effort === "auto" ? undefined : effort,
      mode: permissionMode === "plan" ? "plan" : undefined,
      skipPermissions: permissionMode === "full",
      conversationId: storedConversationId || undefined,
      cwd: settings.cwd,
      signal: turn.signal,
      onEvent: (event) => {
        if (!panel.isLive()) return;
        if (event.kind === "text") {
          const delta = accumulator.push(
            event.stepIndex,
            event.delta,
            event.state,
          );
          if (delta) panel.onDelta(delta);
        } else if (event.kind === "tool") {
          const finished = isFinishedStepState(event.state);
          if (!finished) {
            panel.onStatus(formatToolStatus(event.toolName, event.summary));
          }
          panel.onActivity?.({
            stepIndex: event.stepIndex,
            toolName: event.toolName,
            summary: event.summary,
            phase: finished ? "completed" : "started",
            failed:
              finished && !/^(DONE|COMPLETED?|SUCCESS)$/i.test(event.state),
          });
        }
      },
    })
    .finally(() =>
      contextFile ? deps.removeContextFile(contextFile) : undefined,
    );

  sentSystemContextByConversation.set(turn.conversationKey, contextFingerprint);
  const conversationId = result.conversationId || storedConversationId;
  if (conversationId && conversationId !== storedConversationId) {
    await deps.rememberConversationId(turn.conversationKey, conversationId);
  }
  const usage = toUsageStats(result.usage);
  if (usage && panel.isLive()) panel.onUsage?.(usage);

  let text = result.response.trim() ? result.response : accumulator.text();
  if (result.deniedActions.length) {
    text +=
      "\n\n> Antigravity was not allowed to: " +
      result.deniedActions.join("; ") +
      ". Change the Antigravity permission mode in settings to allow it.";
  }
  return { text, completion: { status: "complete" } };
}
