import { assert } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectRunWebSources } from "../src/modules/contextPanel/webSourcesData";
import {
  openWebSourceLink,
  registerSidePanelWebHost,
  unregisterSidePanelWebHost,
  wantsDefaultBrowser,
  type SidePanelWebHost,
  type WebSourceLink,
} from "../src/modules/contextPanel/webSourcesSidePanel";
import {
  describeAgentCoverage,
  splitAgentTextPassages,
} from "../src/modules/contextPanel/sourcePageView";
import {
  buildWebSourceMarkerFace,
  WEB_SOURCE_MARKER_MAX_ICONS,
} from "../src/modules/contextPanel/webSourceIndicators";

type Payload = Record<string, unknown>;
const event = (payload: Payload) => ({ payload }) as never;

function searchResult(n: number, extra: Payload = {}): Payload {
  return {
    sourceId: `web_${n}`,
    url: `https://site${n}.example.org/page`,
    hostname: `site${n}.example.org`,
    organization: `Site ${n}`,
    title: `Page ${n}`,
    snippet: `Snippet ${n}`,
    ...extra,
  };
}

describe("web sources in the side panel", function () {
  describe("the list's data", function () {
    const runEvents = [
      event({
        type: "tool_result",
        name: "web_search",
        ok: true,
        content: {
          results: [searchResult(1), searchResult(2), searchResult(3)],
        },
      }),
      event({
        type: "tool_result",
        name: "web_read",
        ok: true,
        content: {
          pages: [{ ...searchResult(2), content: "Full text of page 2." }],
        },
      }),
      event({
        type: "tool_result",
        name: "web_search",
        ok: false,
        content: { results: [searchResult(9)] },
      }),
      event({
        type: "final",
        text: "Answer",
        webSourceAnchors: [
          {
            offset: 3,
            sources: [
              {
                sourceId: "web_2",
                // Same page, other spelling: still one entry.
                url: "http://www.site2.example.org/page/?utm_source=x",
                hostname: "site2.example.org",
                organization: "Site 2",
                title: "Page 2",
              },
            ],
          },
        ],
      }),
    ];

    it("lists each page once, with read, cited and the agent's text", function () {
      const sources = collectRunWebSources(runEvents);
      assert.deepEqual(
        sources.map((source) => source.title),
        ["Page 1", "Page 2", "Page 3"],
      );
      const [one, two] = sources;
      assert.isFalse(one.read);
      assert.isFalse(one.cited);
      assert.equal(one.agentText, "Snippet 1");
      assert.isTrue(two.read);
      assert.isTrue(two.cited);
      assert.equal(two.agentText, "Full text of page 2.");
    });

    it("tells how much of a page the agent read, in page order", function () {
      const read = (pages: Payload[]) =>
        event({
          type: "tool_result",
          name: "web_read",
          ok: true,
          content: { pages },
        });
      const page = (extra: Payload) => ({ ...searchResult(1), ...extra });
      const outlineOnly = collectRunWebSources([
        read([
          page({
            readMode: "outline",
            totalChars: 100,
            outline: [
              { id: "s1", heading: "Guide", level: 1, chars: 100 },
              { id: "s2", heading: "Install", level: 2, chars: 40 },
            ],
          }),
        ]),
      ])[0];
      assert.equal(outlineOnly.coverage, "outline");
      assert.equal(outlineOnly.agentText, "Guide\n\n  Install");
      const runEvents = [
        read([
          page({
            readMode: "full",
            content: "Second half",
            totalChars: 100,
            range: { start: 50, end: 100 },
          }),
        ]),
        read([
          page({
            readMode: "sections",
            content: "Install part",
            totalChars: 100,
            range: { start: 20, end: 40 },
          }),
        ]),
      ];
      const parts = collectRunWebSources(runEvents)[0];
      assert.equal(parts.coverage, "parts");
      assert.equal(parts.agentText, "Install part\n\n[...]\n\nSecond half");
      const whole = collectRunWebSources([
        ...runEvents,
        read([
          page({
            readMode: "full",
            content: "First half",
            totalChars: 100,
            range: { start: 0, end: 50 },
          }),
        ]),
      ])[0];
      assert.equal(whole.coverage, "whole");
      assert.equal(whole.agentText, "First half\n\n[...]\n\nSecond half");
      assert.equal(
        collectRunWebSources([
          event({
            type: "tool_result",
            name: "web_search",
            ok: true,
            content: { results: [searchResult(1)] },
          }),
        ])[0].coverage,
        "snippet",
      );
    });

    it("drops private and non-web addresses", function () {
      const sources = collectRunWebSources([
        event({
          type: "tool_result",
          name: "web_search",
          ok: true,
          content: {
            results: [
              { ...searchResult(1), url: "http://127.0.0.1/admin" },
              { ...searchResult(2), url: "file:///etc/passwd" },
            ],
          },
        }),
      ]);
      assert.lengthOf(sources, 0);
    });
  });

  describe("where a click opens a page", function () {
    const globalWithZotero = globalThis as typeof globalThis & {
      Zotero?: unknown;
    };
    let previousZotero: unknown;
    let launched: string[];
    beforeEach(function () {
      previousZotero = globalWithZotero.Zotero;
      launched = [];
      globalWithZotero.Zotero = {
        isMac: true,
        launchURL: (url: string) => launched.push(url),
      };
    });
    afterEach(function () {
      globalWithZotero.Zotero = previousZotero;
    });

    it("opens the side panel when the window has one", function () {
      const doc = {} as Document;
      const opened: WebSourceLink[] = [];
      const host: SidePanelWebHost = {
        showSources: () => {},
        openPage: (link) => opened.push(link),
      };
      registerSidePanelWebHost(doc, host);
      try {
        assert.isTrue(
          openWebSourceLink(doc, { url: "https://example.org/a" }, null),
        );
        assert.deepEqual(opened, [{ url: "https://example.org/a" }]);
        assert.deepEqual(launched, []);
        // ⌘-click: the default browser.
        openWebSourceLink(
          doc,
          { url: "https://example.org/b" },
          { metaKey: true, ctrlKey: false },
        );
        assert.deepEqual(launched, ["https://example.org/b"]);
        assert.lengthOf(opened, 1);
      } finally {
        unregisterSidePanelWebHost(doc, host);
      }
    });

    it("opens the default browser without a side panel (Zotero sidebar)", function () {
      assert.isTrue(
        openWebSourceLink({} as Document, { url: "https://example.org/c" }),
      );
      assert.deepEqual(launched, ["https://example.org/c"]);
    });

    it("leaves local and non-web links to the caller", function () {
      assert.isFalse(
        openWebSourceLink({} as Document, { url: "zotero://select/items/1" }),
      );
      assert.isFalse(
        openWebSourceLink({} as Document, { url: "http://localhost:3000/" }),
      );
      assert.deepEqual(launched, []);
    });

    it("uses ⌘ on macOS and Ctrl elsewhere", function () {
      assert.isTrue(wantsDefaultBrowser({ metaKey: true, ctrlKey: false }));
      assert.isFalse(wantsDefaultBrowser({ metaKey: false, ctrlKey: true }));
      globalWithZotero.Zotero = { isMac: false };
      assert.isTrue(wantsDefaultBrowser({ metaKey: false, ctrlKey: true }));
      assert.isFalse(wantsDefaultBrowser({ metaKey: true, ctrlKey: false }));
    });
  });

  describe("the marker", function () {
    type Node = {
      className: string;
      textContent: string;
      children: Node[];
      style: Record<string, string>;
      appendChild: (child: Node) => Node;
      setAttribute: () => void;
      addEventListener: () => void;
      classList: { add: (c: string) => void; remove: (c: string) => void };
      [key: string]: unknown;
    };
    const fakeDoc = {
      createElement: (): Node => {
        const node: Node = {
          className: "",
          textContent: "",
          children: [],
          style: {},
          appendChild: (child) => {
            node.children.push(child);
            return child;
          },
          setAttribute: () => {},
          addEventListener: () => {},
          classList: {
            add: (c) => (node.className = `${node.className} ${c}`.trim()),
            remove: () => {},
          },
        };
        return node;
      },
    } as unknown as Document;
    const sources = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        faviconUrl: index === 1 ? undefined : `https://s${index}.example/i.ico`,
      }));

    it("shows up to three site icons and +N for the rest", function () {
      const face = buildWebSourceMarkerFace(
        fakeDoc,
        sources(5),
      ) as unknown as Node;
      const [icons, more] = face.children;
      assert.lengthOf(icons.children, WEB_SOURCE_MARKER_MAX_ICONS);
      assert.equal(more.textContent, "+2");
      // The first site sits on top; a site without an icon shows the globe.
      assert.equal(icons.children[0].style.zIndex, "3");
      assert.include(icons.children[0].className, "has-favicon");
      assert.notInclude(icons.children[1].className, "has-favicon");
    });

    it("shows no count for three sites or fewer", function () {
      const face = buildWebSourceMarkerFace(
        fakeDoc,
        sources(1),
      ) as unknown as Node;
      assert.lengthOf(face.children, 1);
      assert.lengthOf(face.children[0].children, 1);
    });
  });

  it("styles the flat Page | What the agent read tabs and the source page", function () {
    const css = readFileSync(
      join(process.cwd(), "addon/content/zoteroPane.css"),
      "utf8",
    );
    for (const selector of [
      ".llm-web-sources-mode.active",
      ".llm-web-source-chip.llm-web-source-chip-sites",
      ".llm-web-source-more",
      // The title row's buttons really hide when they have nothing to do.
      ".llm-standalone-side-panel-web [hidden]",
      ".llm-source-page-sub",
      ".llm-source-page-read-label",
    ]) {
      assert.include(css, selector);
    }
  });
  it("draws an old chat's markers once they load, without reopening it", function () {
    const chat = readFileSync(
      join(process.cwd(), "src/modules/contextPanel/chat.ts"),
      "utf8",
    );
    // A full render reads every run's markers ahead, in one small read.
    assert.match(chat, /preloadWebSourceAnchors\(body, item, history\);/);
    assert.include(chat, 'listAgentRunEventsForRuns(runIds, ["final"])');
    // An in-place refresh redraws the answer when its markers changed,
    // even when its text did not.
    assert.include(chat, "anchorsKey !== view.webSourceAnchorsKey");
    assert.include(chat, "view.webSourceAnchorsKey = anchorsKey;");
  });

  it("lines the marker up with the text and keeps its hover plain", function () {
    const css = readFileSync(
      join(process.cwd(), "addon/content/zoteroPane.css"),
      "utf8",
    );
    const start = css.indexOf("/* Web markers: the first sites'");
    const block = css.slice(
      start,
      css.indexOf("/* The source card's last line"),
    );
    assert.isAbove(start, 0);
    assert.include(block, "vertical-align: middle;");
    assert.notInclude(block, "--color-accent");
  });

  it("shows the agent's text as the passages it got", function () {
    assert.deepEqual(
      splitAgentTextPassages("First part. [...] Second   part [...] \n\nThird"),
      ["First part.", "Second part", "Third"],
    );
  });
});
