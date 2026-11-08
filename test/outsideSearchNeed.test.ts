import { assert } from "chai";
import { createLiteratureSearchTool } from "../src/agent/tools/read/literatureSearch";
import { createWebSearchTool } from "../src/agent/tools/read/webSearch";
import {
  OUTSIDE_SEARCH_GAP_MESSAGE,
  OUTSIDE_SEARCH_NEED_MESSAGE,
  OUTSIDE_SEARCH_NEED_SENTENCE,
} from "../src/agent/tools/read/outsideSearchNeed";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import {
  TAVILY_API_KEY_PREF,
  setWebAccessProvider,
} from "../src/webAccess/prefs";
import type { AgentToolContext } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

/**
 * Every outside search states why the turn's papers and the library cannot
 * hold the need, and the progress view shows that reason. Host actions that
 * search on the user's explicit command pass a value the model never sees.
 */

const MODEL_NEEDS = [
  "not_in_scope_or_library",
  "current_or_public_facts",
  "user_named_outside_source",
];

const context: AgentToolContext = {
  runId: "outside-search-need",
  request: resolvedAgentRequest({
    conversationKey: 21,
    mode: "agent",
    userText: "Did other studies find the same result?",
    libraryID: 1,
  }),
  item: null,
  currentAnswerText: "",
  modelName: "test",
};

function errorOf(validation: { ok: boolean; error?: string }): string {
  assert.isFalse(validation.ok, "expected a rejection");
  return validation.error || "";
}

