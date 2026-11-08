import { describe, it, expect, beforeEach } from "vitest";
import { PermissionStore } from "../src/permissions/permission-store.js";

describe("PermissionStore", () => {
  let store: PermissionStore;

  beforeEach(() => {
    store = new PermissionStore();
  });

  it("should create a pending permission and resolve with allow", async () => {
    const { requestId, promise } = store.create(
      "tool-use-123",
      "Bash",
      { command: "ls -la" },
      {
        title: "Allow Bash command?",
        description: "Claude wants to run a bash command",
        displayName: "Run command",
        blockedPath: undefined,
        decisionReason: "Bash tool requires confirmation",
      },
    );

    expect(requestId).toMatch(/^perm-\d+-[a-z0-9]+$/);
    expect(store.hasPending(requestId)).toBe(true);

    // Simulate frontend resolving
    const resolved = store.resolve(requestId, { approved: true });
    expect(resolved).toBe(true);

    const result = await promise;
    expect(result.behavior).toBe("allow");
    expect(result.toolUseID).toBe("tool-use-123");
  });

  it("should create a pending permission and resolve with deny", async () => {
    const { requestId, promise } = store.create(
      "tool-use-456",
      "Write",
      { path: "/etc/passwd", content: "evil" },
      {
        title: "Allow file write?",
        description: "Claude wants to write to a file",
      },
    );

    store.resolve(requestId, { approved: false, data: "User denied" });

    const result = await promise;
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toBe("User denied");
    }
  });

  it("should return false when resolving unknown requestId", () => {
    const resolved = store.resolve("unknown-request", { approved: true });
    expect(resolved).toBe(false);
  });

  it("should get pending event data", () => {
    const { requestId } = store.create(
      "tool-use-789",
      "Read",
      { path: "/tmp/test.txt" },
      {
        title: "Read file?",
        description: "Claude wants to read a file",
        displayName: "Read file",
        blockedPath: "/tmp/test.txt",
        decisionReason: "Outside allowed directories",
      },
    );

    const event = store.getPendingForEvent(requestId);
    expect(event).toEqual({
      requestId,
      toolName: "Read",
      title: "Read file?",
      description: "Claude wants to read a file",
      displayName: "Read file",
      blockedPath: "/tmp/test.txt",
      decisionReason: "Outside allowed directories",
      input: { path: "/tmp/test.txt" },
    });
  });

  it("should auto-deny after default timeout period", async () => {
    const shortTimeoutStore = new PermissionStore();
    (
      shortTimeoutStore as unknown as { defaultTimeoutMs: number }
    ).defaultTimeoutMs = 50;

    const { promise } = shortTimeoutStore.create(
      "tool-use-timeout",
      "Bash",
      { command: "sleep 100" },
      {},
    );

    const result = await promise;
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toContain("timed out");
      expect(result.interrupt).toBe(false);
      expect(result.toolUseID).toBe("tool-use-timeout");
    }
  });

  it("should cleanup all pending permissions", async () => {
    const { promise: promise1 } = store.create("t1", "Bash", {}, {});
    const { promise: promise2 } = store.create("t2", "Read", {}, {});

    store.cleanup();

    await expect(promise1).rejects.toThrow("cleanup");
    await expect(promise2).rejects.toThrow("cleanup");
  });
});

describe("globalPermissionStore", () => {
  it("should be a singleton", async () => {
    const { globalPermissionStore } =
      await import("../src/permissions/permission-store.js");
    const { globalPermissionStore: globalPermissionStore2 } =
      await import("../src/permissions/permission-store.js");
    expect(globalPermissionStore).toBe(globalPermissionStore2);
  });
});
