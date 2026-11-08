import { assert } from "chai";
import {
  acquireMineruServerJob,
  ensureMineruLocalServerRunning,
  getActiveJobCountForTests,
  getMineruServerStatus,
  hasIdleTimerForTests,
  isMineruServerProcessManaged,
  onMineruServerStatusChange,
  probeMineruServerHealthy,
  resetMineruServerManagerForTests,
  scheduleMineruServerIdleStop,
  setProbeHealthyForTests,
  setSubprocessLoaderForTests,
  startMineruServer,
  stopMineruServer,
  resolveMineruServerWorkdir,
  extractPortFromBaseUrl,
  listListenerPidsOnPort,
  syncMineruServerStatus,
  parseProcessParentMap,
  isDescendantPid,
} from "../src/utils/mineruServerManager";
import {
  setMineruLocalServerCommand,
  setMineruLocalServerIdleMinutes,
} from "../src/utils/mineruConfig";
import type { GeckoSubprocess } from "../src/utils/geckoSubprocess";

describe("mineruServerManager", function () {
  let prefStore: Map<string, unknown>;
  const originalZotero = (globalThis as any).Zotero;

  beforeEach(function () {
    resetMineruServerManagerForTests();
    prefStore = new Map();
    (globalThis as any).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key),
        set: (key: string, val: unknown) => prefStore.set(key, val),
      },
      isMac: true,
    };
  });

  afterEach(async function () {
    // Stop must not reuse a test stub whose fake process never settles.
    setSubprocessLoaderForTests(null);
    await stopMineruServer("test_cleanup");
    resetMineruServerManagerForTests();
    (globalThis as any).Zotero = originalZotero;
  });

  it("initializes with stopped status and no managed process", function () {
    assert.equal(getMineruServerStatus(), "stopped");
    assert.isFalse(isMineruServerProcessManaged());
    assert.equal(getActiveJobCountForTests(), 0);
    assert.isFalse(hasIdleTimerForTests());
  });

  it("notifies status listeners on state transitions", async function () {
    const states: string[] = [];
    const unsubscribe = onMineruServerStatusChange((s) => states.push(s));

    setMineruLocalServerCommand("mineru-api");
    setProbeHealthyForTests(async () => true);

    await ensureMineruLocalServerRunning("http://127.0.0.1:8000");
    assert.equal(getMineruServerStatus(), "running");

    await stopMineruServer("manual");
    assert.equal(getMineruServerStatus(), "stopped");

    assert.include(states, "running");
    assert.include(states, "stopped");
    unsubscribe();
  });

  describe("ensureMineruLocalServerRunning", function () {
    it("returns probe result when no start command is configured", async function () {
      setMineruLocalServerCommand("");
      setProbeHealthyForTests(async () => false);

      const result = await ensureMineruLocalServerRunning(
        "http://127.0.0.1:8000",
      );
      assert.isFalse(result);
      assert.equal(getMineruServerStatus(), "stopped");
    });

    it("does not start a process if server is already healthy", async function () {
      setMineruLocalServerCommand("mineru-api");
      let calledSubprocess = false;
      setSubprocessLoaderForTests(
        () =>
          ({
            call: async () => {
              calledSubprocess = true;
              return { pid: 1234 };
            },
          }) as GeckoSubprocess,
      );
      setProbeHealthyForTests(async () => true);

      const result = await ensureMineruLocalServerRunning(
        "http://127.0.0.1:8000",
      );
      assert.isTrue(result);
      assert.isFalse(calledSubprocess);
      assert.equal(getMineruServerStatus(), "running");
    });

    it("launches server process when not healthy and start command is configured", async function () {
      setMineruLocalServerCommand("mineru-api --port 8000");
      let launchedCommand = "";
      let launchedWorkdir = "";
      let probeCount = 0;

      setSubprocessLoaderForTests(
        () =>
          ({
            call: async (opts) => {
              launchedCommand = opts.arguments?.[1] || "";
              launchedWorkdir = opts.workdir || "";
              return {
                pid: 4321,
                stdout: { readString: async () => "" },
                stderr: { readString: async () => "" },
                wait: async () => new Promise(() => {}),
                kill: async () => ({ exitCode: 0 }),
              };
            },
          }) as GeckoSubprocess,
      );

      setProbeHealthyForTests(async () => {
        probeCount++;
        // First check returns false (unhealthy), subsequent checks return true (healthy)
        return probeCount > 1;
      });

      const result = await ensureMineruLocalServerRunning(
        "http://127.0.0.1:8000",
      );
      assert.isTrue(result);
      assert.equal(launchedCommand, "mineru-api --port 8000");
      assert.isTrue(launchedWorkdir.length > 0);
      assert.equal(launchedWorkdir, resolveMineruServerWorkdir());
      assert.equal(getMineruServerStatus(), "running");
      assert.isTrue(isMineruServerProcessManaged());
    });
  });

  describe("syncMineruServerStatus", function () {
    it("updates status to running when probe reports healthy", async function () {
      assert.equal(getMineruServerStatus(), "stopped");
      setProbeHealthyForTests(async () => true);

      const status = await syncMineruServerStatus("http://127.0.0.1:8000");
      assert.equal(status, "running");
      assert.equal(getMineruServerStatus(), "running");
    });

    it("leaves status stopped when probe reports unhealthy", async function () {
      assert.equal(getMineruServerStatus(), "stopped");
      setProbeHealthyForTests(async () => false);

      const status = await syncMineruServerStatus("http://127.0.0.1:8000");
      assert.equal(status, "stopped");
      assert.equal(getMineruServerStatus(), "stopped");
    });
  });

  describe("listListenerPidsOnPort", function () {
    it("parses Windows netstat output correctly without taking IP octets as PIDs", async function () {
      (globalThis as any).Zotero.isWin = true;
      (globalThis as any).Zotero.isMac = false;

      const mockNetstat = [
        "  Proto  Local Address          Foreign Address        State           PID",
        "  TCP    0.0.0.0:8000           0.0.0.0:0              LISTENING       4296",
        "  TCP    127.0.0.1:8000         0.0.0.0:0              LISTENING       4296",
        "  TCP    [::]:8000              [::]:0                 LISTENING       4296",
        "  TCP    127.0.0.1:18000        0.0.0.0:0              LISTENING       9999",
        "  TCP    127.0.0.1:8000         127.0.0.1:54321        ESTABLISHED     4296",
        "",
      ].join("\r\n");

      const chunks = [mockNetstat];
      const mockSubprocess = {
        call: async () => ({
          stdout: { readString: async () => chunks.shift() || "" },
          wait: async () => ({ exitCode: 0 }),
        }),
      } as unknown as GeckoSubprocess;

      const pids = await listListenerPidsOnPort(8000, mockSubprocess);
      assert.deepEqual(pids, [4296]);
      assert.notInclude(pids, 127);
      assert.notInclude(pids, 9999);
    });

    it("parses Unix lsof output and filters PID <= 1", async function () {
      (globalThis as any).Zotero.isWin = false;
      (globalThis as any).Zotero.isMac = true;

      const mockLsof = "1\n1234\n5678\n";

      const chunks = [mockLsof];
      const mockSubprocess = {
        call: async () => ({
          stdout: { readString: async () => chunks.shift() || "" },
          wait: async () => ({ exitCode: 0 }),
        }),
      } as unknown as GeckoSubprocess;

      const pids = await listListenerPidsOnPort(8000, mockSubprocess);
      assert.deepEqual(pids.sort(), [1234, 5678]);
      assert.notInclude(pids, 1);
    });
  });

  describe("extractPortFromBaseUrl", function () {
    it("extracts explicit ports and defaults by protocol", function () {
      assert.equal(extractPortFromBaseUrl("http://127.0.0.1:8000"), 8000);
      assert.equal(extractPortFromBaseUrl("http://localhost:9000/"), 9000);
      assert.equal(extractPortFromBaseUrl("http://127.0.0.1"), 80);
      assert.equal(extractPortFromBaseUrl("https://mineru.local/api"), 443);
      assert.equal(extractPortFromBaseUrl("not a url"), null);
    });
  });

  describe("process descendant tracking", function () {
    it("parses PPID and PID correctly from parent map output", function () {
      const output = [
        "  PPID    PID",
        "     0      1",
        "     1    100",
        "   100    200",
        "   200    300",
      ].join("\n");
      const map = parseProcessParentMap(output);
      assert.equal(map.get(100), 1);
      assert.equal(map.get(200), 100);
      assert.equal(map.get(300), 200);
    });

    it("identifies self, children, and grandchildren as descendants", function () {
      const map = new Map<number, number>([
        [100, 1],
        [200, 100],
        [300, 200],
        [999, 1],
      ]);
      assert.isTrue(isDescendantPid(100, 100, map), "self is descendant");
      assert.isTrue(isDescendantPid(200, 100, map), "child is descendant");
      assert.isTrue(isDescendantPid(300, 100, map), "grandchild is descendant");
      assert.isFalse(
        isDescendantPid(999, 100, map),
        "unrelated process is not descendant",
      );
    });
  });

  describe("stopMineruServer process cleanup safety", function () {
    it("skips port kill if the listener process is not a descendant of spawned process", async function () {
      setMineruLocalServerCommand("mineru-api --port 9000");
      const killedPids: number[] = [];

      setSubprocessLoaderForTests(
        () =>
          ({
            call: async (opts) => {
              const cmd = opts.arguments?.[1] || "";
              if (cmd.startsWith("taskkill") || cmd.startsWith("kill")) {
                const nums =
                  (opts.arguments?.[1] || "").match(/\d+/g)?.map(Number) || [];
                killedPids.push(...nums);
                return { wait: async () => ({ exitCode: 0 }) };
              }
              if (cmd.includes("lsof") || cmd.includes("netstat")) {
                const chunks = ["999\n"];
                return {
                  stdout: { readString: async () => chunks.shift() || "" },
                  wait: async () => ({ exitCode: 0 }),
                };
              }
              if (cmd.includes("ps -A") || cmd.includes("wmic")) {
                const chunks = ["1 1000\n1 999\n"];
                return {
                  stdout: { readString: async () => chunks.shift() || "" },
                  wait: async () => ({ exitCode: 0 }),
                };
              }
              return {
                pid: 1000,
                stdout: { readString: async () => "" },
                stderr: { readString: async () => "" },
                wait: async () => new Promise(() => {}),
                kill: async () => ({ exitCode: 0 }),
              };
            },
          }) as GeckoSubprocess,
      );

      let probeCount0 = 0;
      setProbeHealthyForTests(async () => {
        probeCount0++;
        return probeCount0 > 1;
      });
      await startMineruServer("http://127.0.0.1:8000");

      await stopMineruServer("manual");
      assert.notInclude(
        killedPids,
        999,
        "unrelated process on port 8000 must NOT be killed",
      );
      assert.equal(getMineruServerStatus(), "stopped");
    });

    it("kills the listener process if it IS a descendant of spawned process", async function () {
      setMineruLocalServerCommand("mineru-api --port 8000");
      let killedCommand = "";

      setSubprocessLoaderForTests(
        () =>
          ({
            call: async (opts) => {
              const cmd = opts.arguments?.[1] || "";
              if (cmd.startsWith("taskkill") || cmd.startsWith("kill")) {
                killedCommand = cmd;
                return { wait: async () => ({ exitCode: 0 }) };
              }
              if (cmd.includes("lsof") || cmd.includes("netstat")) {
                const chunks = ["1005\n"];
                return {
                  stdout: { readString: async () => chunks.shift() || "" },
                  wait: async () => ({ exitCode: 0 }),
                };
              }
              if (cmd.includes("ps -A") || cmd.includes("wmic")) {
                const chunks = ["1000 1005\n"];
                return {
                  stdout: { readString: async () => chunks.shift() || "" },
                  wait: async () => ({ exitCode: 0 }),
                };
              }
              return {
                pid: 1000,
                stdout: { readString: async () => "" },
                stderr: { readString: async () => "" },
                wait: async () => new Promise(() => {}),
                kill: async () => ({ exitCode: 0 }),
              };
            },
          }) as GeckoSubprocess,
      );

      let probeCount1 = 0;
      setProbeHealthyForTests(async () => {
        probeCount1++;
        return probeCount1 > 1;
      });
      await startMineruServer("http://127.0.0.1:8000");

      await stopMineruServer("manual");
      assert.include(
        killedCommand,
        "1005",
        "descendant process listening on port must be killed",
      );
      assert.equal(getMineruServerStatus(), "stopped");
    });

    it("stops managed process when reason is plugin_shutdown", async function () {
      setMineruLocalServerCommand("mineru-api");
      let killedShell = false;

      setSubprocessLoaderForTests(
        () =>
          ({
            call: async (opts) => {
              const cmd = opts.arguments?.[1] || "";
              if (cmd.includes("mineru")) {
                return {
                  pid: 1234,
                  stdout: { readString: async () => "" },
                  stderr: { readString: async () => "" },
                  wait: async () => new Promise(() => {}),
                  kill: async () => {
                    killedShell = true;
                    return { exitCode: 0 };
                  },
                };
              }
              return {
                stdout: { readString: async () => "" },
                wait: async () => ({ exitCode: 0 }),
              };
            },
          }) as GeckoSubprocess,
      );

      let probeCount2 = 0;
      setProbeHealthyForTests(async () => {
        probeCount2++;
        return probeCount2 > 1;
      });
      await startMineruServer("http://127.0.0.1:8000");
      assert.equal(getMineruServerStatus(), "running");

      await stopMineruServer("plugin_shutdown");
      assert.isTrue(killedShell);
      assert.equal(getMineruServerStatus(), "stopped");
    });
  });

  describe("health recheck and concurrent cancellations", function () {
    it("rechecks health when status is running and restarts if dead", async function () {
      setMineruLocalServerCommand("mineru-api");
      let launchCount = 0;

      setSubprocessLoaderForTests(
        () =>
          ({
            call: async (opts) => {
              const cmd = opts.arguments?.[1] || "";
              if (cmd.includes("mineru")) {
                launchCount++;
                return {
                  pid: 2000 + launchCount,
                  stdout: { readString: async () => "" },
                  stderr: { readString: async () => "" },
                  wait: async () => new Promise(() => {}),
                  kill: async () => ({ exitCode: 0 }),
                };
              }
              return {
                stdout: { readString: async () => "" },
                wait: async () => ({ exitCode: 0 }),
              };
            },
          }) as GeckoSubprocess,
      );

      let probe1 = 0;
      setProbeHealthyForTests(async () => {
        probe1++;
        return probe1 > 1;
      });

      // 1. Initial start
      const res1 = await startMineruServer("http://127.0.0.1:8000");
      assert.isTrue(res1);
      assert.equal(launchCount, 1);
      assert.equal(getMineruServerStatus(), "running");

      // 2. Server dies externally while status was left as running
      let probe2 = 0;
      setProbeHealthyForTests(async () => {
        probe2++;
        // Probe 1: recheck returns false
        // Probe 2: step 1 isAlreadyHealthy returns false
        // Probe 3: wait loop probe returns true
        return probe2 > 2;
      });

      const res2 = await startMineruServer("http://127.0.0.1:8000");
      assert.isTrue(res2);
      assert.equal(
        launchCount,
        2,
        "must have restarted the process instead of returning true blindly",
      );
    });

    it("kills the managed process before restarting an unhealthy running server", async function () {
      setMineruLocalServerCommand("mineru-api");
      const events: string[] = [];
      let launchCount = 0;

      setSubprocessLoaderForTests(
        () =>
          ({
            call: async (opts) => {
              const cmd = opts.arguments?.[1] || "";
              if (cmd.includes("mineru")) {
                const n = ++launchCount;
                events.push(`launch${n}`);
                return {
                  pid: 3000 + n,
                  stdout: { readString: async () => "" },
                  stderr: { readString: async () => "" },
                  wait: async () => new Promise(() => {}),
                  kill: async () => {
                    events.push(`kill${n}`);
                    return { exitCode: 0 };
                  },
                };
              }
              return {
                stdout: { readString: async () => "" },
                wait: async () => ({ exitCode: 0 }),
              };
            },
          }) as GeckoSubprocess,
      );

      let probe1 = 0;
      setProbeHealthyForTests(async () => ++probe1 > 1);
      assert.isTrue(await startMineruServer("http://127.0.0.1:8000"));

      // The server hangs: it is alive but fails the health probe.
      let probe2 = 0;
      setProbeHealthyForTests(async () => ++probe2 > 2);
      assert.isTrue(await startMineruServer("http://127.0.0.1:8000"));

      assert.equal(launchCount, 2);
      assert.isBelow(
        events.indexOf("kill1"),
        events.indexOf("launch2"),
        "hung process must be killed before the restart",
      );
      assert.include(events, "kill1");
    });

    it("stops an unmanaged running server without throwing when the health recheck fails", async function () {
      setMineruLocalServerCommand("mineru-api");
      setSubprocessLoaderForTests(
        () =>
          ({
            call: async () => ({
              pid: 3500,
              stdout: { readString: async () => "" },
              stderr: { readString: async () => "" },
              wait: async () => new Promise(() => {}),
              kill: async () => ({ exitCode: 0 }),
            }),
          }) as GeckoSubprocess,
      );

      // External server: step 1 finds it healthy, so nothing is spawned.
      setProbeHealthyForTests(async () => true);
      assert.isTrue(await startMineruServer("http://127.0.0.1:8000"));
      assert.isFalse(isMineruServerProcessManaged());

      let probe = 0;
      setProbeHealthyForTests(async () => ++probe > 2);
      assert.isTrue(await startMineruServer("http://127.0.0.1:8000"));
      assert.equal(getMineruServerStatus(), "running");
    });

    it("returns promptly for an aborted caller while another caller still waits", async function () {
      setMineruLocalServerCommand("mineru-api");
      setSubprocessLoaderForTests(
        () =>
          ({
            call: async () => ({
              pid: 1100,
              stdout: { readString: async () => "" },
              stderr: { readString: async () => "" },
              wait: async () => new Promise(() => {}),
              kill: async () => ({ exitCode: 0 }),
            }),
          }) as GeckoSubprocess,
      );

      let released = false;
      setProbeHealthyForTests(async () => released);

      const ctrl1 = new AbortController();
      const ctrl2 = new AbortController();
      let settled2 = false;
      const p1 = startMineruServer(
        "http://127.0.0.1:8000",
        undefined,
        ctrl1.signal,
      );
      const p2 = startMineruServer(
        "http://127.0.0.1:8000",
        undefined,
        ctrl2.signal,
      ).finally(() => {
        settled2 = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      ctrl1.abort();

      const res1 = await p1;
      assert.isFalse(res1, "aborted caller must return false");
      assert.isFalse(
        settled2,
        "aborted caller must not wait for the shared startup",
      );

      released = true;
      assert.isTrue(await p2);
      assert.equal(getMineruServerStatus(), "running");
    });

    it("stops the server when the only waiting caller aborts during startup", async function () {
      setMineruLocalServerCommand("mineru-api");
      let killCount = 0;
      setSubprocessLoaderForTests(
        () =>
          ({
            call: async (opts) => {
              const cmd = opts.arguments?.[1] || "";
              if (cmd.includes("mineru")) {
                return {
                  pid: 1200,
                  stdout: { readString: async () => "" },
                  stderr: { readString: async () => "" },
                  wait: async () => new Promise(() => {}),
                  kill: async () => {
                    killCount++;
                    return { exitCode: 0 };
                  },
                };
              }
              return {
                stdout: { readString: async () => "" },
                wait: async () => ({ exitCode: 0 }),
              };
            },
          }) as GeckoSubprocess,
      );
      setProbeHealthyForTests(async () => false);

      const ctrl = new AbortController();
      const p = startMineruServer(
        "http://127.0.0.1:8000",
        undefined,
        ctrl.signal,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const startedAt = Date.now();
      ctrl.abort();

      assert.isFalse(await p, "aborted caller must return false");
      assert.isBelow(Date.now() - startedAt, 1000, "must return promptly");

      const deadline = Date.now() + 5000;
      while (
        (killCount === 0 || getMineruServerStatus() !== "stopped") &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.isAtLeast(killCount, 1, "server must be stopped as cancelled");
      assert.equal(getMineruServerStatus(), "stopped");
    });

    it("concurrent parses: cancelling first caller does not cancel the other caller", async function () {
      setMineruLocalServerCommand("mineru-api");
      let probeCount = 0;

      setSubprocessLoaderForTests(
        () =>
          ({
            call: async () => ({
              pid: 1000,
              stdout: { readString: async () => "" },
              stderr: { readString: async () => "" },
              wait: async () => new Promise(() => {}),
              kill: async () => ({ exitCode: 0 }),
            }),
          }) as GeckoSubprocess,
      );

      setProbeHealthyForTests(async () => {
        probeCount++;
        return probeCount >= 3;
      });

      const ctrl1 = new AbortController();
      const ctrl2 = new AbortController();

      const p1 = startMineruServer(
        "http://127.0.0.1:8000",
        undefined,
        ctrl1.signal,
      );
      const p2 = startMineruServer(
        "http://127.0.0.1:8000",
        undefined,
        ctrl2.signal,
      );

      ctrl1.abort();

      const [res1, res2] = await Promise.all([p1, p2]);
      assert.isFalse(res1, "aborted caller must return false");
      assert.isTrue(res2, "non-aborted caller must succeed");
      assert.equal(getMineruServerStatus(), "running");
    });
  });

  describe("active job tracking and idle shutdown", function () {
    it("tracks active jobs and cancels/reschedules idle timer", function () {
      assert.equal(getActiveJobCountForTests(), 0);

      const release1 = acquireMineruServerJob();
      assert.equal(getActiveJobCountForTests(), 1);
      assert.isFalse(hasIdleTimerForTests());

      const release2 = acquireMineruServerJob();
      assert.equal(getActiveJobCountForTests(), 2);
      assert.isFalse(hasIdleTimerForTests());

      release1();
      assert.equal(getActiveJobCountForTests(), 1);
      assert.isFalse(hasIdleTimerForTests());

      release2();
      assert.equal(getActiveJobCountForTests(), 0);
    });

    it("does not trigger idle stop if active jobs are running", async function () {
      const release = acquireMineruServerJob();
      assert.equal(getActiveJobCountForTests(), 1);

      await stopMineruServer("idle_timeout");
      // Status should remain because jobs are active and reason was idle_timeout
      release();
      assert.equal(getActiveJobCountForTests(), 0);
    });

    it("stops server when stopMineruServer is called explicitly even if jobs were active", async function () {
      acquireMineruServerJob();
      await stopMineruServer("manual");
      assert.equal(getMineruServerStatus(), "stopped");
    });
  });
});
