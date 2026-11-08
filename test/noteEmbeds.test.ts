import { assert } from "chai";
import { createNoteWriteTool } from "../src/agent/tools/write/noteWrite";
import { buildAgentInitialMessages } from "../src/agent/model/messageBuilder";
import {
  noteHtmlToModelText,
  renderRawNoteHtml,
} from "../src/services/notes/noteRendering";
import {
  collectNoteEmbeds,
  findMissingNoteEmbeds,
  formatNoteEmbedToken,
} from "../src/utils/noteEmbeds";
import { replaceTextContentInHtml } from "../src/utils/noteEdit";
import { stripNoteHtml } from "../src/utils/noteText";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

/** A citation chip as Zotero's note editor stores it: page 42 of ITEM1. */
const CITATION =
  '<span class="citation" data-citation="%7B%22citationItems%22%3A%5B%7B%22uris%22%3A%5B%22http%3A%2F%2Fzotero.org%2Fusers%2Flocal%2Fabc%2Fitems%2FITEM1%22%5D%2C%22locator%22%3A%2242%22%2C%22label%22%3A%22page%22%7D%5D%2C%22properties%22%3A%7B%7D%7D">(<span class="citation-item">Devalle and Roxin, 2022, p. 42</span>)</span>';
/** A highlight dragged in from the PDF, linked to its annotation. */
const HIGHLIGHT =
  '<span class="highlight" data-annotation="%7B%22attachmentURI%22%3A%22http%3A%2F%2Fzotero.org%2Fusers%2Flocal%2Fabc%2Fitems%2FPDF1%22%2C%22annotationKey%22%3A%22ANN1%22%7D">“synaptic turnover in two inputs”</span>';
const IMAGE = '<img data-attachment-key="IMG1" width="400" height="300">';
const ROOT =
  '<div data-schema-version="9" data-citation-items="%5B%7B%22uris%22%3A%5B%22http%3A%2F%2Fzotero.org%2Fusers%2Flocal%2Fabc%2Fitems%2FITEM1%22%5D%7D%5D">';

/** A citation of the work with this item key, shown as "(Smith, 2020)", so
 * two different works can show the same label. */
function smithChip(key: string): string {
  const data = encodeURIComponent(
    JSON.stringify({
      citationItems: [
        { uris: [`http://zotero.org/users/local/abc/items/${key}`] },
      ],
      properties: {},
    }),
  );
  return `<span class="citation" data-citation="${data}">(<span class="citation-item">Smith, 2020</span>)</span>`;
}
/** Two works that both show "(Smith, 2020)": one per paragraph. */
const TWO_SMITHS = `${ROOT}<p>Intro cites ${smithChip("AAAA1111")} here.</p><p>Later claim ${smithChip("BBBB2222")} matters.</p></div>`;

const NOTE =
  `${ROOT}<h1>Study note</h1>` +
  `<p>Drift is driven by turnover ${CITATION}.</p>` +
  `<p>${HIGHLIGHT} is the key claim.</p>` +
  `<p>${IMAGE}</p>` +
  "</div>";

function tokens(html = NOTE) {
  const [citation, highlight, image] = collectNoteEmbeds(html);
  return {
    citation: formatNoteEmbedToken(citation),
    highlight: formatNoteEmbedToken(highlight),
    image: formatNoteEmbedToken(image),
    ids: {
      citation: citation.id,
      highlight: highlight.id,
      image: image.id,
    },
  };
}

function edit(args: Record<string, unknown>, html = NOTE) {
  const tool = createNoteWriteTool({
    getActiveNoteSnapshot: () => ({
      noteId: 70,
      title: "Study note",
      html,
      text: noteHtmlToModelText(html),
      libraryID: 1,
      noteKind: "item",
    }),
  } as never);
  const validated = tool.validate({ mode: "edit", targetNoteId: 70, ...args });
  if (!validated.ok) throw new Error(JSON.stringify(validated));
  const context = {
    request: resolvedAgentRequest({
      conversationKey: 70,
      mode: "agent",
      userText: "edit the note",
      libraryID: 1,
    }),
    item: null,
    currentAnswerText: "",
    modelName: "test",
  } as never;
  const pending = tool.createPendingAction!(validated.value, context) as {
    description: string;
    fields: Array<{ type: string; before?: string; after?: string }>;
  };
  return { tool, input: validated.value, pending };
}

