import { assert } from "chai";
import {
  buildPaperQuoteCitationGuidance,
  formatOpenChatTextContextLabel,
  formatPaperCitationLabel,
  formatPaperSourceLabel,
  resolvePaperContextDisplayRef,
} from "../src/modules/contextPanel/paperAttribution";
import type { PaperContextRef } from "../src/modules/contextPanel/types";

const globalScope = globalThis as typeof globalThis & { Zotero?: any };

function makeZoteroItem(params: {
  id: number;
  kind: "regular" | "attachment";
  fields?: Record<string, unknown>;
  parentID?: number;
  attachmentFilename?: string;
}): Zotero.Item {
  return {
    id: params.id,
    parentID: params.parentID,
    attachmentFilename: params.attachmentFilename,
    isRegularItem: () => params.kind === "regular",
    isAttachment: () => params.kind === "attachment",
    getField: (field: string) => params.fields?.[field] || "",
  } as unknown as Zotero.Item;
}

function installZoteroItems(
  items: Record<number, Zotero.Item | undefined>,
): void {
  globalScope.Zotero = {
    Items: {
      get: (itemId: number) => items[itemId] || null,
    },
  };
}

describe("paperAttribution", function () {
  const originalZotero = globalScope.Zotero;

  afterEach(function () {
    if (originalZotero === undefined) {
      delete globalScope.Zotero;
    } else {
      globalScope.Zotero = originalZotero;
    }
  });

  it("formats author-year citation labels using Zotero Creator field directly", function () {
    const label = formatPaperCitationLabel({
      itemId: 1,
      contextItemId: 2,
      title: "Paper",
      firstCreator: "Smith et al.",
      year: "2021",
    });
    assert.equal(label, "Smith et al., 2021");
  });

  it("keeps citationKey internal and user label readable", function () {
    const label = formatPaperCitationLabel({
      itemId: 1,
      contextItemId: 2,
      title: "Paper",
      firstCreator: "Smith et al.",
      year: "2021",
      citationKey: "smith2021alpha",
    });
    assert.equal(label, "Smith et al., 2021");
  });

  it("formats parenthetical source labels and quote guidance", function () {
    const paper = {
      itemId: 1,
      contextItemId: 2,
      title: "Paper",
      firstCreator: "Smith et al.",
      year: "2021",
    };
    assert.equal(formatPaperSourceLabel(paper), "(Smith et al., 2021)");
    assert.include(
      buildPaperQuoteCitationGuidance(paper).join("\n"),
      "(Smith et al., 2021)",
    );
    assert.include(
      buildPaperQuoteCitationGuidance(paper).join("\n"),
      "include short direct-source blockquotes",
    );
    assert.include(
      buildPaperQuoteCitationGuidance(paper).join("\n"),
      "Use `>` only for text copied from the paper",
    );
    assert.include(
      buildPaperQuoteCitationGuidance(paper).join("\n"),
      "next non-empty line after the blockquote, before any commentary",
    );
    assert.include(
      buildPaperQuoteCitationGuidance(paper).join("\n"),
      "If verified quote anchors are provided, use the exact [[quote:<id>]] token",
    );
    assert.include(
      buildPaperQuoteCitationGuidance(paper).join("\n"),
      "Copy the Source label string exactly",
    );
    assert.include(
      buildPaperQuoteCitationGuidance(paper).join("\n"),
      "Do not invent author/year/page/section labels",
    );
    assert.include(
      buildPaperQuoteCitationGuidance(paper).join("\n"),
      "Do not write [[source=...]], section=..., or chunk=...",
    );
  });

  it("formats child attachment source labels and quote guidance", function () {
    const attachmentContext = {
      itemId: 1,
      contextItemId: 2,
      title: "Parent Paper",
      attachmentTitle: "test.md",
      firstCreator: "Chandra et al.",
      year: "2025",
      contentSourceMode: "markdown" as const,
    };

    assert.equal(
      formatPaperSourceLabel(attachmentContext),
      "(test.md, attachment under Chandra et al., 2025)",
    );
    const guidance =
      buildPaperQuoteCitationGuidance(attachmentContext).join("\n");
    assert.include(guidance, "quoting this selected attachment");
    assert.include(
      guidance,
      "Use `>` only for text copied from the selected attachment",
    );
    assert.include(
      guidance,
      "> quoted text copied from the selected attachment",
    );
    assert.include(
      guidance,
      "(test.md, attachment under Chandra et al., 2025)",
    );
  });

  it("keeps generic quote guidance citation-adjacent", function () {
    const guidance = buildPaperQuoteCitationGuidance().join("\n");

    assert.include(
      guidance,
      "> quoted text copied from the paper\n\nthe exact sourceLabel shown for the relevant paper",
    );
    assert.include(
      guidance,
      "next non-empty line after the blockquote, before any commentary",
    );
  });

  it("falls back deterministically when metadata is missing", function () {
    const label = formatOpenChatTextContextLabel({
      itemId: 42,
      contextItemId: 99,
      title: "Untitled",
    });
    assert.equal(label, "Paper 42 - Text Context");
  });

  it("resolves paper context display metadata from live Zotero items", function () {
    installZoteroItems({
      1: makeZoteroItem({
        id: 1,
        kind: "regular",
        fields: {
          title: "Updated paper title",
          firstCreator: "Updated et al.",
          year: "2026",
          citationKey: "updated2026",
        },
      }),
      2: makeZoteroItem({
        id: 2,
        kind: "attachment",
        parentID: 1,
        fields: { title: "Updated PDF title" },
        attachmentFilename: "updated.pdf",
      }),
    });
    const stored: PaperContextRef = {
      itemId: 1,
      contextItemId: 2,
      title: "Stale paper title",
      attachmentTitle: "stale.pdf",
      citationKey: "stale1999",
      firstCreator: "Stale et al.",
      year: "1999",
    };

    const resolved = resolvePaperContextDisplayRef(stored);

    assert.notStrictEqual(resolved, stored);
    assert.equal(stored.title, "Stale paper title");
    assert.equal(resolved.title, "Updated paper title");
    assert.equal(resolved.attachmentTitle, "Updated PDF title");
    assert.equal(resolved.citationKey, "updated2026");
    assert.equal(resolved.firstCreator, "Updated et al.");
    assert.equal(resolved.year, "2026");
  });

  it("falls back to the stored paper context when live items are missing", function () {
    installZoteroItems({
      1: makeZoteroItem({
        id: 1,
        kind: "regular",
        fields: { title: "Updated paper title" },
      }),
    });
    const stored: PaperContextRef = {
      itemId: 1,
      contextItemId: 2,
      title: "Stored paper title",
      attachmentTitle: "stored.pdf",
      citationKey: "stored2024",
      firstCreator: "Stored et al.",
      year: "2024",
    };

    const resolved = resolvePaperContextDisplayRef(stored);

    assert.notStrictEqual(resolved, stored);
    assert.deepEqual(resolved, stored);
  });

  it("preserves paper context identity and semantic fields while refreshing display fields", function () {
    installZoteroItems({
      11: makeZoteroItem({
        id: 11,
        kind: "regular",
        fields: {
          title: "Live title",
          firstCreator: "Live et al.",
          date: "2027-04-01",
        },
      }),
      12: makeZoteroItem({
        id: 12,
        kind: "attachment",
        parentID: 11,
        fields: {},
        attachmentFilename: "live.pdf",
      }),
    });
    const stored: PaperContextRef = {
      itemId: 11,
      contextItemId: 12,
      contentSourceMode: "mineru",
      mineruCacheDir: "/tmp/mineru-cache",
      title: "Stored title",
      attachmentTitle: "stored.pdf",
      firstCreator: "Stored et al.",
      year: "2020",
    };

    const resolved = resolvePaperContextDisplayRef(stored);

    assert.equal(resolved.itemId, 11);
    assert.equal(resolved.contextItemId, 12);
    assert.equal(resolved.contentSourceMode, "mineru");
    assert.equal(resolved.mineruCacheDir, "/tmp/mineru-cache");
    assert.equal(resolved.title, "Live title");
    assert.equal(resolved.attachmentTitle, "live.pdf");
    assert.equal(resolved.firstCreator, "Live et al.");
    assert.equal(resolved.year, "2027");
  });
});
