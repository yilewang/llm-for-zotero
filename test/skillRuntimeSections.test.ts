import { assert } from "chai";
import {
  hasSkillRuntimeMarker,
  skillBodyForRuntime,
} from "../src/agent/skills/runtimeSections";

const BODY = [
  "Intro.",
  "",
  "<!-- runtime: claude_code -->",
  "Use the paper-reader subagent.",
  "<!-- /runtime -->",
  "",
  "<!-- runtime: codex -->",
  "Use spawn_agent and wait.",
  "<!-- /runtime -->",
  "",
  "Outro.",
].join("\n");

describe("skillBodyForRuntime", function () {
  it("keeps the runtime's own section without its markers and strips the other", function () {
    assert.equal(
      skillBodyForRuntime(BODY, "claude_code"),
      "Intro.\n\nUse the paper-reader subagent.\n\nOutro.",
    );
    assert.equal(
      skillBodyForRuntime(BODY, "codex"),
      "Intro.\n\nUse spawn_agent and wait.\n\nOutro.",
    );
  });

  it("strips every section with no runtime (the plugin's own Agent)", function () {
    for (const runtime of [undefined, null, "", "upstream"]) {
      assert.equal(
        skillBodyForRuntime(BODY, runtime as never),
        "Intro.\n\nOutro.",
        String(runtime),
      );
    }
  });

  it("strips every section for an unknown runtime, and a section with an unknown id for every runtime", function () {
    assert.equal(
      skillBodyForRuntime(BODY, "claude" as never),
      "Intro.\n\nOutro.",
    );
    const odd = [
      "A.",
      "<!-- runtime: claude-code -->",
      "secret",
      "<!-- /runtime -->",
      "<!-- runtime -->",
      "also secret",
      "<!-- /runtime -->",
      "B.",
    ].join("\n");
    for (const runtime of ["claude_code", "codex", undefined] as const)
      assert.equal(skillBodyForRuntime(odd, runtime), "A.\nB.");
  });

  it("strips to the end of the body when a close marker is missing, even for its own runtime", function () {
    const broken = [
      "A.",
      "<!-- runtime: codex -->",
      "Use spawn_agent.",
      "B.",
    ].join("\n");
    for (const runtime of ["codex", "claude_code", undefined] as const)
      assert.equal(skillBodyForRuntime(broken, runtime), "A.");
  });

  it("treats an open marker inside an open section as a broken close", function () {
    const nested = [
      "A.",
      "<!-- runtime: codex -->",
      "codex text",
      "<!-- runtime: claude_code -->",
      "claude text",
      "<!-- /runtime -->",
      "B.",
    ].join("\n");
    for (const runtime of ["codex", "claude_code", undefined] as const)
      assert.equal(skillBodyForRuntime(nested, runtime), "A.");
  });

  it("drops a stray close marker and never returns a marker", function () {
    const stray = "A.\n<!-- /runtime -->\nB.";
    assert.equal(skillBodyForRuntime(stray, "codex"), "A.\nB.");
    assert.isTrue(hasSkillRuntimeMarker(BODY));
    for (const runtime of ["codex", "claude_code", undefined] as const)
      assert.isFalse(hasSkillRuntimeMarker(skillBodyForRuntime(BODY, runtime)));
  });

  it("returns a body without markers unchanged", function () {
    const plain = "A.\n\n\n\nB.  \n";
    assert.equal(skillBodyForRuntime(plain, "codex"), plain);
    assert.equal(skillBodyForRuntime(plain), plain);
  });

  it("accepts markers with extra spaces and indentation", function () {
    const spaced =
      "A.\n  <!--runtime:codex-->  \nC.\n<!--   /runtime   -->\nB.";
    assert.equal(skillBodyForRuntime(spaced, "codex"), "A.\nC.\nB.");
    assert.equal(skillBodyForRuntime(spaced, "claude_code"), "A.\nB.");
  });
});
