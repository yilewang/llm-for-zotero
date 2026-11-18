/**
 * An in-memory stand-in for a Firefox Subprocess child, with the shape the
 * plugin's stdio JSON-RPC layer reads: `stdin.write`, `stdout.readString`,
 * `stderr.readString`, `kill`, and `wait`.
 *
 * A test plays the other end of the pipe: it pushes stdout and stderr chunks
 * (in any split it likes), reads what the plugin wrote to stdin, and ends the
 * streams to mimic the program exiting.
 */

type PipeReader = {
  readString(): Promise<string>;
  push(chunk: string): void;
  end(): void;
};

function createPipeReader(): PipeReader {
  const chunks: string[] = [];
  let ended = false;
  let waiting: ((chunk: string) => void) | null = null;
  return {
    readString() {
      if (chunks.length) return Promise.resolve(chunks.shift() as string);
      if (ended) return Promise.resolve("");
      return new Promise<string>((resolve) => {
        waiting = resolve;
      });
    },
    push(chunk: string) {
      if (ended) return;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(chunk);
        return;
      }
      chunks.push(chunk);
    },
    end() {
      if (ended) return;
      ended = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve("");
      }
    },
  };
}

export type FakeStdioProcess = {
  stdin: { write(data: string): Promise<number> };
  stdout: { readString(): Promise<string> };
  stderr: { readString(): Promise<string> };
  kill(): Promise<{ exitCode: number }>;
  wait(): Promise<{ exitCode: number }>;

  /** Everything the plugin wrote to stdin, as raw text. */
  readonly stdinText: () => string;
  /** The JSON messages the plugin wrote to stdin, in order. */
  readonly sent: () => Array<Record<string, unknown>>;
  /** Resolves when the plugin has written at least `count` messages. */
  waitForSent(count: number, timeoutMs?: number): Promise<void>;
  /** Raw bytes on the child's stdout. */
  pushStdout(chunk: string): void;
  /** One message on stdout, newline-terminated. */
  emit(message: Record<string, unknown>): void;
  pushStderr(chunk: string): void;
  /** The child exits on its own: both output streams end. */
  exit(exitCode?: number): void;
  readonly killed: () => boolean;
  /** Called with each line the plugin writes, for scripted replies. */
  onSent(listener: (message: Record<string, unknown>) => void): void;
};

export function createFakeStdioProcess(): FakeStdioProcess {
  const stdout = createPipeReader();
  const stderr = createPipeReader();
  let stdinText = "";
  let killed = false;
  let exitCode: number | null = null;
  let resolveExit!: (value: { exitCode: number }) => void;
  const exited = new Promise<{ exitCode: number }>((resolve) => {
    resolveExit = resolve;
  });
  const sentListeners: Array<(message: Record<string, unknown>) => void> = [];
  const sentWaiters: Array<{ count: number; resolve: () => void }> = [];

  const parseSent = (): Array<Record<string, unknown>> =>
    stdinText
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  const finish = (code: number) => {
    if (exitCode !== null) return;
    exitCode = code;
    stdout.end();
    stderr.end();
    resolveExit({ exitCode: code });
  };

  return {
    stdin: {
      async write(data: string) {
        if (exitCode !== null) throw new Error("stdin is closed");
        stdinText += data;
        const lines = data.split("\n").filter((line) => line.trim());
        for (const line of lines) {
          const message = JSON.parse(line) as Record<string, unknown>;
          for (const listener of [...sentListeners]) listener(message);
        }
        const total = parseSent().length;
        for (const waiter of [...sentWaiters]) {
          if (total >= waiter.count) {
            sentWaiters.splice(sentWaiters.indexOf(waiter), 1);
            waiter.resolve();
          }
        }
        return data.length;
      },
    },
    stdout,
    stderr,
    async kill() {
      killed = true;
      finish(137);
      return exited;
    },
    wait() {
      return exited;
    },
    stdinText: () => stdinText,
    sent: parseSent,
    waitForSent(count: number, timeoutMs = 5_000) {
      if (parseSent().length >= count) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `Expected ${count} messages on stdin, saw ${parseSent().length}`,
              ),
            ),
          timeoutMs,
        );
        sentWaiters.push({
          count,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
    pushStdout: (chunk: string) => stdout.push(chunk),
    emit: (message: Record<string, unknown>) =>
      stdout.push(`${JSON.stringify(message)}\n`),
    pushStderr: (chunk: string) => stderr.push(chunk),
    exit: (code = 0) => finish(code),
    killed: () => killed,
    onSent: (listener) => {
      sentListeners.push(listener);
    },
  };
}

/** Lets pending microtasks and zero-delay timers run. */
export function settle(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
