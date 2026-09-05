import { assert } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeWebSourcePopoverRows } from "../src/modules/contextPanel/webSourceIndicators";
import { createWebFaviconImage } from "../src/modules/contextPanel/webFavicon";
import { initI18n, t } from "../src/utils/i18n";

describe("web source UI contract", function () {
  const root = process.cwd();

  it("places the shared-style Tavily card immediately before Codex App Server", function () {
    const preferences = readFileSync(
      join(root, "addon/content/preferences.xhtml"),
      "utf8",
    );
    const tavilyIndex = preferences.indexOf('id="__addonRef__-tavily-card"');
    const codexIndex = preferences.indexOf(
      'id="__addonRef__-codex-app-server-card"',
    );
    assert.isAtLeast(tavilyIndex, 0);
    assert.isAbove(codexIndex, tavilyIndex);
    assert.include(preferences, 'id="__addonRef__-tavily-api-key"');
    assert.include(preferences, 'type="password"');
    assert.include(preferences, "Test connection");
    assert.include(preferences, "Get a free API key");
    assert.include(preferences, "Basic search costs 1 Tavily credit");
    assert.match(preferences, /retention,\s+and search-index\s+policies/);
    assert.match(
      preferences,
      /favicons are loaded from public URLs\s+supplied by Tavily/,
    );
    const tavilyCard = preferences.slice(tavilyIndex, codexIndex);
    assert.notMatch(tavilyCard, /enable-tavily|type="checkbox"/i);

    const preferenceScript = readFileSync(
      join(root, "src/modules/preferenceScript.ts"),
      "utf8",
    );
    assert.include(
      preferenceScript,
      'tavilyStatus.textContent = `${t("Connected")} · ${usage.plan}`;',
    );
    assert.notInclude(preferenceScript, 't("API key usage")');
    assert.notInclude(preferenceScript, 't("Account usage")');
  });

  it("translates the complete Tavily preferences copy for Chinese users", function () {
    const globalWithZotero = globalThis as typeof globalThis & {
      Zotero?: {
        Prefs?: { get: () => string };
        locale?: string;
      };
    };
    const previousZotero = globalWithZotero.Zotero;
    globalWithZotero.Zotero = {
      Prefs: { get: () => "zh-CN" },
      locale: "zh-CN",
    };
    initI18n();

    try {
      assert.equal(t("Tavily Web Search"), "Tavily 网页搜索");
      assert.equal(t("API key"), "API 密钥");
      assert.equal(t("Get a free API key"), "获取免费 API 密钥");
      assert.equal(
        t("Enter a Tavily API key first."),
        "请先输入 Tavily API 密钥。",
      );
      assert.equal(t("Connected"), "已连接");

      for (const status of [
        "Could not reach Tavily. Check the network connection.",
        "Tavily rejected the API key. Check it in Preferences → Agent.",
        "Tavily rate-limited the request. Try again later.",
        "The Tavily plan credit limit has been reached.",
        "The Tavily pay-as-you-go limit has been reached.",
        "Tavily is temporarily unavailable. Try again later.",
      ]) {
        assert.notEqual(t(status), status, status);
      }

      assert.equal(t("View web sources"), "查看网页来源");
      assert.equal(t("Web sources"), "网页来源");
      assert.equal(t("Open web source"), "打开网页来源");

      const preferences = readFileSync(
        join(root, "addon/content/preferences.xhtml"),
        "utf8",
      );
      const tavilyStart = preferences.indexOf('id="__addonRef__-tavily-card"');
      const tavilyEnd = preferences.indexOf(
        'id="__addonRef__-codex-app-server-card"',
      );
      const tavilyCopy = Array.from(
        preferences.slice(tavilyStart, tavilyEnd).matchAll(/>([^<>]+)</g),
        (match) => match[1].replace(/\s+/g, " ").trim(),
      ).filter(Boolean);
      assert.deepEqual(
        tavilyCopy.filter((english) => t(english) === english),
        [],
        "every visible Tavily card string must have a Chinese translation",
      );

      const preferenceScript = readFileSync(
        join(root, "src/modules/preferenceScript.ts"),
        "utf8",
      );
      assert.match(
        preferenceScript,
        /t\(\s*error instanceof Error \? error\.message : String\(error\),\s*\)/,
      );
      const sourceIndicators = readFileSync(
        join(root, "src/modules/contextPanel/webSourceIndicators.ts"),
        "utf8",
      );
      for (const label of [
        't("View web sources")',
        't("Web sources")',
        't("Open web source")',
      ]) {
        assert.include(sourceIndicators, label);
      }
    } finally {
      if (previousZotero !== undefined) {
        globalWithZotero.Zotero = previousZotero;
      } else {
        delete globalWithZotero.Zotero;
      }
      initI18n();
    }
  });

  it("uses the existing paper-card surface and selectable-row primitives", function () {
    const css = readFileSync(
      join(root, "addon/content/zoteroPane.css"),
      "utf8",
    );
    assert.match(css, /\.llm-paper-picker-item,\s*\.llm-web-source-row\s*\{/);
    assert.match(
      css,
      /\.llm-selected-context-expanded,\s*\.llm-web-source-popover\s*\{/,
    );
    assert.include(css, 'url("icons/action-mode-global.svg")');
    assert.include(css, "background: var(--material-background)");
    assert.include(css, "border: 1px solid var(--stroke-secondary)");
    assert.include(css, "max-height: min(52vh, 320px)");
    assert.include(css, "overflow-y: auto");
    assert.include(css, "position: fixed");
    assert.include(css, ".llm-web-source-popover-visible");
    assert.include(css, ".llm-web-source-row + .llm-web-source-row::before");
    assert.include(
      css,
      "background: var(--stroke-secondary, rgba(120, 120, 120, 0.35))",
    );
  });

  it("exposes organization, title, safe URL, and optional favicon to each stacked row", function () {
    const rows = normalizeWebSourcePopoverRows({
      offset: 10,
      sources: [
        {
          sourceId: "web_abc1234",
          url: "https://example.com/page",
          hostname: "example.com",
          organization: "Example Organization",
          title: "Page title",
          faviconUrl: "https://example.com/favicon.ico",
        },
        {
          sourceId: "web_bad1234",
          url: "http://127.0.0.1/private",
          hostname: "127.0.0.1",
          organization: "Private",
          title: "Private page",
        },
      ],
    });
    assert.deepEqual(rows, [
      {
        organization: "Example Organization",
        title: "Page title",
        url: "https://example.com/page",
        faviconUrl: "https://example.com/favicon.ico",
      },
    ]);
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "faviconUrl",
      "organization",
      "title",
      "url",
    ]);
  });

  it("loads only safe favicons and hides a failed image to expose the globe fallback", function () {
    let onError: (() => void) | undefined;
    const image = {
      hidden: false,
      setAttribute: () => {},
      addEventListener: (name: string, listener: () => void) => {
        if (name === "error") onError = listener;
      },
    } as unknown as HTMLImageElement;
    const doc = {
      createElement: () => image,
    } as unknown as Document;

    assert.isNull(
      createWebFaviconImage(doc, "http://127.0.0.1/favicon.ico", "favicon"),
    );
    assert.equal(
      createWebFaviconImage(doc, "https://example.com/favicon.ico", "favicon"),
      image,
    );
    assert.equal(image.src, "https://example.com/favicon.ico");
    assert.equal(image.referrerPolicy, "no-referrer");
    onError?.();
    assert.isTrue(image.hidden);
  });

  it("implements hover, focus, pin, Escape, outside-click, clamp, and URL launch behavior", function () {
    const source = readFileSync(
      join(root, "src/modules/contextPanel/webSourceIndicators.ts"),
      "utf8",
    );
    for (const required of [
      'addEventListener("mouseenter"',
      'addEventListener("focusin"',
      'addEventListener("focusout"',
      'event.key !== "Escape"',
      'classList.toggle("expanded", pinned)',
      'addEventListener("mousedown"',
      "getBoundingClientRect()",
      "(doc.body || doc.documentElement).appendChild(popover)",
      "Zotero.launchURL(safeUrl)",
    ]) {
      assert.include(source, required);
    }
    assert.notMatch(
      source,
      /llm-web-source-(?:previous|next|carousel|pagination|counter)/,
    );
    assert.include(source, '"llm-web-source-favicon"');
    assert.notInclude(source, "source.publishedDate");
    assert.notInclude(source, "source.retrievalTime");
    assert.notInclude(source, "wrapper.append(chip, popover)");
  });

  it("uses the connected vertical trace layout for web details", function () {
    const css = readFileSync(
      join(root, "addon/content/zoteroPane.css"),
      "utf8",
    );
    assert.include(css, ".llm-agent-trace-timeline");
    assert.include(css, ".llm-agent-trace-timeline::before");
    assert.include(css, 'url("icons/action-reasoning-brain.svg")');
    assert.include(css, 'url("icons/action-mode-global.svg")');
    assert.include(css, ".llm-agent-trace-timeline-favicon");
    assert.include(css, ".llm-web-source-favicon");
    assert.match(
      css,
      /\.llm-agent-trace-timeline-favicon\s*\{[^}]*background:\s*transparent/s,
    );
    assert.match(
      css,
      /\.llm-web-source-favicon\s*\{[^}]*background:\s*var\(--material-background\)/s,
    );
    assert.include(css, ".llm-agent-trace-timeline-icon-has-favicon::before");
    assert.include(css, ".llm-web-source-site-icon-has-favicon::before");
    assert.include(css, "[hidden]");
    assert.include(css, "text-overflow: ellipsis");
    assert.include(css, "white-space: nowrap");
    assert.notInclude(css, ".llm-agent-trace-timeline-row-paper");
  });

  it("distinguishes literature and web activity with existing semantic icons", function () {
    const css = readFileSync(
      join(root, "addon/content/zoteroPane.css"),
      "utf8",
    );
    const libraryIcon = readFileSync(
      join(root, "addon/content/icons/action-library.svg"),
      "utf8",
    );
    assert.include(css, ".llm-at-icon-library");
    assert.include(css, 'url("icons/action-library.svg")');
    assert.include(css, ".llm-at-icon-web");
    assert.include(css, 'url("icons/action-mode-global.svg")');
    assert.include(libraryIcon, 'viewBox="0 0 16 16"');
    assert.include(libraryIcon, 'fill="currentColor"');
    assert.notInclude(libraryIcon, "490.667");
    assert.notInclude(libraryIcon, 'width="800px"');
  });

  it("aligns search activity icons with the first text line at every font scale", function () {
    const css = readFileSync(
      join(root, "addon/content/zoteroPane.css"),
      "utf8",
    );
    const iconRule =
      css.match(
        /\.llm-at-icon-library,\s*\.llm-at-icon-web\s*\{[\s\S]*?\}/,
      )?.[0] || "";

    assert.include(iconRule, "flex: 0 0 var(--llm-fs-12)");
    assert.include(iconRule, "width: var(--llm-fs-12)");
    assert.include(iconRule, "height: var(--llm-fs-12)");
    assert.include(
      iconRule,
      "margin-block-start: calc(1.7px * var(--llm-font-scale, 1))",
    );

    for (const fontScale of [0.8, 1.2, 1.8]) {
      const textLineCenter = (11 * fontScale * 1.4) / 2;
      const iconCenter = 1.7 * fontScale + (12 * fontScale) / 2;
      assert.approximately(iconCenter, textLineCenter, 1e-9);
    }
  });

  it("centers a fixed-ratio favicon inside its circular container", function () {
    const css = readFileSync(
      join(root, "addon/content/zoteroPane.css"),
      "utf8",
    );
    const websiteIconRule =
      css.match(
        /\.llm-agent-trace-timeline-icon-website\s*\{[\s\S]*?\}/,
      )?.[0] || "";
    const faviconRule =
      css.match(/\.llm-agent-trace-timeline-favicon\s*\{[\s\S]*?\}/)?.[0] || "";

    assert.include(websiteIconRule, "display: grid");
    assert.include(websiteIconRule, "place-items: center");
    assert.include(websiteIconRule, "width: 20px");
    assert.include(websiteIconRule, "height: 20px");
    assert.include(websiteIconRule, "margin-left: -1px");
    assert.include(websiteIconRule, "border-radius: 50%");
    assert.include(websiteIconRule, "background: var(--material-background)");
    assert.notInclude(websiteIconRule, "transform:");
    assert.include(faviconRule, "position: static");
    assert.include(faviconRule, "display: block");
    assert.include(faviconRule, "width: 70%");
    assert.include(faviconRule, "height: 70%");
    assert.include(faviconRule, "border-radius: 0");
    assert.include(faviconRule, "background: transparent");
    assert.include(faviconRule, "object-fit: contain");
    assert.notInclude(faviconRule, "transform:");
  });
});
