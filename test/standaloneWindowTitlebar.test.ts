import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { installStandaloneWindowTitlebar } from "../src/modules/contextPanel/standaloneWindowTitlebar";

const here = dirname(fileURLToPath(import.meta.url));

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes: Record<string, string> = {};
  className = "";

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  hasAttribute(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  querySelector(selector: string): FakeElement | null {
    const wanted = selector.replace(".", "");
    for (const child of this.children) {
      if (child.className.split(" ").includes(wanted)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

class FakeDocument {
  readonly documentElement = new FakeElement();

  createElementNS(_namespace: string, _name: string): FakeElement {
    return new FakeElement();
  }
}

describe("standalone window title bar strip", function () {
  it("adds a traffic light strip to the host it is given", function () {
    const doc = new FakeDocument();
    doc.documentElement.setAttribute("customtitlebar", "true");
    const host = new FakeElement();

    installStandaloneWindowTitlebar(
      doc as unknown as Document,
      host as unknown as HTMLElement,
    );

    const strip = host.children[0];
    assert.equal(strip.className, "llm-window-titlebar");
    assert.equal(strip.children[0].className, "llm-window-buttons");
    assert.equal(strip.children[0].attributes["aria-hidden"], "true");
  });

  it("adds nothing on a platform that keeps its native title bar", function () {
    const doc = new FakeDocument();
    const host = new FakeElement();

    installStandaloneWindowTitlebar(
      doc as unknown as Document,
      host as unknown as HTMLElement,
    );

    assert.deepEqual(host.children, []);
  });

  it("never installs a second strip into the same host", function () {
    const doc = new FakeDocument();
    doc.documentElement.setAttribute("customtitlebar", "true");
    const host = new FakeElement();

    installStandaloneWindowTitlebar(
      doc as unknown as Document,
      host as unknown as HTMLElement,
    );
    installStandaloneWindowTitlebar(
      doc as unknown as Document,
      host as unknown as HTMLElement,
    );

    assert.lengthOf(host.children, 1);
  });

  it("runs the title bar bootstrap in the diagram window too", function () {
    const markup = readFileSync(
      resolve(here, "../addon/content/standaloneMermaid.xhtml"),
      "utf8",
    );

    assert.include(markup, 'src="standaloneTitlebar.js"');
  });

  it("installs the strip after the diagram window replaces its children", function () {
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/standaloneMermaidWindow.ts"),
      "utf8",
    );

    // replaceChildren wipes the root, so the strip has to be added afterwards
    // or it would vanish the moment the diagram renders.
    const replaceAt = source.indexOf("root.replaceChildren(");
    const installAt = source.indexOf("installStandaloneWindowTitlebar(");
    assert.isAbove(replaceAt, -1);
    assert.isAbove(installAt, replaceAt);
  });
});
