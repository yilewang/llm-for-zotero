import { assert } from "chai";
import { describe, it } from "mocha";
import {
  registerStandaloneToolsMenu,
  unregisterStandaloneToolsMenu,
} from "../src/modules/contextPanel/standaloneToolsMenu";

describe("standalone Tools menu", function () {
  it("opens library chat from Zotero's Tools menu and unregisters cleanly", function () {
    const children: Array<{
      id: string;
      label?: string;
      command?: () => void;
      remove: () => void;
      setAttribute: (name: string, value: string) => void;
      addEventListener: (type: string, listener: () => void) => void;
    }> = [];
    const toolsMenu = {
      appendChild: (child: (typeof children)[number]) => children.push(child),
    };
    const document = {
      getElementById: (id: string) => {
        if (id === "menu_ToolsPopup") return toolsMenu;
        return children.find((child) => child.id === id) || null;
      },
      createXULElement: () => {
        const element = {
          id: "",
          label: undefined as string | undefined,
          command: undefined as (() => void) | undefined,
          remove: () => {
            const index = children.indexOf(element);
            if (index >= 0) children.splice(index, 1);
          },
          setAttribute: (name: string, value: string) => {
            if (name === "label") element.label = value;
          },
          addEventListener: (type: string, listener: () => void) => {
            if (type === "command") element.command = listener;
          },
        };
        return element;
      },
    };
    let openCalls = 0;

    registerStandaloneToolsMenu({
      document: document as any,
      openStandaloneChat: () => {
        openCalls += 1;
      },
    });

    assert.lengthOf(children, 1);
    assert.equal(children[0].id, "llmforzotero-open-standalone");
    assert.equal(children[0].label, "LLM Chat Window");
    children[0].command?.();
    assert.equal(openCalls, 1);

    unregisterStandaloneToolsMenu(document as any);
    assert.lengthOf(children, 0);
  });
});
