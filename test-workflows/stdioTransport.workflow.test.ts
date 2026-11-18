import { assert } from "chai";
import {
  JsonRpcResponseError,
  StdioJsonRpcConnection,
  type StdioJsonRpcIncoming,
} from "../src/utils/stdioJsonRpcConnection";
import {
  KeyedProcessPool,
  type PooledProcess,
} from "../src/utils/keyedProcessPool";
import {
  createFakeStdioProcess,
  settle,
} from "../test/helpers/fakeStdioProcess";

/**
 * The shared stdio JSON-RPC layer and process pool, in the configuration
 * Antigravity uses (JSON-RPC 2.0 framing, error codes kept). Codex's use of
 * the same layer is pinned by codexAppServerTransport.workflow.test.ts.
 */
describe("workflow: shared stdio JSON-RPC transport", function () {
  this.timeout(30000);

  it("frames JSON-RPC 2.0, keeps error codes, and hands requests and notifications to the owner", async function () {
    const child = createFakeStdioProcess();
    const incoming: StdioJsonRpcIncoming[] = [];
    const connection = new StdioJsonRpcConnection(child, {
      label: "agy acp",
      destroyedMessage: "agy acp connection closed",
      includeJsonRpcVersion: true,
      onIncoming: (message) => incoming.push(message),
    });
    connection.start();

    const request = connection.sendRequest("session/new", { cwd: "/w" });
    await child.waitForSent(1);
    assert.deepEqual(child.sent()[0], {
      jsonrpc: "2.0",
      method: "session/new",
      id: 1,
      params: { cwd: "/w" },
    });
    child.emit({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "Authentication required" },
    });
    let failure: unknown;
    await request.catch((error) => (failure = error));
    assert.instanceOf(failure, JsonRpcResponseError);
    assert.equal((failure as JsonRpcResponseError).code, -32000);
    assert.equal(
      (failure as JsonRpcResponseError).message,
      "Authentication required",
    );

    child.emit({
      jsonrpc: "2.0",
      id: 0,
      method: "session/request_permission",
      params: { sessionId: "s" },
    });
    child.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s" },
    });
    await settle(5);
    assert.deepEqual(incoming, [
      {
        kind: "request",
        id: 0,
        method: "session/request_permission",
        params: { sessionId: "s" },
      },
      {
        kind: "notification",
        method: "session/update",
        params: { sessionId: "s" },
      },
    ]);
    connection.respond(0, { outcome: { outcome: "cancelled" } });
    await child.waitForSent(2);
    assert.deepEqual(child.sent()[1], {
      jsonrpc: "2.0",
      id: 0,
      result: { outcome: { outcome: "cancelled" } },
    });
    await connection.destroyAndWait();
  });

  it("redacts private text in errors and runs onClosing once before close listeners", async function () {
    const child = createFakeStdioProcess();
    const order: string[] = [];
    const connection = new StdioJsonRpcConnection(child, {
      label: "agy acp",
      destroyedMessage: "closed",
      redactText: (text) => text.replace(/\/Users\/[^\s]+/g, "<path>"),
      onIncoming: () => undefined,
      onClosing: () => order.push("closing"),
    });
    connection.onClose((reason) => order.push(`close:${reason}`));
    connection.start();
    const request = connection.sendRequest("x", {});
    child.pushStderr("cannot open /Users/me/secret.pdf\n");
    await settle(5);
    child.exit(2);
    let failure: unknown;
    await request.catch((error) => (failure = error));
    assert.equal(
      (failure as Error).message,
      "agy acp process closed unexpectedly: cannot open <path>",
    );
    connection.destroy();
    assert.deepEqual(order, [
      "closing",
      "close:agy acp process closed unexpectedly: cannot open <path>",
    ]);
  });

  describe("keyed process pool", function () {
    type Fake = PooledProcess & {
      id: number;
      destroyed: boolean;
      close(): void;
    };
    let nextId = 1;
    function fakeProcess(): Fake {
      const listeners: Array<(reason?: string) => void> = [];
      const proc: Fake = {
        id: nextId++,
        destroyed: false,
        onClose(listener) {
          listeners.push(listener);
          return () => undefined;
        },
        destroy() {
          proc.destroyed = true;
          proc.close();
        },
        async destroyAndWait() {
          proc.destroy();
          return true;
        },
        close() {
          for (const listener of listeners.splice(0)) listener("closed");
        },
      };
      return proc;
    }

    it("reuses a process per key and spawns again after it closes or fails to spawn", async function () {
      const pool = new KeyedProcessPool<Fake>("test pool");
      let spawns = 0;
      const spawn = async () => {
        spawns += 1;
        return fakeProcess();
      };
      const a = await pool.get("cwd=/a", spawn);
      assert.strictEqual(await pool.get("cwd=/a", spawn), a);
      const b = await pool.get("cwd=/b", spawn);
      assert.notStrictEqual(a, b);
      assert.equal(spawns, 2);

      a.close();
      const a2 = await pool.get("cwd=/a", spawn);
      assert.notStrictEqual(a2, a);

      let failure: unknown;
      await pool
        .get("cwd=/c", async () => {
          throw new Error("agy not found");
        })
        .catch((error) => (failure = error));
      assert.match(String(failure), /agy not found/);
      await settle();
      assert.notInclude(pool.keys(), "cwd=/c");
      await pool.destroyAll();
      assert.isTrue(a2.destroyed && b.destroyed);
      assert.deepEqual(pool.keys(), []);
    });

    it("destroys only the named process, and detaches without destroying", async function () {
      const pool = new KeyedProcessPool<Fake>("test pool");
      const first = await pool.get("k", async () => fakeProcess());
      pool.detach("k", first);
      await settle();
      assert.isFalse(first.destroyed);
      const second = await pool.get("k", async () => fakeProcess());
      assert.notStrictEqual(second, first);

      pool.destroy("k", first);
      await settle();
      assert.isFalse(second.destroyed, "a stale handle leaves the new one");
      assert.isTrue(first.destroyed);
      pool.destroy("k");
      await settle();
      assert.isTrue(second.destroyed);
      await pool.destroyAll();
    });
  });
});
