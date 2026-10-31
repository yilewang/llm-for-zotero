import { assert } from "chai";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createBuiltInActionRegistry } from "../src/agent/actions";
import { BUILTIN_SKILL_FILES, parseSkill } from "../src/agent/skills";
import type { AgentSkill } from "../src/agent/skills/skillLoader";
import type {
  ActionCommandSlashMenuContext,
  SlashMenuActionItem,
} from "../src/modules/contextPanel/setupHandlers/controllers/actionCommandSlashMenu";
import { FakeElement } from "./helpers/fakeDom";

// Bundle the real renderers and i18n together, replacing only their runtime
// services. No Zotero startup, action execution, or model call is needed.
const rendererPath = fileURLToPath(
  new URL(
    "../src/modules/contextPanel/setupHandlers/controllers/actionCommandSlashMenu.ts",
    import.meta.url,
  ),
);
const i18nPath = fileURLToPath(
  new URL("../src/utils/i18n.ts", import.meta.url),
);
const bundle = buildSync({
  stdin: {
    contents: `export { renderSkillsInSlashMenu, renderAgentActionsInSlashMenu } from ${JSON.stringify(rendererPath)};
      export { initI18n, t } from ${JSON.stringify(i18nPath)};`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: [
    "../../../../agent",
    "../../../../agent/skills",
    "../../../../claudeCode/runtime",
    "../../portalScope",
  ],
}).outputFiles[0].text;

class MenuElement extends FakeElement {
  constructor(
    readonly ownerDocument: MenuDocument,
    tagName: string,
  ) {
    super(tagName);
  }

  querySelector(selector: string): FakeElement | null {
    const attr = /^\[([^=\]]+)(?:='([^']*)')?\]$/.exec(selector);
    if (!attr) return super.querySelector(selector);
    for (const child of this.children) {
      const value = child.getAttribute(attr[1]);
      if (value !== null && (attr[2] === undefined || attr[2] === value)) {
        return child;
      }
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

class MenuDocument {
  createElement(tagName: string): MenuElement {
    return new MenuElement(this, tagName);
  }
}

type Renderers = {
  initI18n: () => void;
  t: (text: string) => string;
  renderSkillsInSlashMenu: (
    context: ActionCommandSlashMenuContext,
    query?: string,
  ) => void;
  renderAgentActionsInSlashMenu: (
    context: ActionCommandSlashMenuContext,
    query?: string,
  ) => void;
};

describe("action and skill description localization", function () {
  const actions = createBuiltInActionRegistry()
    .listActions()
    .map((action) => Object.freeze(action));
  const skills = Object.values(BUILTIN_SKILL_FILES).map((raw) =>
    Object.freeze({
      ...parseSkill(raw),
      instruction: "Synthetic fixture guidance",
      source: "system" as const,
    }),
  );
  const personal = Object.freeze({
    ...skills[0],
    id: "personal-fixture",
    source: "personal" as const,
    description: "Unlisted personal guidance for a synthetic test",
  });
  let renderers: Renderers;
  let locale: string;
  let preference: string;
  let authMode: string | undefined;
  let chatMode: "paper" | "library";
  let currentSkills: AgentSkill[];
  let currentActions: SlashMenuActionItem[];

  beforeEach(function () {
    locale = "zh-CN";
    preference = "auto";
    authMode = "codex_app_server";
    chatMode = "paper";
    currentSkills = [...skills, personal];
    currentActions = [...actions];
    const module = { exports: {} };
    runInNewContext(bundle, {
      module,
      Zotero: {
        get locale() {
          return locale;
        },
        Prefs: { get: () => preference },
      },
      require(name: string) {
        if (name === "../../../../agent") {
          return {
            getAgentApi: () => ({
              listActions: () => currentActions,
              getPaperScopedActionProfile: () => undefined,
            }),
            initAgentSubsystem: async () => undefined,
          };
        }
        if (name === "../../../../agent/skills") {
          return { getAllSkills: () => currentSkills };
        }
        if (name === "../../../../claudeCode/runtime") {
          return { refreshClaudeSlashCommands: async () => undefined };
        }
        if (name === "../../portalScope") {
          return {
            resolveDisplayConversationKind: () =>
              chatMode === "library" ? "global" : "paper",
          };
        }
        throw new Error(`Unexpected renderer dependency: ${name}`);
      },
    });
    renderers = module.exports as Renderers;
    renderers.initI18n();
  });

  function harness() {
    const doc = new MenuDocument();
    const body = doc.createElement("div");
    const slashMenu = doc.createElement("div");
    const list = doc.createElement("div");
    list.className = "llm-action-picker-list";
    const base = doc.createElement("button");
    base.setAttribute("data-slash-base-item", "true");
    list.append(base);
    slashMenu.append(list);
    const selected: AgentSkill[] = [];
    const inserted: SlashMenuActionItem[] = [];
    const executed: SlashMenuActionItem[] = [];
    const context = {
      body,
      slashMenu,
      inputBox: { value: "synthetic request" },
      getItem: () => null,
      getSelectedProfile: () => ({ authMode }),
      isClaudeConversationSystem: () => false,
      clearAgentSlashItems: () => undefined,
      clearSkillSlashItems: () => undefined,
      consumeActiveActionToken: () => true,
      closeSlashMenu: () => undefined,
      handleSkillSelection: (skill: AgentSkill) => selected.push(skill),
      insertCommandToken: (action: SlashMenuActionItem) =>
        inserted.push(action),
      executeAgentAction: (action: SlashMenuActionItem) => {
        executed.push(action);
      },
      buildActionRequestContext: () => ({ mode: chatMode }),
    } as unknown as ActionCommandSlashMenuContext;
    return { context, list, selected, inserted, executed };
  }

  function buttons(list: FakeElement) {
    return list
      .querySelectorAll(".llm-action-picker-item")
      .filter((button) => !button.hasAttribute("data-slash-base-item"));
  }

  function title(button: FakeElement) {
    return button.querySelector(".llm-action-picker-title")?.textContent;
  }

  function description(button: FakeElement) {
    return button.querySelector(".llm-action-picker-description")?.textContent;
  }

  it("translates every shipped description only for the effective Chinese locale", function () {
    const descriptions = [
      ...actions.map((action) => action.description),
      ...skills.map((skill) => skill.description),
      "Compact the current Codex context.",
      "Compact the current agent context.",
    ];
    assert.lengthOf(descriptions, 16);
    for (const [pref, host, chinese] of [
      ["auto", "zh-CN", true],
      ["zh-CN", "en-US", true],
      ["en-US", "zh-CN", false],
      ["auto", "en-US", false],
    ] as const) {
      preference = pref;
      locale = host;
      renderers.initI18n();
      for (const text of descriptions) {
        if (chinese) assert.match(renderers.t(text), /\p{Script=Han}/u);
        else assert.equal(renderers.t(text), text);
      }
      assert.equal(renderers.t(personal.description), personal.description);
    }
  });

  for (const chinese of [true, false]) {
    it(`renders ${chinese ? "Chinese" : "English"} skill previews and tooltips without changing selection`, function () {
      locale = chinese ? "zh-CN" : "en-US";
      const { context, list, selected } = harness();
      const before = JSON.stringify(currentSkills);
      renderers.renderSkillsInSlashMenu(context);
      const items = buttons(list);
      assert.lengthOf(items, currentSkills.length);
      currentSkills.forEach((skill, index) => {
        const button = items[index];
        assert.equal(title(button), skill.id);
        assert.equal(description(button), renderers.t(skill.description));
        assert.equal(button.title, renderers.t(skill.description));
        button.dispatchFakeEvent("click");
        assert.strictEqual(selected[index], skill);
      });
      assert.equal(JSON.stringify(currentSkills), before);
    });

    it(`renders ${chinese ? "Chinese" : "English"} action previews with original command objects`, function () {
      locale = chinese ? "zh-CN" : "en-US";
      const { context, list, inserted } = harness();
      const before = JSON.stringify(currentActions);
      renderers.renderAgentActionsInSlashMenu(context);
      const items = buttons(list);
      assert.lengthOf(items, actions.length + 1);
      currentActions.forEach((action, index) => {
        const button = items.find((item) => title(item) === action.name)!;
        const translated = renderers.t(action.description);
        assert.equal(button.title, translated);
        const firstSentence = /^(.+?[。！？])|^(.+?[.!?])(?:\s|$)/.exec(
          translated,
        );
        assert.equal(
          description(button),
          firstSentence?.[1] || firstSentence?.[2],
        );
        button.dispatchFakeEvent("click");
        assert.strictEqual(inserted[index], action);
      });
      assert.equal(JSON.stringify(currentActions), before);
    });
  }

  it("matches translated text, original English, and unchanged command identifiers", function () {
    for (const query of ["统计", "statistics", "library-analysis"]) {
      const { context, list } = harness();
      renderers.renderSkillsInSlashMenu(context, query);
      assert.include(buttons(list).map(title), "library-analysis");
    }
    for (const query of ["标签", "suggest tags", "auto_tag"]) {
      const { context, list } = harness();
      renderers.renderAgentActionsInSlashMenu(context, query);
      assert.include(buttons(list).map(title), "auto_tag");
    }
    const { context, list } = harness();
    renderers.renderAgentActionsInSlashMenu(context, "压缩");
    assert.deepEqual(buttons(list).map(title), ["/compact"]);
  });

  it("does not introduce Chinese-only search matches in English mode", function () {
    locale = "en-US";
    for (const query of ["统计", "压缩"]) {
      const { context, list } = harness();
      renderers.renderSkillsInSlashMenu(context, query);
      renderers.renderAgentActionsInSlashMenu(context, query);
      assert.isEmpty(buttons(list));
    }
  });

  it("ends previews at Chinese sentence punctuation", function () {
    for (const punctuation of ["。", "！", "？"]) {
      const firstSentence = `第一句${punctuation}`;
      const text = `${firstSentence}第二句。`;
      currentActions = [
        { name: "synthetic-action", description: text, inputSchema: {} },
      ];
      const { context, list } = harness();
      renderers.renderAgentActionsInSlashMenu(context, "synthetic-action");
      const button = buttons(list)[0];
      assert.equal(description(button), firstSentence);
      assert.equal(button.title, text);
    }
  });

  it("localizes both compact descriptions without changing the inserted description", function () {
    for (authMode of ["codex_app_server", undefined]) {
      const { context, list, inserted } = harness();
      renderers.renderAgentActionsInSlashMenu(context, "compact");
      const button = buttons(list)[0];
      const english = authMode
        ? "Compact the current Codex context."
        : "Compact the current agent context.";
      assert.equal(title(button), "/compact");
      assert.equal(description(button), renderers.t(english));
      assert.equal(button.title, renderers.t(english));
      button.dispatchFakeEvent("click");
      assert.equal(inserted[0].name, "compact");
      assert.equal(inserted[0].description, english);
    }
  });

  it("passes the original action to the immediate execution path", function () {
    chatMode = "library";
    const { context, list, executed } = harness();
    renderers.renderAgentActionsInSlashMenu(context, "audit_library");
    const action = actions.find((entry) => entry.name === "audit_library")!;
    buttons(list)[0].dispatchFakeEvent("click");
    assert.strictEqual(executed[0], action);
  });
});
