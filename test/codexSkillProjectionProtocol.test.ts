/**
 * Codex reads only the Codex-only copy of a skill with runtime sections:
 * the copies' folder is registered on each app-server process before its
 * first thread request, each thread hides the canonical copy by path, and a
 * selected marked skill is sent as an item for its copy. An app-server that
 * rejects the registration gets the skill through the stripped instruction
 * block.
 */
import { assert } from "chai";
import { runCodexAppServerNativeTurn } from "./helpers/preparedNativeTurn";
import {
  createNativeLifecycleTestProcess,
  installDirectPathTestPrefs,
} from "./helpers/codexNativeLifecycle";
import { getAllSkills, setUserSkills } from "../src/agent/skills";
import type { AgentSkill } from "../src/agent/skills";
import { parseSkill } from "../src/agent/skills/skillLoader";
import {
  getCanonicalSkillFilePath,
  getCodexSkillProjectionDir,
  getCodexSkillProjectionFilePath,
  getCanonicalUserSkillsDir,
} from "../src/agent/skills/nativeSkillPaths";
import {
  CODEX_SKILLS_EXTRA_ROOTS_SET_METHOD,
  prepareCodexSkillProjections,
  resetCodexSkillProjectionStateForTests,
  withCodexSkillDisableRules,
} from "../src/codexAppServer/skillProjection";
import { forkCodexAppServerThread } from "../src/codexAppServer/nativeClient";
import {
  CodexAppServerProcess,
  destroyCachedCodexAppServerProcess,
} from "../src/utils/codexAppServerProcess";
import {
  CLAUDE_SECTION_NAME,
  CODEX_SECTION_NAME,
  RUNTIME_SECTION_SKILL_ID as SKILL_ID,
  RUNTIME_SECTION_SKILL_RAW,
} from "./helpers/runtimeSectionSkillFixture";

type Request = { method: string; params: Record<string, any> };

describe("withCodexSkillDisableRules", function () {
  it("adds one path rule per canonical copy and keeps every other key", function () {
    const config = { mcp_servers: { zotero: { url: "x" } }, features: {} };
    const merged = withCodexSkillDisableRules(config, ["/a/SKILL.md"]);
    assert.deepEqual(merged, {
      mcp_servers: { zotero: { url: "x" } },
      features: {},
      "skills.config": [{ path: "/a/SKILL.md", enabled: false }],
    });
    assert.notProperty(config, "skills.config");
  });

  it("appends to an existing skills.config list and keeps its rules", function () {
    const merged = withCodexSkillDisableRules(
      {
        "skills.config": [
          { name: "other", enabled: false },
          { path: "/b/SKILL.md", enabled: true },
        ],
      },
      ["/a/SKILL.md", "/b/SKILL.md"],
    );
    assert.deepEqual(merged?.["skills.config"], [
      { name: "other", enabled: false },
      { path: "/b/SKILL.md", enabled: true },
      { path: "/a/SKILL.md", enabled: false },
    ]);
  });

  it("puts the rules into a nested skills object and keeps its other keys", function () {
    const merged = withCodexSkillDisableRules(
      { skills: { bundled: { enabled: true }, config: [{ name: "x" }] } },
      ["/a/SKILL.md"],
    );
    assert.deepEqual(merged, {
      skills: {
        bundled: { enabled: true },
        config: [{ name: "x" }, { path: "/a/SKILL.md", enabled: false }],
      },
    });
  });

  it("leaves a config alone with no paths, and an unmergeable value unchanged", function () {
    const config = { features: {} };
    assert.strictEqual(withCodexSkillDisableRules(config, []), config);
    assert.isUndefined(withCodexSkillDisableRules(undefined, []));
    assert.deepEqual(
      withCodexSkillDisableRules({ "skills.config": "bad" }, ["/a"]),
      { "skills.config": "bad" },
    );
    assert.deepEqual(withCodexSkillDisableRules(undefined, ["/a"]), {
      "skills.config": [{ path: "/a", enabled: false }],
    });
  });
});

