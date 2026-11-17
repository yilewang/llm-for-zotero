/**
 * Runs the fake ACP agent as a stdio process, like `agy acp`.
 *
 *   tsx scripts/fake-acp-agent.ts --store <sessions.json> [--auth-pending <n>]
 *     [--skip-permissions] [--scenarios conformance]
 *
 * `--store` persists sessions so a second process can `session/load` them.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  FakeAcpAgent,
  type FakeAcpSessionStore,
  type FakeAcpStoredSession,
} from "../test/helpers/acp/fakeAcpAgent";
import { CONFORMANCE_FAKE_SCENARIOS } from "../test/helpers/acp/conformance";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function createFileStore(path: string): FakeAcpSessionStore {
  const read = (): Record<string, FakeAcpStoredSession> =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return {
    get: (id) => read()[id],
    put: (session) => {
      const all = read();
      all[session.sessionId] = session;
      writeFileSync(path, JSON.stringify(all));
    },
    list: () => Object.values(read()),
  };
}

const storePath = argValue("--store");
const agent = new FakeAcpAgent({
  store: storePath ? createFileStore(storePath) : undefined,
  authPendingRequests: Number(argValue("--auth-pending") ?? 0),
  skipPermissions: process.argv.includes("--skip-permissions"),
  scenarios:
    argValue("--scenarios") === "conformance" ? CONFORMANCE_FAKE_SCENARIOS : [],
});
agent.onOutput((chunk) => process.stdout.write(chunk));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => agent.write(chunk));
process.stdin.on("end", () => {
  agent.close();
  process.exit(0);
});