describe("outside search need", function () {
  const originalZotero = globalThis.Zotero;
  let prefs: Map<string, unknown>;

  beforeEach(function () {
    prefs = new Map<string, unknown>([
      [TAVILY_API_KEY_PREF, "synthetic-tavily-key"],
    ]);
    globalThis.Zotero = {
      ...((originalZotero as unknown as Record<string, unknown>) || {}),
      Prefs: {
        get: (name: string) => prefs.get(name),
        set: (name: string, value: unknown) => prefs.set(name, value),
      },
    } as unknown as typeof Zotero;
  });

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  describe("literature_search", function () {
    const tool = createLiteratureSearchTool({} as never);

    it("rejects an answer search without a need", function () {
      for (const args of [
        { mode: "search", query: "place cells" },
        { mode: "search", query: "place cells", workflow: "answer" },
        { mode: "recommendations", itemId: 5 },
        { mode: "references", itemId: 5 },
        { mode: "citations", itemId: 5 },
        { mode: "search", query: "place cells", need: "because" },
      ]) {
        assert.equal(
          errorOf(tool.validate(args)),
          OUTSIDE_SEARCH_NEED_MESSAGE,
          JSON.stringify(args),
        );
      }
    });

    it("requires gap only for not_in_scope_or_library", function () {
      for (const gap of [undefined, "", "   "]) {
        assert.equal(
          errorOf(
            tool.validate({
              mode: "search",
              query: "place cells",
              need: "not_in_scope_or_library",
              gap,
            }),
          ),
          OUTSIDE_SEARCH_GAP_MESSAGE,
        );
      }
      assert.isTrue(
        tool.validate({
          mode: "search",
          query: "place cells",
          need: "not_in_scope_or_library",
          gap: "The paper and library have no later replications.",
        }).ok,
      );
      for (const need of [
        "current_or_public_facts",
        "user_named_outside_source",
      ]) {
        assert.isTrue(
          tool.validate({ mode: "search", query: "place cells", need }).ok,
          need,
        );
      }
    });

    it("requires neither need nor gap on a find-paper search (user decision 1a)", function () {
      // A find or recommend search (workflow:'review') states no reason
      // (user decision 1a, 2026-10-20); a live find request lost a round
      // to a rejected review search without need.
      for (const args of [
        { mode: "search", query: "place cells", workflow: "review" },
        { mode: "recommendations", itemId: 5, workflow: "review" },
        {
          mode: "search",
          query: "place cells",
          workflow: "review",
          need: "not_in_scope_or_library",
        },
      ]) {
        assert.isTrue(tool.validate(args).ok, JSON.stringify(args));
      }
      assert.include(tool.spec.description, "workflow:'review' needs neither");
      assert.notInclude(
        tool.spec.description,
        "workflow:'review' needs no gap",
      );
    });

    it("exempts metadata lookups and accepts the host-only value", function () {
      assert.isTrue(tool.validate({ mode: "metadata", title: "A paper" }).ok);
      assert.isTrue(
        tool.validate({
          mode: "metadata",
          workflow: "review",
          title: "A paper",
        }).ok,
      );
      assert.isTrue(
        tool.validate({
          mode: "recommendations",
          itemId: 5,
          need: "host_action",
        }).ok,
      );
    });

    it("returns the rejection through the registry as rejected input", async function () {
      const registry = new AgentToolRegistry();
      registry.register(tool);
      const prepared = await registry.prepareExecution(
        {
          id: "call-1",
          name: "literature_search",
          arguments: { mode: "search", query: "place cells" },
        },
        context,
      );
      assert.equal(prepared.kind, "result");
      if (prepared.kind !== "result") return;
      assert.isTrue(prepared.execution.result.inputRejected);
      assert.deepEqual(prepared.execution.result.content, {
        error: `Invalid tool input for literature_search: ${OUTSIDE_SEARCH_NEED_MESSAGE}`,
      });
    });

    it("shows need and gap to the model without the host-only value", function () {
      const registry = createBuiltInToolRegistry({
        zoteroGateway: {} as never,
        pdfService: {} as never,
        pdfPageService: {} as never,
        retrievalService: {} as never,
      });
      const spec = registry
        .listTools()
        .find((entry) => entry.name === "literature_search")!;
      const properties = (
        spec.inputSchema as {
          properties: Record<string, { type?: string; enum?: string[] }>;
        }
      ).properties;
      assert.deepEqual(properties.need, { type: "string", enum: MODEL_NEEDS });
      assert.deepEqual(properties.gap, { type: "string" });
      assert.include(spec.description, OUTSIDE_SEARCH_NEED_SENTENCE);
      assert.include(spec.description, "mode:'metadata' needs none");
    });

    it("shows the reason on its trace line", function () {
      const details = (args: Record<string, unknown>) =>
        tool.presentation!.buildTraceDetails!({
          args: { mode: "search", query: "place cells", ...args },
          content: { results: [] },
        });
      assert.deepEqual(
        details({
          need: "not_in_scope_or_library",
          gap: "No later replications.",
        }),
        [
          { label: "Query", value: "place cells" },
          {
            label: "Why outside",
            value:
              "Not in this chat's papers or your library: No later replications.",
          },
        ],
      );
      assert.deepInclude(details({ need: "current_or_public_facts" }), {
        label: "Why outside",
        value: "Current or public facts",
      });
      assert.deepInclude(details({ need: "user_named_outside_source" }), {
        label: "Why outside",
        value: "You named an outside source",
      });
      assert.deepInclude(
        details({
          need: "not_in_scope_or_library",
          gap: `a\n${"x".repeat(500)}`,
        }),
        {
          label: "Why outside",
          value: `Not in this chat's papers or your library: a ${"x".repeat(197)}…`,
        },
      );
      for (const args of [{}, { need: "host_action" }]) {
        assert.notInclude(
          details(args).map((detail) => detail.label),
          "Why outside",
        );
      }
    });
  });

  describe("web_search", function () {
    it("rejects a search without a need and keeps need out of the provider call", async function () {
      const searched: Array<Record<string, unknown>> = [];
      const tool = createWebSearchTool(
        () =>
          ({
            search: async (input: Record<string, unknown>) => {
              searched.push(input);
              return { provider: "tavily", query: "x", results: [] };
            },
          }) as never,
      );
      assert.equal(
        errorOf(tool.validate({ query: "x", depth: "basic" })),
        OUTSIDE_SEARCH_NEED_MESSAGE,
      );
      assert.equal(
        errorOf(
          tool.validate({
            query: "x",
            depth: "basic",
            need: "not_in_scope_or_library",
          }),
        ),
        OUTSIDE_SEARCH_GAP_MESSAGE,
      );
      // No host action runs web_search, so the host-only value is no reason.
      assert.equal(
        errorOf(
          tool.validate({ query: "x", depth: "basic", need: "host_action" }),
        ),
        OUTSIDE_SEARCH_NEED_MESSAGE,
      );
      const valid = tool.validate({
        query: "x",
        depth: "basic",
        need: "current_or_public_facts",
      });
      assert.isTrue(valid.ok);
      if (!valid.ok) return;
      await tool.execute(valid.value, context);
      assert.notProperty(searched[0], "need");
      assert.notProperty(searched[0], "gap");
    });

    it("defines need and gap in its schema and description", function () {
      const tool = createWebSearchTool();
      const schema = tool.spec.inputSchema as {
        required: string[];
        properties: Record<string, { enum?: string[] }>;
      };
      assert.include(schema.required, "need");
      assert.deepEqual(schema.properties.need.enum, MODEL_NEEDS);
      assert.property(schema.properties, "gap");
      assert.include(tool.spec.description, OUTSIDE_SEARCH_NEED_SENTENCE);
    });

    it("accepts need and gap with AnySearch", function () {
      setWebAccessProvider("anysearch");
      const tool = createWebSearchTool();
      const schema = tool.spec.inputSchema as {
        required: string[];
        properties: Record<string, { enum?: string[] }>;
      };
      assert.include(schema.required, "need");
      assert.deepEqual(schema.properties.need.enum, MODEL_NEEDS);
      assert.property(schema.properties, "gap");
      assert.include(tool.spec.description, OUTSIDE_SEARCH_NEED_SENTENCE);
      assert.equal(
        errorOf(tool.validate({ query: "x" })),
        OUTSIDE_SEARCH_NEED_MESSAGE,
      );
      const valid = tool.validate({
        query: "x",
        need: "not_in_scope_or_library",
        gap: "Release dates are not in papers.",
      });
      assert.isTrue(valid.ok, JSON.stringify(valid));
      if (valid.ok)
        assert.deepEqual(valid.value, { query: "x", maxResults: 5 });
    });

    it("shows the reason on its trace line", function () {
      const tool = createWebSearchTool();
      const details = tool.presentation!.buildTraceDetails!({
        args: {
          query: "release date",
          depth: "basic",
          need: "current_or_public_facts",
        },
        content: { results: [] },
      });
      assert.deepEqual(details, [
        { label: "Query", value: "release date" },
        { label: "Why outside", value: "Current or public facts" },
      ]);
      // A call recorded before need existed keeps its query row.
      assert.deepEqual(
        tool.presentation!.buildTraceDetails!({
          args: { query: "release date", depth: "basic" },
          content: { results: [] },
        }),
        [{ label: "Query", value: "release date" }],
      );
    });
  });
});
