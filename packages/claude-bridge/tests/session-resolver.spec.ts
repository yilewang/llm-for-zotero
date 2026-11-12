import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InMemorySessionMapper,
  JsonFileSessionMapper,
} from "../src/session-link/session-mapper.js";
import {
  SessionResolver,
  type SessionDiscoveryClient,
} from "../src/session-link/session-resolver.js";

describe("SessionResolver", () => {
  it("returns existing mapped session without discovery", async () => {
    const mapper = new InMemorySessionMapper();
    await mapper.set("conv-1", "sess-existing");

    let discoveryCalls = 0;
    const discoveryClient: SessionDiscoveryClient = {
      async listSessions() {
        discoveryCalls += 1;
        return [{ sessionId: "sess-new" }];
      },
    };

    const resolver = new SessionResolver({
      sessionMapper: mapper,
      discoveryClient,
    });
    const sessionId = await resolver.resolveForConversation({
      conversationKey: "conv-1",
    });

    expect(sessionId).toBe("sess-existing");
    expect(discoveryCalls).toBe(0);
  });

  it("hydrates from latest discovered session when mapping is empty", async () => {
    const mapper = new InMemorySessionMapper();
    const discoveryClient: SessionDiscoveryClient = {
      async listSessions(options) {
        expect(options?.limit).toBe(1);
        expect(options?.includeWorktrees).toBe(true);
        return [{ sessionId: "sess-latest", summary: "latest" }];
      },
    };

    const resolver = new SessionResolver({
      sessionMapper: mapper,
      discoveryClient,
    });
    const sessionId = await resolver.resolveForConversation({
      conversationKey: "conv-2",
      dir: "/tmp/project",
    });

    expect(sessionId).toBe("sess-latest");
    expect(await mapper.get("conv-2")).toBe("sess-latest");
  });

  it("returns undefined when no discoverable sessions exist", async () => {
    const mapper = new InMemorySessionMapper();
    const discoveryClient: SessionDiscoveryClient = {
      async listSessions() {
        return [];
      },
    };

    const resolver = new SessionResolver({
      sessionMapper: mapper,
      discoveryClient,
    });
    const sessionId = await resolver.resolveForConversation({
      conversationKey: "conv-3",
    });

    expect(sessionId).toBeUndefined();
    expect(await mapper.get("conv-3")).toBeUndefined();
  });

  it("serializes json-file session mapper writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adapter-session-mapper-"));
    const filePath = join(dir, "sessions.json");
    const mapper = new JsonFileSessionMapper(filePath);

    try {
      await Promise.all([
        mapper.set("conv-1", "sess-1"),
        mapper.set("conv-2", "sess-2"),
        mapper.set("conv-3", "sess-3"),
      ]);

      expect(await mapper.get("conv-1")).toBe("sess-1");
      expect(await mapper.get("conv-2")).toBe("sess-2");
      expect(await mapper.get("conv-3")).toBe("sess-3");

      await Promise.all([
        mapper.delete("conv-1"),
        mapper.set("conv-2", "sess-2b"),
      ]);

      expect(await mapper.get("conv-1")).toBeUndefined();
      expect(await mapper.get("conv-2")).toBe("sess-2b");
      expect(await mapper.get("conv-3")).toBe("sess-3");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
