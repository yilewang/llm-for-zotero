import { assert } from "chai";
import type { DiscoveredModel } from "../src/modelCapabilities";
import {
  CUSTOMIZED_MODEL_OPTION_VALUE,
  buildProviderModelSelectRows,
  canFetchProviderModels,
  createSelectRebuildGate,
  resolveModelEntryMode,
  resolveProviderModelFetchStatus,
  runAfterSelectChangeDispatch,
  resolveProviderPickerPresetId,
  sortModelOptions,
} from "../src/utils/providerModelPicker";

function liveModel(id: string): DiscoveredModel {
  return { id, source: "live" };
}

describe("providerModelPicker", function () {
  describe("eligibility", function () {
    it("enables fetch-and-select for API-key groups on preset provider bases", function () {
      assert.equal(
        resolveProviderPickerPresetId({
          authMode: "api_key",
          apiBase: "https://generativelanguage.googleapis.com/v1beta",
        }),
        "gemini",
      );
      assert.isTrue(
        canFetchProviderModels({
          authMode: "api_key",
          apiBase: "https://generativelanguage.googleapis.com/v1beta",
        }),
      );
      assert.isTrue(
        canFetchProviderModels({
          authMode: "api_key",
          apiBase: "https://api.moonshot.ai/v1",
        }),
      );
    });

    it("keeps customized providers on manual typing", function () {
      assert.isFalse(
        canFetchProviderModels({
          authMode: "api_key",
          apiBase: "https://my-llm.example.com/v1",
        }),
      );
      assert.isFalse(
        canFetchProviderModels({
          authMode: "api_key",
          apiBase: "https://api.openai.com/v1/responses",
          presetIdOverride: "customized",
        }),
        "an explicit Customized override wins over a preset-looking URL",
      );
    });

    it("keeps non-API-key auth modes on their existing flows", function () {
      assert.isFalse(
        canFetchProviderModels({
          authMode: "codex_auth",
          apiBase: "https://chatgpt.com/backend-api/codex/responses",
        }),
      );
      assert.isFalse(
        canFetchProviderModels({
          authMode: "codex_app_server",
          apiBase: "",
        }),
      );
      assert.isFalse(
        canFetchProviderModels({
          authMode: "copilot_auth",
          apiBase: "https://api.githubcopilot.com",
        }),
      );
      assert.isFalse(
        canFetchProviderModels({ authMode: "webchat", apiBase: "" }),
      );
    });
  });

  describe("sortModelOptions", function () {
    it("sorts case-insensitively without mutating the input", function () {
      const models = [liveModel("b-model"), liveModel("A-model")];
      const sorted = sortModelOptions(models);
      assert.deepEqual(
        sorted.map((model) => model.id),
        ["A-model", "b-model"],
      );
      assert.deepEqual(
        models.map((model) => model.id),
        ["b-model", "A-model"],
      );
    });
  });

  describe("buildProviderModelSelectRows", function () {
    const catalog = [
      liveModel("gemini-2.5-pro"),
      liveModel("gemini-2.0-flash"),
    ];

    it("lists the sorted catalog plus the trailing Customized row", function () {
      const rows = buildProviderModelSelectRows({
        savedModel: "gemini-2.5-pro",
        catalog,
        customizedActive: false,
      });
      assert.deepEqual(rows, [
        { kind: "model", id: "gemini-2.0-flash", fromCatalog: true },
        { kind: "model", id: "gemini-2.5-pro", fromCatalog: true },
        { kind: "customized" },
      ]);
    });

    it("keeps a saved model that the catalog does not know", function () {
      const rows = buildProviderModelSelectRows({
        savedModel: "my-fine-tune",
        catalog,
        customizedActive: false,
      });
      assert.deepEqual(rows[0], {
        kind: "model",
        id: "my-fine-tune",
        fromCatalog: false,
      });
      assert.deepEqual(rows[rows.length - 1], { kind: "customized" });
    });

    it("starts an empty row with a placeholder", function () {
      const rows = buildProviderModelSelectRows({
        savedModel: "  ",
        catalog,
        customizedActive: false,
      });
      assert.deepEqual(rows[0], { kind: "placeholder" });
    });

    it("does not duplicate the manual text as an option while Customized is active", function () {
      const rows = buildProviderModelSelectRows({
        savedModel: "my-fine-tune",
        catalog,
        customizedActive: true,
      });
      assert.deepEqual(rows, [
        { kind: "model", id: "gemini-2.0-flash", fromCatalog: true },
        { kind: "model", id: "gemini-2.5-pro", fromCatalog: true },
        { kind: "customized" },
      ]);
    });

    it("offers Customized even when the catalog is empty", function () {
      const rows = buildProviderModelSelectRows({
        savedModel: "",
        catalog: [],
        customizedActive: false,
      });
      assert.deepEqual(rows, [{ kind: "placeholder" }, { kind: "customized" }]);
    });

    it("uses a sentinel value that no provider model can collide with", function () {
      assert.match(CUSTOMIZED_MODEL_OPTION_VALUE, /^__llm-for-zotero-/);
    });
  });

  describe("resolveProviderModelFetchStatus", function () {
    const models = [liveModel("gemini-2.5-pro")];

    it("asks for an API key before fetching", function () {
      assert.deepEqual(
        resolveProviderModelFetchStatus({
          apiKey: "   ",
          loading: false,
          snapshot: null,
        }),
        { kind: "needs_api_key" },
      );
    });

    it("reports loading while a fetch is in flight", function () {
      assert.deepEqual(
        resolveProviderModelFetchStatus({
          apiKey: "k",
          loading: true,
          snapshot: null,
        }),
        { kind: "loading" },
      );
    });

    it("falls back to silent manual entry when the fetch could not run", function () {
      assert.deepEqual(
        resolveProviderModelFetchStatus({
          apiKey: "k",
          loading: false,
          snapshot: null,
        }),
        { kind: "manual_entry" },
        "a finished refresh with no snapshot means the fetch could not run",
      );
    });

    it("falls back to silent manual entry when the fetch failed", function () {
      assert.deepEqual(
        resolveProviderModelFetchStatus({
          apiKey: "k",
          loading: false,
          snapshot: { models: [], error: "catalog request failed: 401" },
        }),
        { kind: "manual_entry" },
        "fetch failures must not surface as red status lines",
      );
    });

    it("keeps the cached list usable while a refresh runs or fails", function () {
      assert.deepEqual(
        resolveProviderModelFetchStatus({
          apiKey: "k",
          loading: true,
          snapshot: { models },
        }),
        { kind: "ready", total: 1, stale: false },
      );
      assert.deepEqual(
        resolveProviderModelFetchStatus({
          apiKey: "k",
          loading: false,
          snapshot: { models, error: "offline" },
        }),
        { kind: "ready", total: 1, stale: true },
      );
    });

    it("treats an empty catalog as silent manual entry", function () {
      assert.deepEqual(
        resolveProviderModelFetchStatus({
          apiKey: "k",
          loading: false,
          snapshot: { models: [] },
        }),
        { kind: "manual_entry" },
      );
    });
  });

  describe("resolveModelEntryMode", function () {
    it("uses manual entry while the catalog is unavailable", function () {
      assert.equal(
        resolveModelEntryMode({
          status: { kind: "manual_entry" },
          userCustomized: false,
          inputFocused: false,
        }),
        "manual",
      );
    });

    it("keeps the dropdown while a key is missing or a fetch runs", function () {
      assert.equal(
        resolveModelEntryMode({
          status: { kind: "needs_api_key" },
          userCustomized: false,
          inputFocused: false,
        }),
        "select",
      );
      assert.equal(
        resolveModelEntryMode({
          status: { kind: "loading" },
          userCustomized: false,
          inputFocused: false,
        }),
        "select",
      );
    });

    it("returns to the dropdown when models arrive and the input is idle", function () {
      assert.equal(
        resolveModelEntryMode({
          status: { kind: "ready", total: 3, stale: false },
          userCustomized: false,
          inputFocused: false,
        }),
        "select",
      );
    });

    it("never swaps the field away while the user is typing in it", function () {
      assert.equal(
        resolveModelEntryMode({
          status: { kind: "ready", total: 3, stale: false },
          userCustomized: false,
          inputFocused: true,
        }),
        "manual",
      );
    });

    it("honors an explicit Customized… choice regardless of the catalog", function () {
      assert.equal(
        resolveModelEntryMode({
          status: { kind: "ready", total: 3, stale: false },
          userCustomized: true,
          inputFocused: false,
        }),
        "manual",
      );
    });
  });

  describe("rebuild gate", function () {
    function makeGate() {
      let rebuilds = 0;
      const gate = createSelectRebuildGate(() => {
        rebuilds += 1;
      });
      return { gate, rebuilds: () => rebuilds };
    }

    it("rebuilds immediately while the popup cannot be open", function () {
      const { gate, rebuilds } = makeGate();
      gate.requestRebuild();
      assert.equal(rebuilds(), 1);
    });

    it("defers a rebuild that arrives while the popup may be open", function () {
      const { gate, rebuilds } = makeGate();
      gate.popupMayOpen();
      gate.requestRebuild();
      assert.equal(
        rebuilds(),
        0,
        "must not rewrite options under an open popup",
      );
      gate.popupClosed();
      assert.equal(
        rebuilds(),
        1,
        "deferred rebuild applies once the popup closes",
      );
    });

    it("flushes a pending rebuild right before the popup reopens", function () {
      const { gate, rebuilds } = makeGate();
      // Popup opened, catalog refresh landed mid-open, user dismissed with
      // Escape (no change/blur event) — the rebuild stays pending.
      gate.popupMayOpen();
      gate.requestRebuild();
      assert.equal(rebuilds(), 0);
      // Next mousedown fires before the popup opens: safe to flush.
      gate.popupMayOpen();
      assert.equal(rebuilds(), 1);
    });

    it("coalesces multiple deferred requests into one rebuild", function () {
      const { gate, rebuilds } = makeGate();
      gate.popupMayOpen();
      gate.requestRebuild();
      gate.requestRebuild();
      gate.popupClosed();
      assert.equal(rebuilds(), 1);
    });

    it("does not rebuild on close when nothing was requested", function () {
      const { gate, rebuilds } = makeGate();
      gate.popupMayOpen();
      gate.popupClosed();
      gate.popupMayOpen();
      assert.equal(rebuilds(), 0);
    });
  });

  describe("change-dispatch deferral", function () {
    it("never runs the work synchronously inside the change dispatch", function () {
      let ran = false;
      runAfterSelectChangeDispatch(() => {
        ran = true;
      });
      // Gecko calls the popup helper's trailing uninit() right after our
      // change listener returns; work must not have run by then.
      assert.isFalse(ran);
    });

    it("runs the work on a following microtask, preserving order", async function () {
      const order: string[] = [];
      runAfterSelectChangeDispatch(() => order.push("first"));
      runAfterSelectChangeDispatch(() => order.push("second"));
      order.push("dispatch-still-running");
      await Promise.resolve();
      assert.deepEqual(order, ["dispatch-still-running", "first", "second"]);
    });
  });
});
