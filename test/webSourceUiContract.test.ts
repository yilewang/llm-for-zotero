import { assert } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  injectWebSourceAnchorTokens,
  normalizeWebSourcePopoverRows,
} from "../src/modules/contextPanel/webSourceIndicators";
import { buildAssistantResponseActionTarget } from "../src/modules/contextPanel/chat";
import type { WebSourceAnchor } from "../src/webAccess/types";
import { createWebFaviconImage } from "../src/modules/contextPanel/webFavicon";
import { initI18n, t } from "../src/utils/i18n";

describe("web source UI contract", function () {
  const root = process.cwd();

  it("translates the complete web-provider preferences copy for Chinese users", function () {
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
        tavilyCopy.filter(
          (english) =>
            !["Tavily", "AnySearch", "DeepSeek"].includes(english) &&
            t(english) === english,
        ),
        [],
        "every visible web-provider card string except brand names must have a Chinese translation",
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
      for (const label of ['t("View sources")', 't("Open web source")']) {
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
    assert.include(css, "overflow-y: auto");
    assert.include(css, "position: fixed");
    assert.include(css, ".llm-web-source-popover-visible");
    assert.include(css, ".llm-web-source-row + .llm-web-source-row::before");
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
        sourceId: "web_abc1234",
      },
    ]);
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "faviconUrl",
      "organization",
      "sourceId",
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
    const source =
      readFileSync(
        join(root, "src/modules/contextPanel/webSourceIndicators.ts"),
        "utf8",
      ) +
      readFileSync(
        join(root, "src/modules/contextPanel/sourcePopover.ts"),
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
    assert.notInclude(libraryIcon, 'width="800px"');
  });

  describe("end source chip", function () {
    const TOKEN = "LLMWEBSOURCEANCHOR0END";
    const endAnchor = (offset: number): WebSourceAnchor => ({
      offset,
      placement: "end",
      sources: [
        {
          sourceId: "web_1",
          url: "https://example.com/report",
          hostname: "example.com",
          organization: "Example",
          title: "Report",
        },
      ],
    });

    it("puts an end anchor on its own paragraph after a closing code fence", function () {
      const markdown = "Text\n\n```\ncode\n```";
      const result = injectWebSourceAnchorTokens(markdown, [
        endAnchor(markdown.length),
      ]);
      assert.equal(result, `${markdown}\n\n${TOKEN}`);
      assert.isTrue(result.endsWith(`\`\`\`\n\n${TOKEN}`));
    });

    it("puts an end anchor after a table without breaking it", function () {
      const table = "| h | k |\n|---|---|\n| a | b |";
      const result = injectWebSourceAnchorTokens(table, [
        endAnchor(table.length),
      ]);
      assert.equal(result, `${table}\n\n${TOKEN}`);
    });

    it("shows an end anchor even when the stored text is shorter than its offset", function () {
      const markdown = "A twenty-char answer";
      assert.lengthOf(markdown, 20);
      const result = injectWebSourceAnchorTokens(markdown, [endAnchor(999)]);
      assert.equal(result, `${markdown}\n\n${TOKEN}`);
    });

    it("keeps host notes after the end chip", function () {
      assert.equal(
        injectWebSourceAnchorTokens("Answer.\n\nNote from host.", [
          endAnchor(7),
        ]),
        `Answer.\n\n${TOKEN}\n\nNote from host.`,
      );
    });

    it("closes an open code fence before the end chip", function () {
      const markdown = "Text\n\n```\ncode";
      assert.equal(
        injectWebSourceAnchorTokens(markdown, [endAnchor(markdown.length)]),
        `${markdown}\n\`\`\`\n\n${TOKEN}`,
      );
    });

    it("keeps a paragraph chip at the same offset before the end chip", function () {
      const paragraph: WebSourceAnchor = { ...endAnchor(2) };
      delete paragraph.placement;
      assert.equal(
        injectWebSourceAnchorTokens("A.", [paragraph, endAnchor(2)]),
        "A.LLMWEBSOURCEANCHOR0END\n\nLLMWEBSOURCEANCHOR1END",
      );
    });

    it("keeps placement when building the response action target", function () {
      const target = buildAssistantResponseActionTarget({
        item: { id: 42, libraryID: 1 } as unknown as Zotero.Item,
        pairedUserMessage: null,
        conversationKey: 9,
        message: {
          role: "assistant",
          text: "A complete answer",
          timestamp: 200,
          modelName: "Codex",
        },
        webSourceAnchors: [endAnchor(17)],
      });
      assert.equal(target?.webSourceAnchors?.[0]?.placement, "end");
      assert.equal(target?.webSourceAnchors?.[0]?.offset, 17);
    });
  });
});
