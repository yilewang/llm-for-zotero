import { assert } from "chai";
import { readCodexQuota } from "../src/codexAppServer/quota";
import {
  CodexAppServerProcess,
  destroyCachedCodexAppServerProcess,
} from "../src/utils/codexAppServerProcess";
import { CODEX_APP_SERVER_NATIVE_PROCESS_KEY } from "../src/codexAppServer/runtimeCwd";

describe("Codex quota read", function () {
  it("skips reset-credit details and never kills the shared process on timeout", async function () {
    const originalSpawn = CodexAppServerProcess.spawn;
    const proc = CodexAppServerProcess.forTest({
      stdin: { write: () => {} },
      kill: () => {},
    });
    const calls: unknown[][] = [];
    (proc as any).sendRequest = async (...args: unknown[]) => {
      calls.push(args);
      return { rateLimits: { primary: { usedPercent: 10 } } };
    };
    CodexAppServerProcess.spawn = async () => proc;
    try {
      await readCodexQuota("codex");
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(
        CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
        proc,
        { codexPath: "codex" },
      );
    }
    assert.lengthOf(calls, 1);
    assert.equal(calls[0][0], "account/rateLimits/read");
    assert.deepEqual(calls[0][1], { excludeResetCreditDetails: true });
    assert.deepEqual(calls[0][3], { failProcessOnTimeout: false });
  });
});
