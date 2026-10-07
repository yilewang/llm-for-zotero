import { assert } from "chai";
import {
  ensureDir,
  ensureDirFromParent,
  getIOUtils,
  getOSFile,
  pathExists,
  readFileBytes,
  removePathQuietly,
  writeFileBytes,
} from "../src/utils/geckoFs";

type GlobalWithGecko = typeof globalThis & {
  IOUtils?: unknown;
  OS?: unknown;
};

const globals = globalThis as GlobalWithGecko;

type Call = { method: string; args: unknown[] };

function recorder(calls: Call[], method: string, result?: unknown) {
  return async (...args: unknown[]) => {
    calls.push({ method, args });
    return result;
  };
}

function failing(calls: Call[], method: string, error = new Error(method)) {
  return async (...args: unknown[]) => {
    calls.push({ method, args });
    throw error;
  };
}

describe("geckoFs", function () {
  let savedIOUtils: unknown;
  let savedOS: unknown;
  let hadIOUtils: boolean;
  let hadOS: boolean;

  beforeEach(function () {
    hadIOUtils = "IOUtils" in globals;
    hadOS = "OS" in globals;
    savedIOUtils = globals.IOUtils;
    savedOS = globals.OS;
    delete globals.IOUtils;
    delete globals.OS;
  });

  afterEach(function () {
    if (hadIOUtils) globals.IOUtils = savedIOUtils;
    else delete globals.IOUtils;
    if (hadOS) globals.OS = savedOS;
    else delete globals.OS;
  });

  describe("getters", function () {
    it("re-read the globals on every call", function () {
      assert.isUndefined(getIOUtils());
      assert.isUndefined(getOSFile());
      const first = { exists: async () => true };
      const second = { exists: async () => false };
      const firstFile = { exists: async () => true };
      const secondFile = { exists: async () => false };
      globals.IOUtils = first;
      globals.OS = { File: firstFile };
      assert.strictEqual(getIOUtils(), first);
      assert.strictEqual(getOSFile(), firstFile);
      globals.IOUtils = second;
      globals.OS = { File: secondFile };
      assert.strictEqual(getIOUtils(), second);
      assert.strictEqual(getOSFile(), secondFile);
      globals.OS = {};
      assert.isUndefined(getOSFile());
    });

    it("let a helper see a stub swapped in after an earlier call", async function () {
      globals.IOUtils = { exists: async () => true };
      assert.isTrue(await pathExists("/a"));
      globals.IOUtils = { exists: async () => false };
      assert.isFalse(await pathExists("/a"));
    });
  });

  describe("pathExists", function () {
    it("uses IOUtils first and coerces the result to a boolean", async function () {
      const calls: Call[] = [];
      globals.IOUtils = { exists: recorder(calls, "io.exists", 1) };
      globals.OS = { File: { exists: recorder(calls, "os.exists", false) } };
      assert.isTrue(await pathExists("/a"));
      assert.deepEqual(calls, [{ method: "io.exists", args: ["/a"] }]);
    });

    it("returns false when IOUtils throws, without trying OS.File", async function () {
      const calls: Call[] = [];
      globals.IOUtils = { exists: failing(calls, "io.exists") };
      globals.OS = { File: { exists: recorder(calls, "os.exists", true) } };
      assert.isFalse(await pathExists("/a"));
      assert.deepEqual(
        calls.map((call) => call.method),
        ["io.exists"],
      );
    });

    it("falls back to OS.File and swallows its errors", async function () {
      const calls: Call[] = [];
      globals.IOUtils = { read: async () => new Uint8Array() };
      globals.OS = { File: { exists: recorder(calls, "os.exists", "yes") } };
      assert.isTrue(await pathExists("/a"));
      assert.deepEqual(calls, [{ method: "os.exists", args: ["/a"] }]);
      globals.OS = { File: { exists: failing(calls, "os.exists") } };
      assert.isFalse(await pathExists("/a"));
    });

    it("returns false when no API exists", async function () {
      assert.isFalse(await pathExists("/a"));
    });
  });

  describe("readFileBytes", function () {
    it("returns a Uint8Array from IOUtils unchanged", async function () {
      const bytes = new Uint8Array([1, 2, 3]);
      globals.IOUtils = { read: async () => bytes };
      assert.strictEqual(await readFileBytes("/a"), bytes);
    });

    it("copies an ArrayBuffer into a Uint8Array", async function () {
      const buffer = new Uint8Array([4, 5]).buffer;
      globals.IOUtils = { read: async () => buffer };
      const result = await readFileBytes("/a");
      assert.instanceOf(result, Uint8Array);
      assert.deepEqual(Array.from(result || []), [4, 5]);
    });

    it("returns null when IOUtils throws, without trying OS.File", async function () {
      const calls: Call[] = [];
      globals.IOUtils = { read: failing(calls, "io.read") };
      globals.OS = {
        File: { read: recorder(calls, "os.read", new Uint8Array([9])) },
      };
      assert.isNull(await readFileBytes("/a"));
      assert.deepEqual(
        calls.map((call) => call.method),
        ["io.read"],
      );
    });

    it("falls back to OS.File, coerces, and returns null on its errors", async function () {
      const calls: Call[] = [];
      globals.IOUtils = { exists: async () => true };
      globals.OS = {
        File: {
          read: recorder(calls, "os.read", new Uint8Array([7, 8]).buffer),
        },
      };
      const result = await readFileBytes("/a");
      assert.instanceOf(result, Uint8Array);
      assert.deepEqual(Array.from(result || []), [7, 8]);
      assert.deepEqual(calls, [{ method: "os.read", args: ["/a"] }]);
      globals.OS = { File: { read: failing(calls, "os.read") } };
      assert.isNull(await readFileBytes("/a"));
    });

    it("returns null when no API exists", async function () {
      assert.isNull(await readFileBytes("/a"));
    });
  });

  describe("writeFileBytes", function () {
    it("writes with IOUtils and returns true", async function () {
      const calls: Call[] = [];
      const bytes = new Uint8Array([1]);
      globals.IOUtils = { write: recorder(calls, "io.write", 1) };
      globals.OS = { File: { writeAtomic: recorder(calls, "os.write") } };
      assert.isTrue(await writeFileBytes("/a", bytes));
      assert.deepEqual(calls, [{ method: "io.write", args: ["/a", bytes] }]);
    });

    it("falls back to OS.File writeAtomic and returns true", async function () {
      const calls: Call[] = [];
      const bytes = new Uint8Array([2]);
      globals.IOUtils = { exists: async () => true };
      globals.OS = { File: { writeAtomic: recorder(calls, "os.write") } };
      assert.isTrue(await writeFileBytes("/a", bytes));
      assert.deepEqual(calls, [{ method: "os.write", args: ["/a", bytes] }]);
    });

    it("propagates write errors from either API", async function () {
      const calls: Call[] = [];
      globals.IOUtils = { write: failing(calls, "io.write") };
      globals.OS = { File: { writeAtomic: recorder(calls, "os.write") } };
      await assertRejects(writeFileBytes("/a", new Uint8Array()), "io.write");
      assert.deepEqual(
        calls.map((call) => call.method),
        ["io.write"],
      );
      delete globals.IOUtils;
      globals.OS = { File: { writeAtomic: failing(calls, "os.write") } };
      await assertRejects(writeFileBytes("/a", new Uint8Array()), "os.write");
    });

    it("returns false when no API exists", async function () {
      assert.isFalse(await writeFileBytes("/a", new Uint8Array()));
    });
  });

  describe("ensureDir", function () {
    it("creates ancestors with IOUtils and returns true", async function () {
      const calls: Call[] = [];
      globals.IOUtils = { makeDirectory: recorder(calls, "io.mkdir") };
      globals.OS = { File: { makeDir: recorder(calls, "os.mkdir") } };
      assert.isTrue(await ensureDir("/a/b"));
      assert.deepEqual(calls, [
        {
          method: "io.mkdir",
          args: ["/a/b", { createAncestors: true, ignoreExisting: true }],
        },
      ]);
    });

    it("falls back to OS.File makeDir without a from option", async function () {
      const calls: Call[] = [];
      globals.OS = { File: { makeDir: recorder(calls, "os.mkdir") } };
      assert.isTrue(await ensureDir("/a/b"));
      assert.deepEqual(calls, [
        { method: "os.mkdir", args: ["/a/b", { ignoreExisting: true }] },
      ]);
    });

    it("propagates directory errors", async function () {
      globals.IOUtils = { makeDirectory: failing([], "io.mkdir") };
      await assertRejects(ensureDir("/a"), "io.mkdir");
      delete globals.IOUtils;
      globals.OS = { File: { makeDir: failing([], "os.mkdir") } };
      await assertRejects(ensureDir("/a"), "os.mkdir");
    });

    it("returns false when no API exists", async function () {
      assert.isFalse(await ensureDir("/a"));
    });
  });

  describe("ensureDirFromParent", function () {
    it("creates ancestors with IOUtils and returns true", async function () {
      const calls: Call[] = [];
      globals.IOUtils = { makeDirectory: recorder(calls, "io.mkdir") };
      assert.isTrue(await ensureDirFromParent("/a/b"));
      assert.deepEqual(calls, [
        {
          method: "io.mkdir",
          args: ["/a/b", { createAncestors: true, ignoreExisting: true }],
        },
      ]);
    });

    it("falls back to OS.File makeDir from the parent directory", async function () {
      const calls: Call[] = [];
      globals.OS = { File: { makeDir: recorder(calls, "os.mkdir") } };
      assert.isTrue(await ensureDirFromParent("/a/b/c"));
      assert.deepEqual(calls, [
        {
          method: "os.mkdir",
          args: ["/a/b/c", { from: "/a/b", ignoreExisting: true }],
        },
      ]);
    });

    it("propagates directory errors", async function () {
      globals.IOUtils = { makeDirectory: failing([], "io.mkdir") };
      await assertRejects(ensureDirFromParent("/a"), "io.mkdir");
      delete globals.IOUtils;
      globals.OS = { File: { makeDir: failing([], "os.mkdir") } };
      await assertRejects(ensureDirFromParent("/a"), "os.mkdir");
    });

    it("returns false when no API exists", async function () {
      assert.isFalse(await ensureDirFromParent("/a"));
    });
  });

  describe("removePathQuietly", function () {
    it("removes recursively with IOUtils and ignores its errors", async function () {
      const calls: Call[] = [];
      globals.IOUtils = { remove: recorder(calls, "io.remove") };
      globals.OS = { File: { removeDir: recorder(calls, "os.removeDir") } };
      await removePathQuietly("/a");
      assert.deepEqual(calls, [
        {
          method: "io.remove",
          args: ["/a", { recursive: true, ignoreAbsent: true }],
        },
      ]);
      globals.IOUtils = { remove: failing(calls, "io.remove") };
      await removePathQuietly("/a");
      assert.deepEqual(
        calls.map((call) => call.method),
        ["io.remove", "io.remove"],
      );
    });

    it("falls back to OS.File removeDir and ignores its errors", async function () {
      const calls: Call[] = [];
      globals.OS = {
        File: {
          removeDir: recorder(calls, "os.removeDir"),
          remove: recorder(calls, "os.remove"),
        },
      };
      await removePathQuietly("/a");
      assert.deepEqual(calls, [
        {
          method: "os.removeDir",
          args: ["/a", { ignoreAbsent: true, ignorePermissions: false }],
        },
      ]);
      globals.OS = {
        File: {
          removeDir: failing(calls, "os.removeDir"),
          remove: recorder(calls, "os.remove"),
        },
      };
      await removePathQuietly("/a");
      assert.deepEqual(
        calls.map((call) => call.method),
        ["os.removeDir", "os.removeDir"],
      );
    });

    it("uses OS.File remove when removeDir is missing and ignores its errors", async function () {
      const calls: Call[] = [];
      globals.OS = { File: { remove: recorder(calls, "os.remove") } };
      await removePathQuietly("/a");
      assert.deepEqual(calls, [
        { method: "os.remove", args: ["/a", { ignoreAbsent: true }] },
      ]);
      globals.OS = { File: { remove: failing(calls, "os.remove") } };
      await removePathQuietly("/a");
    });

    it("does nothing when no API exists", async function () {
      await removePathQuietly("/a");
    });
  });
});

async function assertRejects(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.equal((error as Error).message, message);
    return;
  }
  assert.fail(`Expected a rejection with "${message}"`);
}
