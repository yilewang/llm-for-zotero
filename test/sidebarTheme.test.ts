import { assert } from "chai";
import {
  normalizeSidebarCustomColor,
  sidebarCustomColorIsDark,
  SIDEBAR_CUSTOM_COLOR_PREF,
  getSidebarTheme,
  installSidebarThemePreference,
  normalizeSidebarTheme,
  SIDEBAR_THEME_PREF,
} from "../src/modules/contextPanel/sidebarTheme";
import { FakeElement } from "./helpers/fakeDom";

describe("sidebar color theme", function () {
  const globals = globalThis as any;
  let originalZotero: any;
  beforeEach(function () {
    originalZotero = globals.Zotero;
  });
  afterEach(function () {
    globals.Zotero = originalZotero;
  });

  it("normalizes RGB hex colors and rejects invalid CSS", function () {
    assert.equal(normalizeSidebarCustomColor(" #AbC "), "#aabbcc");
    assert.equal(normalizeSidebarCustomColor("C8EDCC"), "#c8edcc");
    for (const value of [
      null,
      "",
      "#12",
      "#1234",
      "#12345678",
      "red",
      "#gggggg",
      "url(test)",
    ]) {
      assert.isNull(normalizeSidebarCustomColor(value));
    }
    assert.isTrue(sidebarCustomColorIsDark("#000000"));
    assert.isTrue(sidebarCustomColorIsDark("#0000ff"));
    assert.isFalse(sidebarCustomColorIsDark("#ffffff"));
    assert.isFalse(sidebarCustomColorIsDark("#c8edcc"));
    assert.isFalse(sidebarCustomColorIsDark("#ff0000"));
  });

  it("accepts only supported palettes and safely falls back", function () {
    for (const theme of [
      "default",
      "dark",
      "green",
      "sepia",
      "beanGreen",
      "skyBlue",
      "grassGreen",
    ]) {
      assert.equal(normalizeSidebarTheme(theme), theme);
    }
    for (const value of [
      undefined,
      null,
      0,
      "",
      "invalid",
      "toString",
      "__proto__",
    ]) {
      assert.equal(normalizeSidebarTheme(value), "default");
    }
    globals.Zotero = undefined;
    assert.equal(getSidebarTheme(), "default");
  });

  it("restores the saved palette, updates every host, and disposes observers", function () {
    let saved = "green";
    let customColor = "#c8edcc";
    let nextId = 0;
    const observers = new Map<number, () => void>();
    globals.Zotero = {
      Prefs: {
        get: (key: string, global: boolean) => {
          assert.include([SIDEBAR_THEME_PREF, SIDEBAR_CUSTOM_COLOR_PREF], key);
          assert.isTrue(global);
          return key === SIDEBAR_CUSTOM_COLOR_PREF ? customColor : saved;
        },
        registerObserver: (
          key: string,
          callback: () => void,
          global: boolean,
        ) => {
          assert.include([SIDEBAR_THEME_PREF, SIDEBAR_CUSTOM_COLOR_PREF], key);
          assert.isTrue(global);
          const id = nextId++;
          observers.set(id, callback);
          return id;
        },
        unregisterObserver: (id: number) => observers.delete(id),
      },
    };
    const first = new FakeElement("html");
    const second = new FakeElement("html");
    const disposeFirst = installSidebarThemePreference({
      documentElement: first,
    } as unknown as Document);
    const disposeSecond = installSidebarThemePreference({
      documentElement: second,
    } as unknown as Document);
    const attr = "data-llm-sidebar-theme";
    assert.equal(first.getAttribute(attr), "green");
    assert.equal(second.getAttribute(attr), "green");
    for (const theme of [
      "dark",
      "green",
      "sepia",
      "beanGreen",
      "skyBlue",
      "grassGreen",
    ]) {
      saved = theme;
      observers.forEach((callback) => callback());
      assert.equal(first.getAttribute(attr), theme);
      assert.equal(second.getAttribute(attr), theme);
    }
    saved = "custom";
    observers.forEach((callback) => callback());
    assert.equal(first.getAttribute(attr), "custom-light");
    assert.equal(first.style["--llm-custom-background"], "#c8edcc");
    customColor = "#123";
    observers.forEach((callback) => callback());
    assert.equal(first.getAttribute(attr), "custom-dark");
    assert.equal(second.style["--llm-custom-background"], "#112233");
    saved = "default";
    observers.forEach((callback) => callback());
    assert.isFalse(first.hasAttribute(attr));
    assert.isFalse(second.hasAttribute(attr));
    disposeFirst();
    assert.equal(observers.size, 2);
    saved = "sepia";
    observers.forEach((callback) => callback());
    assert.isFalse(first.hasAttribute(attr));
    assert.equal(second.getAttribute(attr), "sepia");
    disposeSecond();
    assert.equal(observers.size, 0);
    assert.isFalse(second.hasAttribute(attr));
  });
});