/** The exact HTML the edit would save. */
function saved(args: Record<string, unknown>, html = NOTE): string {
  return edit(args, html).input._patchedHtml!;
}

describe("embedded note items as placeholders", function () {
  it("shows each citation, highlight and image to the model as a placeholder", function () {
    const text = noteHtmlToModelText(NOTE);
    const t = tokens();
    assert.match(
      t.citation,
      /^\{\{citation:[0-9a-f]{6} \(Devalle and Roxin, 2022, p\. 42\)\}\}$/,
    );
    assert.match(
      t.highlight,
      /^\{\{highlight:[0-9a-f]{6} “synaptic turnover in two inputs”\}\}$/,
    );
    assert.match(t.image, /^\{\{image:[0-9a-f]{6}\}\}$/);
    assert.include(text, `Drift is driven by turnover ${t.citation}.`);
    assert.include(text, `${t.highlight} is the key claim.`);
    assert.include(text, t.image);
    assert.notInclude(text, "data-citation");
  });

  it("names an item by its content, so its id survives edits around it", function () {
    const moved = `<p>New first paragraph.</p><p>Later: ${CITATION}</p>`;
    assert.equal(collectNoteEmbeds(moved)[0].id, tokens().ids.citation);
  });

  it("puts every item back, exactly, when the model rewrites the whole note", function () {
    const t = tokens();
    const html = saved({
      content: `# Study note\n\nTurnover drives drift ${t.citation}.\n\n${t.highlight} matters most.\n\n${t.image}`,
    });
    assert.include(html, CITATION);
    assert.include(html, HIGHLIGHT);
    assert.include(html, IMAGE);
    assert.include(html, "Turnover drives drift");
    assert.isTrue(html.startsWith(ROOT), "the citation registry is kept");
    assert.lengthOf(findMissingNoteEmbeds(NOTE, html), 0);
  });

  it("accepts a placeholder without its label", function () {
    const t = tokens();
    const html = saved({
      content: `Short {{citation:${t.ids.citation}}} {{highlight:${t.ids.highlight}}} {{image:${t.ids.image}}}`,
    });
    assert.include(html, CITATION);
    assert.include(html, HIGHLIGHT);
    assert.include(html, IMAGE);
  });

  it("ignores a changed label and restores the original item", function () {
    const t = tokens();
    const html = saved({
      content: `A {{citation:${t.ids.citation} (Someone else, 1999, p. 1)}} ${t.highlight} ${t.image}`,
    });
    assert.include(html, CITATION);
    assert.notInclude(html, "Someone else");
  });

  it("moves an item when the model moves its placeholder", function () {
    const t = tokens();
    const html = saved({
      content: `${t.image}\n\n${t.highlight} first, then ${t.citation}.`,
    });
    assert.isBelow(html.indexOf(IMAGE), html.indexOf(HIGHLIGHT));
    assert.isBelow(html.indexOf(HIGHLIGHT), html.indexOf(CITATION));
  });

  it("refuses a rewrite that drops an item, and says which one", function () {
    const t = tokens();
    assert.throws(
      () =>
        edit({
          content: `# Study note\n\nTurnover drives drift.\n\n${t.highlight}\n\n${t.image}`,
        }),
      new RegExp(
        `would delete 1 embedded item from the note: \\{\\{citation:${t.ids.citation} `,
      ),
    );
  });

  it("keeps the real citation when a rewrite retypes its label as plain text", function () {
    const t = tokens();
    const { input } = edit({
      content: `Turnover (Devalle and Roxin, 2022, p. 42). ${t.highlight} ${t.image}`,
    });
    const html = input._patchedHtml!;
    assert.include(html, `Turnover ${CITATION}.`);
    assert.equal(stripNoteHtml(html).split("Devalle and Roxin").length - 1, 1);
    assert.include(input.content, `Turnover {{citation:${t.ids.citation}}}.`);
  });

  it("adopts a retyped label for every copy of the same item", function () {
    const twice = `${ROOT}<p>A ${CITATION}.</p><p>B ${CITATION}.</p></div>`;
    const html = saved(
      {
        content:
          "A (Devalle and Roxin, 2022, p. 42).\n\nB (Devalle and Roxin, 2022, p. 42).",
      },
      twice,
    );
    assert.equal(html.split('class="citation"').length - 1, 2);
    assert.include(html, `A ${CITATION}.`);
    assert.include(html, `B ${CITATION}.`);
  });

  it("refuses a rewrite that retypes a label two different works show, naming both", function () {
    const html = TWO_SMITHS;
    const [first, second] = collectNoteEmbeds(html);
    assert.notEqual(first.id, second.id);
    assert.throws(
      () =>
        edit(
          {
            content:
              "Intro cites (Smith, 2020) here.\n\nLater claim (Smith, 2020) matters.",
          },
          html,
        ),
      new RegExp(
        `would delete 2 embedded items[\\s\\S]*"\\(Smith, 2020\\)" is shown by several items: \\{\\{citation:${first.id}\\}\\}, \\{\\{citation:${second.id}\\}\\}`,
      ),
    );
  });

  it("still refuses a rewrite that drops an item without retyping it", function () {
    const t = tokens();
    assert.throws(
      () => edit({ content: `Turnover. ${t.highlight} ${t.image}` }),
      /would delete 1 embedded item/,
    );
  });

  it("removes an item only when it is listed in removeEmbeds", function () {
    const t = tokens();
    const { input, pending } = edit({
      content: `Turnover drives drift.\n\n${t.highlight}\n\n${t.image}`,
      removeEmbeds: [t.ids.citation],
    });
    assert.notInclude(input._patchedHtml, "data-citation=");
    assert.include(input._patchedHtml, HIGHLIGHT);
    assert.include(
      pending.description,
      `deletes 1 embedded item: {{citation:${t.ids.citation}`,
    );
  });

  it("keeps a listed item whose placeholder the model left in", function () {
    const t = tokens();
    const { input, pending } = edit({
      content: noteHtmlToModelText(NOTE),
      removeEmbeds: [`{{image:${t.ids.image}}}`],
    });
    assert.include(input._patchedHtml, IMAGE);
    assert.include(input._patchedHtml, CITATION);
    assert.notInclude(pending.description, "deletes");
  });

  it("removes only the copies whose placeholders the model omitted", function () {
    const twice = `${ROOT}<p>First claim ${CITATION}.</p><p>Second claim ${CITATION}.</p></div>`;
    const id = collectNoteEmbeds(twice)[0].id;
    const { input, pending } = edit(
      {
        content: `First claim {{citation:${id}}}.\n\nSecond claim.`,
        removeEmbeds: [id],
      },
      twice,
    );
    const html = input._patchedHtml!;
    assert.equal(html.split('class="citation"').length - 1, 1);
    assert.include(html, `First claim ${CITATION}.`);
    assert.include(html, "<p>Second claim.</p>");
    assert.lengthOf(findMissingNoteEmbeds(twice, html), 1);
    assert.include(
      pending.description,
      `deletes 1 embedded item: {{citation:${id}`,
    );
  });

  it("counts every removed copy of an item in the review", function () {
    const twice = `${ROOT}<p>First claim ${CITATION}.</p><p>Second claim ${CITATION}.</p></div>`;
    const id = collectNoteEmbeds(twice)[0].id;
    const { input, pending } = edit(
      { content: "First claim.\n\nSecond claim.", removeEmbeds: [id] },
      twice,
    );
    assert.notInclude(input._patchedHtml, "data-citation=");
    assert.include(pending.description, "deletes 2 embedded items");
  });

  it("refuses removeEmbeds ids the note does not have, and outside edit mode", function () {
    assert.throws(
      () =>
        edit({
          content: noteHtmlToModelText(NOTE),
          removeEmbeds: ["abcdef"],
        }),
      /removeEmbeds names abcdef/,
    );
    const tool = createNoteWriteTool({} as never);
    assert.isFalse(
      tool.validate({ mode: "create", content: "x", removeEmbeds: ["abcdef"] })
        .ok,
    );
  });

  it("refuses a placeholder the note does not have", function () {
    assert.throws(
      () =>
        edit({
          content: `${noteHtmlToModelText(NOTE)}\n\n{{citation:abcdef (Invented, 2020)}}`,
        }),
      /no embedded item \{\{citation:abcdef/,
    );
  });

  it("keeps both copies of an item that appears twice, and refuses losing one", function () {
    const twice = `${ROOT}<p>A ${CITATION}.</p><p>B ${CITATION}.</p></div>`;
    const id = collectNoteEmbeds(twice)[0].id;
    const both = saved(
      { content: `A {{citation:${id}}}. B {{citation:${id}}}.` },
      twice,
    );
    assert.equal(both.split('class="citation"').length - 1, 2);
    assert.throws(
      () => edit({ content: `A and B {{citation:${id}}}.` }, twice),
      /would delete 1 embedded item/,
    );
  });

  it("restores items in a raw HTML rewrite", function () {
    const t = tokens();
    const html = saved({
      content: `<h1>Study note</h1><p>Turnover ${t.citation}.</p><p>${t.highlight}</p><p>${t.image}</p>`,
    });
    assert.include(html, CITATION);
    assert.include(html, HIGHLIGHT);
    assert.include(html, IMAGE);
  });

  it("restores items from the review box when the user edits the text", function () {
    const t = tokens();
    const { tool, input } = edit({ content: noteHtmlToModelText(NOTE) });
    const confirmed = tool.applyConfirmation!(input, {
      content: `User wording ${t.citation} ${t.highlight} ${t.image}`,
    });
    assert.isTrue(confirmed.ok);
    if (!confirmed.ok) return;
    assert.isUndefined(confirmed.value._patchedHtml);
    assert.include(confirmed.value.content, t.citation);
  });

  it("shows placeholders on both sides of the review diff", function () {
    const t = tokens();
    const { pending } = edit({
      content: noteHtmlToModelText(NOTE).replace(
        "Drift",
        "Representational drift",
      ),
    });
    const diff = pending.fields.find((field) => field.type === "diff_preview");
    assert.include(diff?.before, t.citation);
    assert.include(diff?.after, t.citation);
  });

  it("turns placeholders into their labels in a new note, which has no items", function () {
    const t = tokens();
    const tool = createNoteWriteTool({} as never);
    const validated = tool.validate({
      mode: "create",
      content: `Copied: ${t.citation}`,
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const prepared = validated.value;
    tool.createPendingAction!(prepared, {
      request: resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        userText: "x",
        libraryID: 1,
      }),
      item: null,
      currentAnswerText: "",
      modelName: "test",
    } as never);
    assert.equal(prepared.content, "Copied: (Devalle and Roxin, 2022, p. 42)");
  });
});

describe("text edits never hollow out an embedded item", function () {
  it("keeps a citation whole when a patch's find runs through its text", function () {
    const t = tokens();
    const html = saved({
      patches: [
        {
          find: "Drift is driven by turnover (Devalle and Roxin, 2022, p. 42).",
          replace: "Drift follows turnover.",
        },
      ],
    });
    assert.include(html, CITATION);
    assert.include(html, "Drift follows turnover.");
    assert.notInclude(html, "Drift is driven");
    assert.lengthOf(findMissingNoteEmbeds(NOTE, html), 0);
    assert.include(noteHtmlToModelText(html), t.citation);
  });

  it("reads a placeholder in a patch's find as the item's text", function () {
    const t = tokens();
    const html = saved({
      patches: [
        {
          find: `turnover ${t.citation}.`,
          replace: "synaptic turnover.",
        },
      ],
    });
    assert.include(html, CITATION);
    assert.include(html, "synaptic turnover.");
  });

  it("moves an item a patch's replace carries, without doubling it", function () {
    const t = tokens();
    const html = saved({
      patches: [
        {
          find: `Drift is driven by turnover ${t.citation}.`,
          replace: `As shown ${t.citation}, turnover drives drift.`,
        },
      ],
    });
    assert.equal(html.split('class="citation"').length - 1, 1);
    assert.include(html, "As shown ");
    assert.isBelow(html.indexOf("As shown"), html.indexOf(CITATION));
    assert.isBelow(html.indexOf(CITATION), html.indexOf(", turnover drives"));
  });

  it("uses the real citation, once, when a patch retypes its label", function () {
    const html = saved({
      patches: [
        {
          find: "Drift is driven by turnover (Devalle and Roxin, 2022, p. 42).",
          replace: "Turnover drives drift (Devalle and Roxin, 2022, p. 42).",
        },
      ],
    });
    assert.include(html, `Turnover drives drift ${CITATION}.`);
    assert.equal(stripNoteHtml(html).split("Devalle and Roxin").length - 1, 1);
  });

  it("uses the citation inside the patched passage when another work shows the same label", function () {
    const html = saved(
      {
        patches: [
          {
            find: "Later claim (Smith, 2020) matters.",
            replace: "A later, reworded claim (Smith, 2020) matters.",
          },
        ],
      },
      TWO_SMITHS,
    );
    assert.include(
      html,
      `<p>Intro cites ${smithChip("AAAA1111")} here.</p><p>A later, reworded claim ${smithChip("BBBB2222")} matters.</p>`,
    );
    assert.equal(html.split("AAAA1111").length - 1, 1);
    assert.equal(html.split("BBBB2222").length - 1, 1);
  });

  it("deletes a citation a patch omits when its id is listed in removeEmbeds", function () {
    const id = tokens().ids.citation;
    const { input, pending } = edit({
      patches: [
        {
          find: `Drift is driven by turnover {{citation:${id}}}.`,
          replace: "Drift is driven by turnover.",
        },
      ],
      removeEmbeds: [id],
    });
    const html = input._patchedHtml!;
    assert.notInclude(html, "data-citation=");
    assert.include(html, "Drift is driven by turnover.");
    assert.include(html, HIGHLIGHT);
    assert.include(pending.description, "deletes 1 embedded item");
  });

  it("deletes a citation when the patch's only effect is removing it", function () {
    const id = tokens().ids.citation;
    const html = saved({
      patches: [{ find: "(Devalle and Roxin, 2022, p. 42)", replace: "" }],
      removeEmbeds: [id],
    });
    assert.notInclude(html, "data-citation=");
    assert.include(html, "<p>Drift is driven by turnover .</p>");
  });

  it("keeps a listed citation when the patch's replace keeps its placeholder", function () {
    const t = tokens();
    const { input, pending } = edit({
      patches: [
        {
          find: `turnover ${t.citation}.`,
          replace: `turnover {{citation:${t.ids.citation}}}, as shown.`,
        },
      ],
      removeEmbeds: [t.ids.citation],
    });
    assert.include(input._patchedHtml, CITATION);
    assert.include(input._patchedHtml, "as shown.");
    assert.notInclude(pending.description, "deletes");
  });

  it("still keeps or refuses a touched citation that is not listed", function () {
    const t = tokens();
    // Another item is listed; the touched citation is not, so it stays.
    const html = saved({
      patches: [
        {
          find: "Drift is driven by turnover (Devalle and Roxin, 2022, p. 42).",
          replace: "Drift follows turnover.",
        },
      ],
      removeEmbeds: [t.ids.image],
    });
    assert.include(html, CITATION);
    assert.include(html, "Drift follows turnover.");
    // Nothing but the citation is matched and it is not listed: refused.
    assert.throws(
      () =>
        edit({
          patches: [{ find: "(Devalle and Roxin, 2022, p. 42)", replace: "" }],
          removeEmbeds: [t.ids.image],
        }),
      /belongs to an embedded citation/,
    );
  });

  it("does not re-adopt a listed item's label retyped as plain text", function () {
    const id = tokens().ids.citation;
    const html = saved({
      patches: [
        {
          find: `turnover {{citation:${id}}}.`,
          replace: "turnover (Devalle and Roxin, 2022, p. 42).",
        },
      ],
      removeEmbeds: [id],
    });
    assert.notInclude(html, "data-citation=");
    assert.include(html, "turnover (Devalle and Roxin, 2022, p. 42).");
  });

  it("refuses a patch that edits text inside a citation", function () {
    assert.throws(
      () => replaceTextContentInHtml(NOTE, "2022, p. 42", "2022, p. 43"),
      /belongs to an embedded citation/,
    );
  });

  it("says which patch was not found", function () {
    assert.throws(
      () =>
        edit({
          patches: [
            { find: "Study note", replace: "Reading note" },
            { find: "not in the note", replace: "x" },
          ],
        }),
      /not found \(patch 2 of 2\): "not in the note"/,
    );
  });
});

describe("selection rewrites with embedded items", function () {
  function selectionEdit(
    replacement: string,
    selected: string,
    html = NOTE,
    removeEmbeds?: string[],
  ) {
    const tool = createNoteWriteTool({
      getActiveNoteSnapshot: () => ({
        noteId: 71,
        libraryID: 1,
        title: "Study note",
        html,
        text: noteHtmlToModelText(html),
        noteKind: "standalone",
      }),
    } as never);
    const request = resolvedAgentRequest({
      conversationKey: 71,
      libraryID: 1,
      mode: "agent",
      userText: "rewrite this sentence",
      activeItemId: 71,
      activeNoteContext: {
        noteId: 71,
        title: "Study note",
        noteKind: "standalone",
        noteText: noteHtmlToModelText(html),
      },
      selectedTexts: [selected],
      selectedTextSources: ["note-edit"],
      selectedTextNoteContexts: [
        {
          noteItemId: 71,
          noteItemKey: "NOTE71",
          libraryID: 1,
          noteKind: "standalone",
          title: "Study note",
        },
      ],
    });
    const context = {
      request,
      runId: "selection-embeds",
      item: null,
      modelName: "test",
      currentAnswerText: "",
    } as never;
    const input = tool.validate({
      mode: "edit",
      selection: { index: 1, replacement },
      ...(removeEmbeds ? { removeEmbeds } : {}),
    });
    if (!input.ok) throw new Error("invalid");
    const pending = tool.createPendingAction!(input.value, context) as {
      description: string;
    };
    return { html: input.value._patchedHtml!, request, pending };
  }
  const SENTENCE =
    "Drift is driven by turnover (Devalle and Roxin, 2022, p. 42).";

  it("moves a selected citation to where the replacement puts it", function () {
    const t = tokens();
    const { html } = selectionEdit(
      `Per ${t.citation}, turnover drives drift.`,
      SENTENCE,
    );
    assert.equal(html.split('class="citation"').length - 1, 1);
    assert.isBelow(html.indexOf("Per "), html.indexOf(CITATION));
    assert.isBelow(html.indexOf(CITATION), html.indexOf("turnover drives"));
  });

  it("keeps a selected citation whose placeholder the replacement leaves out", function () {
    const { html } = selectionEdit("Turnover drives drift.", SENTENCE);
    assert.include(html, CITATION);
    assert.include(html, "Turnover drives drift.");
  });

  it("uses the real citation, once, when the replacement retypes its label", function () {
    const { html } = selectionEdit(
      "Turnover drives drift (Devalle and Roxin, 2022, p. 42).",
      SENTENCE,
    );
    assert.include(html, `Turnover drives drift ${CITATION}.`);
    assert.equal(stripNoteHtml(html).split("Devalle and Roxin").length - 1, 1);
  });

  it("uses the selected citation when another work in the note shows the same label", function () {
    const { html } = selectionEdit(
      "A later, reworded claim (Smith, 2020) matters.",
      "Later claim (Smith, 2020) matters.",
      TWO_SMITHS,
    );
    assert.include(
      html,
      `<p>Intro cites ${smithChip("AAAA1111")} here.</p><p>A later, reworded claim ${smithChip("BBBB2222")} matters.</p>`,
    );
    assert.equal(html.split("AAAA1111").length - 1, 1);
    assert.equal(html.split("BBBB2222").length - 1, 1);
  });

  it("deletes a selected citation the user asked to remove, when the replacement omits it", function () {
    const id = tokens().ids.citation;
    const { html, pending } = selectionEdit(
      "Turnover drives drift.",
      SENTENCE,
      NOTE,
      [id],
    );
    assert.notInclude(html, "data-citation=");
    assert.include(html, "Turnover drives drift.");
    assert.include(pending.description, "deletes 1 embedded item");
  });

  it("keeps a selected citation that is listed when the replacement keeps its placeholder", function () {
    const t = tokens();
    const { html, pending } = selectionEdit(
      `Per ${t.citation}, turnover drives drift.`,
      SENTENCE,
      NOTE,
      [t.ids.citation],
    );
    assert.include(html, CITATION);
    assert.notInclude(pending.description, "deletes");
  });

  it("tells the model which placeholders a selected passage contains", async function () {
    const t = tokens();
    const { request } = selectionEdit("Turnover drives drift.", SENTENCE);
    const text = JSON.stringify(
      await buildAgentInitialMessages({ ...request }, [], []),
    );
    assert.include(text, "This selection contains embedded note items");
    assert.include(text, JSON.stringify(t.citation).slice(1, -1));
    assert.include(text, "Embedded note items:");
  });
});

describe("equations in a rewritten note", function () {
  it("reads a display equation back as Markdown math, so it stays an equation", function () {
    const html = '<pre class="math">$$E = mc^2$$</pre><p>Text.</p>';
    const text = noteHtmlToModelText(html);
    assert.include(text, "$$E = mc^2$$");
    assert.notInclude(text, "```");
    assert.include(
      renderRawNoteHtml(text),
      '<pre class="math">$$E = mc^2$$</pre>',
    );
  });
});
