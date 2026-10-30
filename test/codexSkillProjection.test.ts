import { assert } from "chai";
import {
  listCodexSkillProjections,
  syncCodexSkillProjections,
  type CodexSkillProjectionIO,
} from "../src/agent/skills/codexSkillProjection";

const CANONICAL = "/data/agent-runtime/p/.agents/skills";
const PROJECTED = "/data/agent-runtime/p/codex-skills";

const MARKED = [
  "---",
  "id: review",
  "name: review",
  "description: A review",
  "version: 1",
  "---",
  "",
  "Intro.",
  "",
  "<!-- runtime: claude_code -->",
  "Use the `paper-reader` subagent.",
  "<!-- /runtime -->",
  "",
  "<!-- runtime: codex -->",
  "Use `spawn_agent`.",
  "<!-- /runtime -->",
  "",
  "Outro.",
  "",
].join("\n");

const PLAIN = "---\nid: plain\nname: plain\n---\n\nNo sections.\n";

/** An in-memory folder tree with the IOUtils calls the writer uses. */
function memoryIO(files: Record<string, string>) {
  const writes: string[] = [];
  const removed: string[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const dirs = () => {
    const out = new Set<string>();
    for (const path of Object.keys(files)) {
      const parts = path.split("/");
      for (let index = 2; index < parts.length; index += 1)
        out.add(parts.slice(0, index).join("/"));
    }
    return out;
  };
  const io: CodexSkillProjectionIO = {
    exists: async (path) => path in files || dirs().has(path),
    read: async (path) => {
      if (!(path in files)) throw new Error(`missing ${path}`);
      return encoder.encode(files[path]);
    },
    write: async (path, data) => {
      files[path] = decoder.decode(data);
      writes.push(path);
      return data.length;
    },
    makeDirectory: async () => undefined,
    getChildren: async (path) => {
      if (!dirs().has(path)) throw new Error(`no folder ${path}`);
      const prefix = `${path}/`;
      const children = new Set<string>();
      for (const key of Object.keys(files))
        if (key.startsWith(prefix))
          children.add(prefix + key.slice(prefix.length).split("/")[0]);
      return [...children];
    },
    remove: async (path) => {
      for (const key of Object.keys(files))
        if (key === path || key.startsWith(`${path}/`)) delete files[key];
      removed.push(path);
    },
  };
  return { io, writes, removed };
}

const sync = (io: CodexSkillProjectionIO) =>
  syncCodexSkillProjections({
    io,
    canonicalDir: CANONICAL,
    projectionDir: PROJECTED,
  });

describe("Codex skill projection", function () {
  it("writes a Codex-only copy of a marked skill, frontmatter kept", async function () {
    const files = {
      [`${CANONICAL}/review/SKILL.md`]: MARKED,
      [`${CANONICAL}/plain/SKILL.md`]: PLAIN,
    };
    const { io, writes } = memoryIO(files);
    const result = await sync(io);
    assert.equal(result.root, PROJECTED);
    assert.deepEqual(result.projections, [
      {
        skillId: "review",
        canonicalPath: `${CANONICAL}/review/SKILL.md`,
        projectedPath: `${PROJECTED}/review/SKILL.md`,
      },
    ]);
    assert.isTrue(result.changed);
    assert.deepEqual(writes, [`${PROJECTED}/review/SKILL.md`]);
    const projected = files[`${PROJECTED}/review/SKILL.md`];
    assert.isTrue(projected.startsWith("---\nid: review\nname: review\n"));
    assert.include(projected, "Use `spawn_agent`.");
    assert.notInclude(projected, "paper-reader");
    assert.notInclude(projected, "<!--");
    // An unmarked skill keeps its native path: no copy.
    assert.notProperty(files, `${PROJECTED}/plain/SKILL.md`);
  });

  it("lists the marked skills without writing or removing anything", async function () {
    const files: Record<string, string> = {
      [`${CANONICAL}/review/SKILL.md`]: MARKED,
      [`${CANONICAL}/plain/SKILL.md`]: PLAIN,
      [`${PROJECTED}/stale/SKILL.md`]: "old",
    };
    const { io, writes, removed } = memoryIO(files);
    const result = await listCodexSkillProjections({
      io,
      canonicalDir: CANONICAL,
      projectionDir: PROJECTED,
    });
    assert.deepEqual(result.projections, [
      {
        skillId: "review",
        canonicalPath: `${CANONICAL}/review/SKILL.md`,
        projectedPath: `${PROJECTED}/review/SKILL.md`,
      },
    ]);
    assert.isFalse(result.changed);
    assert.deepEqual(writes, []);
    assert.deepEqual(removed, []);
    assert.property(files, `${PROJECTED}/stale/SKILL.md`);
  });

  it("skips a write when the copy is already current", async function () {
    const files: Record<string, string> = {
      [`${CANONICAL}/review/SKILL.md`]: MARKED,
    };
    await sync(memoryIO(files).io);
    const second = memoryIO(files);
    const result = await sync(second.io);
    assert.deepEqual(second.writes, []);
    assert.isFalse(result.changed);
    assert.lengthOf(result.projections, 1);
  });

  it("picks up a user's edit to the canonical copy", async function () {
    const files: Record<string, string> = {
      [`${CANONICAL}/review/SKILL.md`]: MARKED,
    };
    await sync(memoryIO(files).io);
    files[`${CANONICAL}/review/SKILL.md`] = MARKED.replace(
      "Outro.",
      "My own closing rule.",
    );
    const { io, writes } = memoryIO(files);
    const result = await sync(io);
    assert.deepEqual(writes, [`${PROJECTED}/review/SKILL.md`]);
    assert.isTrue(result.changed);
    assert.include(
      files[`${PROJECTED}/review/SKILL.md`],
      "My own closing rule.",
    );
  });

  it("removes a copy whose skill is gone or no longer marked", async function () {
    const files: Record<string, string> = {
      [`${CANONICAL}/review/SKILL.md`]: MARKED,
      [`${CANONICAL}/other/SKILL.md`]: MARKED.replace(/review/g, "other"),
    };
    await sync(memoryIO(files).io);
    delete files[`${CANONICAL}/other/SKILL.md`];
    files[`${CANONICAL}/review/SKILL.md`] = PLAIN;
    const { io, removed } = memoryIO(files);
    const result = await sync(io);
    assert.deepEqual(result.projections, []);
    assert.isTrue(result.changed);
    assert.sameMembers(removed, [`${PROJECTED}/review`, `${PROJECTED}/other`]);
    assert.deepEqual(
      Object.keys(files).filter((path) => path.startsWith(PROJECTED)),
      [],
    );
  });

  it("does nothing without marked skills or a skills folder", async function () {
    const plain = memoryIO({ [`${CANONICAL}/plain/SKILL.md`]: PLAIN });
    const result = await sync(plain.io);
    assert.deepEqual(result.projections, []);
    assert.isFalse(result.changed);
    assert.deepEqual(plain.writes, []);
    const empty = memoryIO({});
    assert.deepEqual((await sync(empty.io)).projections, []);
  });

  it("skips a folder whose name is not a safe skill id", async function () {
    const { io, writes } = memoryIO({
      [`${CANONICAL}/bad name/SKILL.md`]: MARKED,
    });
    assert.deepEqual((await sync(io)).projections, []);
    assert.deepEqual(writes, []);
  });
});
