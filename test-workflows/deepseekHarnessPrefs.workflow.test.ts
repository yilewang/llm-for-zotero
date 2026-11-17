import { assert } from "chai";
import { config } from "../package.json";

const id = (name: string) => `${config.addonRef}-${name}`;
const key = (name: string) => `${config.prefsPrefix}.${name}`;

describe("workflow: DeepSeek Harness preferences", function () {
  it("keeps Harness settings separate and switches the shared Agent engine", async function () {
    const initial = {
      agentExecutionEngine: "builtin",
      enableAgentMode: false,
      deepseekHarnessNodePath: "/test/node",
      deepseekHarnessWorkerPath: "/test/worker.mjs",
    };
    const prefs = Object.keys(initial).map(key);
    const saved = prefs.map((pref) =>
      Services.prefs.prefHasUserValue(pref)
        ? Zotero.Prefs.get(pref, true)
        : undefined,
    );
    const read = (name: string) => Zotero.Prefs.get(key(name), true);
    let win: Window | undefined;
    try {
      for (const [name, value] of Object.entries(initial)) {
        Zotero.Prefs.set(key(name), value, true);
      }
      win = (
        Zotero.Utilities.Internal as unknown as {
          openPreferences: (pane: string) => Window;
        }
      ).openPreferences(`${config.addonRef}-preferences`);
      const doc = () => win!.document;
      const get = (name: string) => doc().getElementById(id(name));
      const input = (name: string) => get(name) as HTMLInputElement | null;
      const deadline = Date.now() + 10000;
      while (
        input("deepseek-harness-worker-path")?.value !==
          initial.deepseekHarnessWorkerPath &&
        Date.now() < deadline
      ) {
        await Zotero.Promise.delay(50);
      }
      assert.equal(
        input("deepseek-harness-worker-path")?.value,
        initial.deepseekHarnessWorkerPath,
        "preferences initialized the worker path",
      );

      const rows = Array.from(
        get("pref-panel-agent")!.querySelectorAll("[data-llm-agent-row]"),
      ) as Element[];
      assert.deepEqual(
        rows.slice(0, 4).map((row) => row.getAttribute("data-llm-agent-row")),
        ["original", "harness", "codex", "claude"],
      );
      const [original, harness] = rows;
      assert.equal(harness.parentElement, original.parentElement);
      assert.isTrue(original.contains(get("tavily-card")));
      assert.isTrue(original.contains(get("original-agent-permission-mode")));
      assert.isNull(get("agent-execution-engine"));

      const tab = doc().querySelector<HTMLButtonElement>(
        '[data-pref-tab="agent"]',
      );
      tab!.click();
      const disclosure = harness.querySelector<HTMLButtonElement>(
        `.llm-pref-row-toggle[aria-controls="${id("agent-row-harness-body")}"]`,
      );
      assert.exists(disclosure);
      disclosure!.click();
      assert.equal(disclosure!.getAttribute("aria-expanded"), "true");
      const body = get("agent-row-harness-body")!;
      for (const path of ["node", "worker"]) {
        assert.isTrue(body.contains(get(`deepseek-harness-${path}-path`)));
      }

      for (const name of [
        "enable-agent-mode",
        "enable-deepseek-harness",
        "codex-app-server-enable",
        "agent-backend-mode",
      ]) {
        const checkbox = input(name);
        assert.equal(checkbox?.type, "checkbox", name);
        assert.isTrue(checkbox?.classList.contains("llm-pref-switch"), name);
      }

      const originalSwitch = input("enable-agent-mode")!;
      const harnessSwitch = input("enable-deepseek-harness")!;
      assert.isTrue(original.contains(originalSwitch));
      assert.isTrue(harness.contains(harnessSwitch));
      const switchState = (builtin: boolean, deepseek: boolean) => {
        assert.equal(originalSwitch.checked, builtin, "Original Agent switch");
        assert.equal(harnessSwitch.checked, deepseek, "Harness switch");
        assert.equal(read("enableAgentMode"), builtin || deepseek);
      };
      switchState(false, false);
      harnessSwitch.click();
      switchState(false, true);
      assert.equal(read("agentExecutionEngine"), "deepseek_harness");

      const inactiveChange = doc().createEvent("Event");
      inactiveChange.initEvent("change", true, false);
      originalSwitch.dispatchEvent(inactiveChange);
      switchState(false, true);

      harnessSwitch.click();
      switchState(false, false);
      assert.equal(read("agentExecutionEngine"), "deepseek_harness");
      assert.equal(
        read("deepseekHarnessNodePath"),
        initial.deepseekHarnessNodePath,
      );
      assert.equal(
        read("deepseekHarnessWorkerPath"),
        initial.deepseekHarnessWorkerPath,
      );

      harnessSwitch.click();
      originalSwitch.click();
      switchState(true, false);
      assert.equal(read("agentExecutionEngine"), "builtin");
    } finally {
      win?.close();
      prefs.forEach((pref, index) => {
        const value = saved[index];
        if (value === undefined) Zotero.Prefs.clear(pref, true);
        else Zotero.Prefs.set(pref, value, true);
      });
      const deadline = Date.now() + 10000;
      while (win && !win.closed && Date.now() < deadline) {
        await Zotero.Promise.delay(50);
      }
      if (win) assert.isTrue(win.closed, "preferences window closed");
    }
  });
});
