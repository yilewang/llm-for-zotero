import { assert } from "chai";
import type { AgentRunEventRecord } from "../src/agent/types";
import type { Message } from "../src/modules/contextPanel/types";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: activity disclosure after history reload", function () {
  this.timeout(30000);
  type Mounted = ReturnType<WorkflowTestApi["mountAgentActivityTrace"]>;
  let api: WorkflowTestApi;
  const mounted: Mounted[] = [];
  const delay = () => Zotero.Promise.delay(250);
  const runId = "workflow-reloaded-activity";
  const text = "The recorded Codex answer is complete.";
  const events = (complete: boolean): AgentRunEventRecord[] => [
    {
      runId,
      seq: 1,
      eventType: "codex_progress",
      createdAt: 1000,
      payload: {
        type: "codex_progress",
        itemId: "recorded-progress",
        text,
        status: complete ? "completed" : "running",
      },
    },
    ...(complete
      ? [
          {
            runId,
            seq: 2,
            eventType: "final" as const,
            createdAt: 3000,
            payload: { type: "final" as const, text },
          },
        ]
      : []),
  ];
  const mount = (working = false) => {
    // History reload constructs a fresh Message and does not restore streaming.
    const message: Message = {
      role: "assistant",
      timestamp: 1000,
      text,
      runMode: "agent",
      modelProviderLabel: "Codex",
      agentRunId: runId,
      ...(working ? { streaming: true } : {}),
    };
    const fixture = api.mountAgentActivityTrace(message);
    mounted.push(fixture);
    return fixture;
  };
  const disclosure = (fixture: Mounted) => {
    const details = fixture.root.querySelector<HTMLDetailsElement>(
      ".llm-agent-activity-details",
    );
    assert.exists(details);
    return details!;
  };
  const summary = (fixture: Mounted) =>
    disclosure(fixture).querySelector<HTMLElement>("summary")!;
  const clickSummary = async (fixture: Mounted) => {
    const details = disclosure(fixture);
    const win = details.ownerDocument.defaultView!;
    const toggled = new Promise<void>((resolve, reject) => {
      const onToggle = () => {
        win.clearTimeout(timeout);
        resolve();
      };
      const timeout = win.setTimeout(() => {
        details.removeEventListener("toggle", onToggle);
        reject(new Error("The native details toggle did not arrive"));
      }, 2000);
      details.addEventListener("toggle", onToggle, { once: true });
    });
    summary(fixture).click();
    await toggled;
  };

  beforeEach(function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest as WorkflowTestApi;
  });

  afterEach(function () {
    for (const fixture of mounted.splice(0)) fixture.dispose();
  });

  it("keeps completed activity closed through a cold trace load and a second reload", async function () {
    for (let reload = 0; reload < 2; reload += 1) {
      const fixture = mount();
      const loadingDetails = disclosure(fixture);
      let nativeToggles = 0;
      loadingDetails.addEventListener("toggle", () => nativeToggles++);
      assert.include(fixture.root.textContent || "", "Loading agent activity");
      // Gecko dispatches a programmatic open's toggle in a later task. Hydrating
      // synchronously would miss the cache pollution that happens on restart.
      await delay();
      const loadingOpen = loadingDetails.open;
      fixture.render(events(true));
      await delay();
      const diagnostic = JSON.stringify({ reload, loadingOpen, nativeToggles });
      assert.isFalse(disclosure(fixture).open, diagnostic);
      assert.isFalse(loadingOpen, diagnostic);
      assert.match(summary(fixture).textContent || "", /^Worked for /);
      fixture.dispose();
    }
  });

  it("preserves native user open and close choices through hydration and rebuilding", async function () {
    for (const expectedOpen of [true, false]) {
      const fixture = mount();
      await delay();
      if (disclosure(fixture).open) await clickSummary(fixture);
      await clickSummary(fixture);
      if (!expectedOpen) await clickSummary(fixture);
      assert.equal(disclosure(fixture).open, expectedOpen);
      fixture.render(events(true));
      await delay();
      assert.equal(disclosure(fixture).open, expectedOpen, "after hydration");
      fixture.render(events(true), { rebuild: true });
      await delay();
      assert.equal(disclosure(fixture).open, expectedOpen, "after rebuilding");
      fixture.dispose();
    }
  });

  it("opens running activity during loading and hydration, then closes on completion", async function () {
    const fixture = mount(true);
    await delay();
    assert.isTrue(disclosure(fixture).open);
    assert.include(summary(fixture).textContent || "", "Working");
    fixture.render(events(false));
    await delay();
    assert.isTrue(disclosure(fixture).open);
    fixture.render(events(true), { streaming: false });
    await delay();
    assert.isFalse(disclosure(fixture).open);
    assert.match(summary(fixture).textContent || "", /^Worked for /);
  });
});
