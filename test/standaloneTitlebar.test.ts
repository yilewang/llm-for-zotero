import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { assert } from "chai";

const here = dirname(fileURLToPath(import.meta.url));

const TITLEBAR_SCRIPT = resolve(here, "../addon/content/standaloneTitlebar.js");

const STANDALONE_MARKUP = [
  "standaloneChat.xhtml",
  "standaloneResponseDocument.xhtml",
  "standalonePlanDocument.xhtml",
];

type FakeRoot = {
  attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
  hasAttribute(name: string): boolean;
};

function runTitlebarScript(platform: string): FakeRoot {
  const documentElement: FakeRoot = {
    attributes: new Map<string, string>(),
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
    hasAttribute(name: string) {
      return this.attributes.has(name);
    },
  };
  const sandbox = {
    document: { documentElement },
    ChromeUtils: {
      importESModule: (url: string) => {
        assert.equal(url, "resource://gre/modules/AppConstants.sys.mjs");
        return { AppConstants: { platform } };
      },
    },
  };
  createContext(sandbox);
  runInContext(readFileSync(TITLEBAR_SCRIPT, "utf8"), sandbox, {
    filename: "standaloneTitlebar.js",
  });
  return documentElement;
}

describe("standalone custom title bar bootstrap", function () {
  it("removes the native title bar on macOS", function () {
    const root = runTitlebarScript("macosx");

    assert.equal(root.attributes.get("customtitlebar"), "true");
  });

  it("keeps the native title bar and caption buttons on Windows and Linux", function () {
    for (const platform of ["win", "linux"]) {
      assert.isFalse(
        runTitlebarScript(platform).hasAttribute("customtitlebar"),
        `${platform} must keep its native window controls`,
      );
    }
  });

  it("survives a runtime without the platform module instead of blocking the window", function () {
    const documentElement: FakeRoot = {
      attributes: new Map<string, string>(),
      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
      },
      hasAttribute(name: string) {
        return this.attributes.has(name);
      },
    };
    const sandbox = {
      document: { documentElement },
      ChromeUtils: {
        importESModule: () => {
          throw new Error("module unavailable");
        },
      },
    };
    createContext(sandbox);

    assert.doesNotThrow(() =>
      runInContext(readFileSync(TITLEBAR_SCRIPT, "utf8"), sandbox, {
        filename: "standaloneTitlebar.js",
      }),
    );
    assert.isFalse(documentElement.hasAttribute("customtitlebar"));
  });

  it("runs during parse in every standalone chrome document", function () {
    for (const file of STANDALONE_MARKUP) {
      const markup = readFileSync(
        resolve(here, "../addon/content", file),
        "utf8",
      );
      assert.include(
        markup,
        'src="standaloneTitlebar.js"',
        `${file} must load the title bar bootstrap`,
      );
    }
  });
});
