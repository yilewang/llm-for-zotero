/**
 * Puts a FakeAcpAgent behind the child-process surface the plugin's stdio
 * JSON-RPC layer reads, so the real ACP client can talk to the fake agent
 * inside Zotero with no subprocess.
 */

import { FakeAcpAgent, type FakeAcpAgentOptions } from "./fakeAcpAgent";

export type FakeAcpChild = {
  agent: FakeAcpAgent;
  stdin: { write(data: string): Promise<number> };
  stdout: { readString(): Promise<string> };
  stderr: { readString(): Promise<string> };
  kill(): Promise<{ exitCode: number }>;
  wait(): Promise<{ exitCode: number }>;
  killed(): boolean;
};

export function createFakeAcpChild(
  options: FakeAcpAgentOptions = {},
): FakeAcpChild {
  const agent = new FakeAcpAgent(options);
  const chunks: string[] = [];
  let waiting: ((chunk: string) => void) | null = null;
  let ended = false;
  let killed = false;
  let resolveExit!: (value: { exitCode: number }) => void;
  const exited = new Promise<{ exitCode: number }>((resolve) => {
    resolveExit = resolve;
  });
  const end = (code: number) => {
    if (ended) return;
    ended = true;
    agent.close();
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve("");
    }
    resolveExit({ exitCode: code });
  };
  agent.onOutput((chunk) => {
    if (ended) return;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(chunk);
    } else {
      chunks.push(chunk);
    }
  });
  let stderrWaiting: ((chunk: string) => void) | null = null;
  void exited.then(() => stderrWaiting?.(""));
  return {
    agent,
    stdin: {
      async write(data: string) {
        if (ended) throw new Error("stdin is closed");
        agent.write(data);
        return data.length;
      },
    },
    stdout: {
      readString() {
        if (chunks.length) return Promise.resolve(chunks.shift() as string);
        if (ended) return Promise.resolve("");
        return new Promise((resolve) => {
          waiting = resolve;
        });
      },
    },
    stderr: {
      readString() {
        if (ended) return Promise.resolve("");
        return new Promise((resolve) => {
          stderrWaiting = resolve;
        });
      },
    },
    async kill() {
      killed = true;
      end(137);
      return exited;
    },
    wait: () => exited,
    killed: () => killed,
  };
}