describe("prepareCodexSkillProjections", function () {
  beforeEach(function () {
    resetCodexSkillProjectionStateForTests();
  });
  const projection =
    (changed: boolean, count = 1) =>
    async () => ({
      root: "/r",
      projections: Array.from({ length: count }, (_, index) => ({
        skillId: `s${index}`,
        canonicalPath: `/c/s${index}/SKILL.md`,
        projectedPath: `/r/s${index}/SKILL.md`,
      })),
      changed,
    });

  it("registers once per process, again after a change, and never without marked skills", async function () {
    const sent: unknown[] = [];
    const proc = {
      sendRequest: async (method: string, params?: unknown) => {
        sent.push([method, params]);
        return {};
      },
    };
    const none = { sendRequest: async () => assert.fail("no request") };
    assert.isFalse(
      (await prepareCodexSkillProjections(none, projection(false, 0)))
        .registered,
    );
    assert.isTrue(
      (await prepareCodexSkillProjections(proc, projection(true))).registered,
    );
    await prepareCodexSkillProjections(proc, projection(false));
    assert.lengthOf(sent, 1);
    await prepareCodexSkillProjections(proc, projection(true));
    assert.lengthOf(sent, 2);
    assert.deepEqual(sent[0], [
      CODEX_SKILLS_EXTRA_ROOTS_SET_METHOD,
      { extraRoots: ["/r"] },
    ]);
  });

  it("still names the marked skills, unregistered, when the sync fails", async function () {
    const proc = { sendRequest: async () => assert.fail("no request") };
    const state = await prepareCodexSkillProjections(
      proc,
      async () => {
        throw new Error("disk full");
      },
      projection(false, 2),
    );
    assert.isFalse(state.registered);
    assert.deepEqual(
      state.projections.map((entry) => entry.canonicalPath),
      ["/c/s0/SKILL.md", "/c/s1/SKILL.md"],
    );
    const neither = await prepareCodexSkillProjections(
      proc,
      async () => {
        throw new Error("disk full");
      },
      async () => {
        throw new Error("unreadable");
      },
    );
    assert.deepEqual(neither, { root: "", projections: [], registered: false });
  });

  it("marks a process that rejects the request and does not ask it again", async function () {
    let calls = 0;
    const proc = {
      sendRequest: async () => {
        calls += 1;
        throw new Error("Method not found");
      },
    };
    const first = await prepareCodexSkillProjections(proc, projection(true));
    assert.isFalse(first.registered);
    assert.lengthOf(first.projections, 1);
    await prepareCodexSkillProjections(proc, projection(true));
    assert.equal(calls, 1);
  });
});

/** An in-memory IOUtils over `files`, for the projection writer. */
function installMemoryIOUtils(files: Record<string, string>) {
  const original = (globalThis as any).IOUtils;
  const folders = () => {
    const out = new Set<string>();
    for (const path of Object.keys(files)) {
      const parts = path.split("/");
      for (let index = 2; index < parts.length; index += 1)
        out.add(parts.slice(0, index).join("/"));
    }
    return out;
  };
  (globalThis as any).IOUtils = {
    exists: async (path: string) => path in files || folders().has(path),
    read: async (path: string) => {
      if (!(path in files)) throw new Error(`missing ${path}`);
      return new TextEncoder().encode(files[path]);
    },
    write: async (path: string, data: Uint8Array) => {
      files[path] = new TextDecoder().decode(data);
      return data.length;
    },
    makeDirectory: async () => undefined,
    getChildren: async (path: string) => {
      if (!folders().has(path)) throw new Error(`no folder ${path}`);
      const prefix = `${path}/`;
      return [
        ...new Set(
          Object.keys(files)
            .filter((key) => key.startsWith(prefix))
            .map((key) => prefix + key.slice(prefix.length).split("/")[0]),
        ),
      ];
    },
    remove: async (path: string) => {
      for (const key of Object.keys(files))
        if (key === path || key.startsWith(`${path}/`)) delete files[key];
    },
  };
  return () => {
    (globalThis as any).IOUtils = original;
  };
}

