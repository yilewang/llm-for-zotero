import { assert } from "chai";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { toolGuidanceItems } from "../src/agent/tools/guidance";

/**
 * Pins the agent tool vocabulary: which tools the model sees, which stay
 * internal, and how many bytes the model-visible specs cost. Regenerate the
 * fixture deliberately with scripts/dump-agent-tool-vocabulary.mjs.
 */
type ToolVocabularyFixture = {
  visible: string[];
  internal: string[];
  specBytes: number;
};

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("./fixtures/agentToolVocabulary.json", import.meta.url),
    ),
    "utf8",
  ),
) as ToolVocabularyFixture;

/**
 * Guidance allowed past the cap, pinned at its current size so it cannot grow.
 * None today: zotero_script's sandbox API reference and undo rules, the last
 * exception, moved to the zotero-script skill on 2026-10-31.
 */
const GUIDANCE_CAP_EXCEPTIONS: ReadonlyMap<string, number> = new Map();

const stub: any = new Proxy(function () {}, {
  get: () => stub,
  apply: () => stub,
});

describe("agent tool vocabulary", function () {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: stub,
    pdfService: stub,
    pdfPageService: stub,
    retrievalService: stub,
  });
  it("model-visible tool names match the committed fixture", function () {
    const names = registry
      .listTools()
      .map((t) => t.name)
      .sort();
    assert.deepEqual(names, fixture.visible);
  });
  it("internal tool names match the committed fixture", function () {
    const names = registry
      .listToolDefinitions()
      .filter((t) => t.spec.exposure === "internal")
      .map((t) => t.spec.name)
      .sort();
    assert.deepEqual(names, fixture.internal);
  });
  it("model-visible spec text does not grow past the fixture", function () {
    const bytes = registry
      .listTools()
      .reduce((n, t) => n + JSON.stringify(t).length, 0);
    assert.isAtMost(bytes, fixture.specBytes);
  });
  it("no tool description exceeds 1200 characters", function () {
    const over = registry
      .listToolDefinitions()
      .filter((t) => t.spec.description.length > 1200)
      .map((t) => `${t.spec.name}: ${t.spec.description.length}`);
    assert.deepEqual(over, []);
  });
  // A tool with several guidance items renders each alone, so the cap
  // applies to each item.
  const longestGuidance = (guidance: unknown) =>
    Math.max(
      0,
      ...toolGuidanceItems(guidance as never).map(
        (item) => item.instruction.length,
      ),
    );
  it("no tool guidance exceeds 2500 characters", function () {
    const over = registry
      .listToolDefinitions()
      .filter((t) => {
        const length = longestGuidance(t.guidance);
        const pinned = GUIDANCE_CAP_EXCEPTIONS.get(t.spec.name);
        return pinned === undefined ? length > 2500 : length > pinned;
      })
      .map((t) => `${t.spec.name}: ${longestGuidance(t.guidance)}`);
    assert.deepEqual(over, []);
  });
  it("every guidance cap exception is still needed", function () {
    for (const [name] of GUIDANCE_CAP_EXCEPTIONS) {
      const length = longestGuidance(registry.getTool(name)?.guidance);
      assert.isAbove(length, 2500, `${name} fits the cap; drop its exception`);
    }
  });
  it("a retired name is unknown to the registry and the error names the facade", async function () {
    const prepared = await registry.prepareExecution(
      { id: "c1", name: "apply_tags", arguments: {} } as any,
      {} as any,
    );
    const text = JSON.stringify(prepared);
    assert.match(text, /Unknown tool: apply_tags/);
    assert.include(text, "library_update kind:'tags'");
  });
  it("an unknown name that was never a tool gets no hint", async function () {
    const prepared = await registry.prepareExecution(
      { id: "c2", name: "no_such_tool", arguments: {} } as any,
      {} as any,
    );
    const text = JSON.stringify(prepared);
    assert.match(text, /Unknown tool: no_such_tool/);
    assert.notInclude(text, "renamed");
  });
});
