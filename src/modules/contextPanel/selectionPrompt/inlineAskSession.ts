/**
 * The Inline Ask card's conversation, in memory only: the turns, the phase,
 * and the one request in flight. Nothing here is saved.
 *
 * Each send takes a new request token. A delta or result that carries an
 * older token (the turn was stopped, or the card was discarded) is dropped,
 * so a late chunk from an aborted stream never reaches the screen.
 */

export type InlineAskPhase = "compose" | "waiting" | "streaming" | "answered";

export type InlineAskUserTurn = {
  role: "user";
  /** The text sent to the model (a quick prompt's full prompt). */
  text: string;
  /** The text the card shows (a quick prompt's label). */
  shownText: string;
};

export type InlineAskAssistantTurn = {
  role: "assistant";
  text: string;
  status: "streaming" | "done" | "error";
};

export type InlineAskTurn = InlineAskUserTurn | InlineAskAssistantTurn;

export type InlineAskState = {
  phase: InlineAskPhase;
  turns: InlineAskTurn[];
};

export type InlineAskHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type InlineAskTurnResult = {
  text: string;
  /** Set when the turn produced no usable answer. */
  errorMessage?: string;
};

export type InlineAskTurnRunner = (input: {
  prompt: string;
  history: InlineAskHistoryMessage[];
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
}) => Promise<InlineAskTurnResult>;

type AbortHandle = { signal?: AbortSignal; abort(): void };

export type InlineAskSession = {
  getState(): InlineAskState;
  /** True once a question was sent. */
  hasConversation(): boolean;
  /** Sends `prompt`; returns false when the card cannot send now. */
  send(prompt: string, shownText?: string): boolean;
  /** Stops the running answer and keeps the text it streamed so far. */
  stop(): void;
  /** Stops and goes silent (the card closed). */
  dispose(): void;
};

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error ?? "").trim();
  return text || "The request failed.";
}

/** Finished question-and-answer pairs, oldest first. */
function buildHistory(turns: InlineAskTurn[]): InlineAskHistoryMessage[] {
  const history: InlineAskHistoryMessage[] = [];
  for (let index = 0; index < turns.length - 1; index++) {
    const question = turns[index];
    const answer = turns[index + 1];
    if (question.role !== "user" || answer.role !== "assistant") continue;
    if (answer.status !== "done" || !answer.text.trim()) continue;
    history.push(
      { role: "user", content: question.text },
      { role: "assistant", content: answer.text },
    );
  }
  return history;
}

/**
 * The finished turns as the model got them (a quick prompt's full prompt),
 * oldest first: what Continue in sidebar moves to the sidebar.
 */
export function finishedInlineAskTurns(
  turns: InlineAskTurn[],
): Array<{ role: "user" | "assistant"; text: string }> {
  return buildHistory(turns).map((message) => ({
    role: message.role,
    text: message.content,
  }));
}

export function createInlineAskSession(params: {
  runTurn: InlineAskTurnRunner;
  onChange: (state: InlineAskState) => void;
  /** Null when the host has no AbortController; requests then run unabortable. */
  createAbortController?: () => AbortHandle | null;
}): InlineAskSession {
  const state: InlineAskState = { phase: "compose", turns: [] };
  let token = 0;
  let controller: AbortHandle | null = null;
  let disposed = false;

  const emit = () => {
    if (!disposed) params.onChange(state);
  };

  const currentAnswer = (): InlineAskAssistantTurn | null => {
    const last = state.turns[state.turns.length - 1];
    return last?.role === "assistant" && last.status === "streaming"
      ? last
      : null;
  };

  const finish = (status: "done" | "error", text?: string) => {
    let answer = currentAnswer();
    if (status === "error" || text !== undefined) {
      if (!answer) {
        answer = { role: "assistant", text: "", status: "streaming" };
        state.turns.push(answer);
      }
      if (text !== undefined) answer.text = text;
    }
    if (answer) answer.status = status;
    state.phase = "answered";
    controller = null;
  };

  const send = (prompt: string, shownText?: string): boolean => {
    const text = prompt.trim();
    if (disposed || !text) return false;
    if (state.phase !== "compose" && state.phase !== "answered") return false;
    const history = buildHistory(state.turns);
    state.turns.push({
      role: "user",
      text,
      shownText: (shownText || "").trim() || text,
    });
    state.phase = "waiting";
    const myToken = ++token;
    controller = params.createAbortController?.() ?? null;
    const isCurrent = () => !disposed && myToken === token;
    emit();
    let streamed = "";
    const onDelta = (delta: string) => {
      if (!isCurrent() || !delta) return;
      streamed += delta;
      let answer = currentAnswer();
      if (!answer) {
        answer = { role: "assistant", text: "", status: "streaming" };
        state.turns.push(answer);
      }
      answer.text = streamed;
      state.phase = "streaming";
      emit();
    };
    let pending: Promise<InlineAskTurnResult>;
    try {
      pending = params.runTurn({
        prompt: text,
        history,
        signal: controller?.signal,
        onDelta,
      });
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending.then(
      (result) => {
        if (!isCurrent()) return;
        if (result.errorMessage && !result.text.trim()) {
          finish("error", result.errorMessage);
        } else {
          finish("done", result.text || streamed);
        }
        emit();
      },
      (error) => {
        if (!isCurrent()) return;
        finish("error", errorText(error));
        emit();
      },
    );
    return true;
  };

  const stop = () => {
    if (state.phase !== "waiting" && state.phase !== "streaming") return;
    token += 1;
    try {
      controller?.abort();
    } catch {
      // The request already ended.
    }
    finish("done");
    emit();
  };

  return {
    getState: () => state,
    hasConversation: () => state.turns.length > 0,
    send,
    stop,
    dispose: () => {
      if (disposed) return;
      // Silent first: a closed card is not redrawn.
      disposed = true;
      stop();
    },
  };
}