describe("Codex native turns read the Codex-only copy of a marked skill", function () {
  let installed: AgentSkill[] = [];
  let restorePrefs: () => void = () => undefined;
  let restoreIO: () => void = () => undefined;
  let files: Record<string, string> = {};
  let canonicalPath = "";
  let projectedPath = "";
  const originalSpawn = CodexAppServerProcess.spawn;

  beforeEach(function () {
    resetCodexSkillProjectionStateForTests();
    installed = [...getAllSkills()];
    setUserSkills([parseSkill(RUNTIME_SECTION_SKILL_RAW)]);
    restorePrefs = installDirectPathTestPrefs("native");
    canonicalPath = getCanonicalSkillFilePath(SKILL_ID);
    projectedPath = getCodexSkillProjectionFilePath(SKILL_ID);
    assert.isFalse(projectedPath.startsWith(getCanonicalUserSkillsDir()));
    files = {
      [canonicalPath]: RUNTIME_SECTION_SKILL_RAW.replace(
        "---\n",
        `---\nname: ${SKILL_ID}\n`,
      ),
    };
    restoreIO = installMemoryIOUtils(files);
  });

  afterEach(function () {
    CodexAppServerProcess.spawn = originalSpawn;
    restoreIO();
    restorePrefs();
    setUserSkills(installed);
  });

  const skillsList = () => ({
    data: [
      {
        cwd: "/",
        errors: [],
        skills: [
          { name: SKILL_ID, path: canonicalPath, enabled: true },
          { name: SKILL_ID, path: projectedPath, enabled: true },
        ],
      },
    ],
  });

  async function runTurn(params: {
    processKey: string;
    conversationKey: number;
    storedThreadId?: string;
    extraRootsSetUnsupported?: boolean;
  }): Promise<Request[]> {
    const requests: Request[] = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-projection"],
      requests,
      skillsListResult: skillsList(),
      extraRootsSetUnsupported: params.extraRootsSetUnsupported,
    });
    CodexAppServerProcess.spawn = async () => proc;
    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-projection",
          conversationKey: params.conversationKey,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.6",
        messages: [{ role: "user", content: "Review my collection." }],
        processKey: params.processKey,
        hooks: {
          loadProviderSessionId: async () => params.storedThreadId,
          persistProviderSessionId: async () => undefined,
        },
        skillContext: { forcedSkillIds: [SKILL_ID] },
      });
    } finally {
      destroyCachedCodexAppServerProcess(params.processKey, proc);
    }
    return requests;
  }

  const indexOf = (requests: Request[], method: string) =>
    requests.findIndex((request) => request.method === method);
  const disableRule = () => [{ path: canonicalPath, enabled: false }];

  it("registers the copies before thread/start, hides the canonical copy, and selects the copy by path", async function () {
    const requests = await runTurn({
      processKey: "projection-start",
      conversationKey: 6_000_000_901,
    });
    const register = indexOf(requests, CODEX_SKILLS_EXTRA_ROOTS_SET_METHOD);
    const start = indexOf(requests, "thread/start");
    assert.isAtLeast(register, 0);
    assert.isAbove(start, register);
    assert.deepEqual(requests[register].params, {
      extraRoots: [getCodexSkillProjectionDir()],
    });
    assert.deepEqual(
      requests[start].params.config["skills.config"],
      disableRule(),
    );
    // The MCP and feature keys the turn already sent stay.
    assert.property(requests[start].params.config, "features");
    const turnStart = requests[indexOf(requests, "turn/start")];
    const skillItems = (turnStart.params.input as any[]).filter(
      (item) => item.type === "skill",
    );
    assert.deepEqual(skillItems, [
      { type: "skill", name: SKILL_ID, path: projectedPath },
    ]);
    const projected = files[projectedPath];
    assert.include(projected, `\`${CODEX_SECTION_NAME}\``);
    assert.notInclude(projected, CLAUDE_SECTION_NAME);
    assert.notInclude(projected, "<!--");
    assert.notInclude(JSON.stringify(turnStart.params), CLAUDE_SECTION_NAME);
  });

  it("registers again on a respawned process before thread/resume, which hides the canonical copy", async function () {
    await runTurn({
      processKey: "projection-respawn",
      conversationKey: 6_000_000_902,
    });
    const requests = await runTurn({
      processKey: "projection-respawn",
      conversationKey: 6_000_000_902,
      storedThreadId: "thread-existing",
    });
    const register = indexOf(requests, CODEX_SKILLS_EXTRA_ROOTS_SET_METHOD);
    const resume = indexOf(requests, "thread/resume");
    assert.isAtLeast(register, 0);
    assert.isAbove(resume, register);
    assert.deepEqual(
      requests[resume].params.config["skills.config"],
      disableRule(),
    );
  });

  it("sends the skill through the stripped instruction block when registration fails", async function () {
    const requests = await runTurn({
      processKey: "projection-fallback",
      conversationKey: 6_000_000_903,
      extraRootsSetUnsupported: true,
    });
    const start = requests[indexOf(requests, "thread/start")];
    assert.deepEqual(start.params.config["skills.config"], disableRule());
    const turnStart = requests[indexOf(requests, "turn/start")];
    assert.isFalse(
      (turnStart.params.input as any[]).some((item) => item.type === "skill"),
    );
    const delivered = JSON.stringify([start.params, turnStart.params]);
    assert.include(delivered, "LLM-for-Zotero skills active for this turn");
    assert.include(delivered, "These skill instructions explicitly ask");
    assert.notInclude(delivered, CLAUDE_SECTION_NAME);
  });

  it("keeps the canonical copy hidden and uses the block when writing the copies fails", async function () {
    const io = (globalThis as any).IOUtils;
    io.write = async () => {
      throw new Error("disk full");
    };
    const requests = await runTurn({
      processKey: "projection-write-fails",
      conversationKey: 6_000_000_904,
    });
    assert.equal(indexOf(requests, CODEX_SKILLS_EXTRA_ROOTS_SET_METHOD), -1);
    const start = requests[indexOf(requests, "thread/start")];
    assert.deepEqual(start.params.config["skills.config"], disableRule());
    const turnStart = requests[indexOf(requests, "turn/start")];
    assert.isFalse(
      (turnStart.params.input as any[]).some((item) => item.type === "skill"),
    );
    const delivered = JSON.stringify([start.params, turnStart.params]);
    assert.include(delivered, "LLM-for-Zotero skills active for this turn");
    assert.notInclude(delivered, CLAUDE_SECTION_NAME);
  });

  it("registers before thread/fork and hides the canonical copy on the fork", async function () {
    const requests: Request[] = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: [],
      requests,
    });
    CodexAppServerProcess.spawn = async () => proc;
    try {
      const threadId = await forkCodexAppServerThread({
        threadId: "thread-source",
        targetConversationKey: 6_000_000_904,
        processKey: "projection-fork",
      });
      assert.equal(threadId, "thread-forked");
    } finally {
      destroyCachedCodexAppServerProcess("projection-fork", proc);
    }
    const register = indexOf(requests, CODEX_SKILLS_EXTRA_ROOTS_SET_METHOD);
    const fork = indexOf(requests, "thread/fork");
    assert.isAtLeast(register, 0);
    assert.isAbove(fork, register);
    assert.deepEqual(
      requests[fork].params.config["skills.config"],
      disableRule(),
    );
    // The fork's MCP override stays beside the rule.
    assert.property(requests[fork].params.config, "mcp_servers");
  });
});
