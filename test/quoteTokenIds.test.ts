import { assert } from "chai";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  QUOTE_ID_CHARSET,
  isQuoteTokenId,
  normalizeQuoteTokenId,
  quoteTokenPattern,
} from "../src/services/quotes/quoteTokenIds";
import {
  buildQuoteCitation,
  buildQuoteCitationId,
  QUOTE_CITATION_PATTERN,
} from "../src/services/quotes/quoteCitations";
import { QUOTE_TOKEN_PATTERN } from "../src/services/quotes/claimAnchoring";
import {
  buildQuoteRenderPlan,
  QUOTE_RENDER_OCCURRENCE_PATTERN,
} from "../src/modules/contextPanel/quoteRenderPlan";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "..", "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

function captured(pattern: RegExp, text: string): string[] {
  return Array.from(
    text.matchAll(new RegExp(pattern.source, "g")),
    (match) => match[1],
  );
}

describe("quote token ids", function () {
  const quoteText =
    "Population codes rotate while the decoder stays aligned with behaviour across weeks.";

  it("is one rule: letters, digits and . _ : -", function () {
    assert.equal(QUOTE_ID_CHARSET, "A-Za-z0-9._:-");
    for (const id of ["Q_0i3e1kt", "QO_0", "Q1.a", "p:1", "cite-Q1.a", "a-b"])
      assert.isTrue(isQuoteTokenId(id), id);
    for (const id of ["", "a b", "a]", "a/b", "é", "a\nb"])
      assert.isFalse(isQuoteTokenId(id), JSON.stringify(id));
    assert.equal(normalizeQuoteTokenId(" Q 1.a:/2 "), "Q1.a:2");
  });

  it("builds token patterns that capture the whole id", function () {
    const text = "[[quote:x.y]] [[quote:p:1]] [[quote:Q_ab]] [[quote:a b]]";
    assert.deepEqual(captured(quoteTokenPattern("quote"), text), [
      "x.y",
      "p:1",
      "Q_ab",
    ]);
    assert.deepEqual(
      captured(quoteTokenPattern("cite"), "[[cite:c.1]] [[cite:x y]]"),
      ["c.1"],
    );
    assert.equal(quoteTokenPattern("quote").flags, "g");
  });

  it("is the rule every quote token pattern uses", function () {
    const text = "[[quote:x.y]] [[quote:p:1]] [[quote:Q_ab-1]]";
    const expected = ["x.y", "p:1", "Q_ab-1"];
    assert.deepEqual(captured(QUOTE_CITATION_PATTERN, text), expected);
    assert.deepEqual(captured(QUOTE_TOKEN_PATTERN, text), expected);
    assert.deepEqual(
      captured(
        QUOTE_RENDER_OCCURRENCE_PATTERN,
        "[[quote-occurrence:QO_0]] [[quote-occurrence:QO.1:a]]",
      ),
      ["QO_0", "QO.1:a"],
    );
  });

  it("leaves no hand-written id charset where quote and citation ids are parsed", function () {
    // These files parse, strip or validate quote and citation ids. Each must
    // build its pattern from the shared rule; a literal charset is a second
    // rule that can drift from it.
    const owners = [
      join(SRC, "services", "quotes"),
      join(SRC, "agent", "documents"),
      join(SRC, "modules", "contextPanel", "quoteValidation"),
      join(SRC, "modules", "contextPanel", "quoteRenderPlan.ts"),
      join(SRC, "agent", "context", "promptBudget.ts"),
      join(SRC, "agent", "context", "cacheManagement.ts"),
    ];
    const rule = join(SRC, "services", "quotes", "quoteTokenIds.ts");
    // The narrow and the wide id charset, plain or negated. Other charsets in
    // these files (page labels, asset ids) are not quote ids.
    const ID_CHARSET_LITERAL = /\[\^?A-Za-z0-9(?:_-|\._:-)\]/;
    const offenders = owners
      .flatMap((path) =>
        statSync(path).isDirectory() ? sourceFiles(path) : [path],
      )
      .filter((file) => file !== rule)
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => ID_CHARSET_LITERAL.test(line))
          .map(({ index }) => `${relative(SRC, file)}:${index + 1}`),
      );
    assert.deepEqual(offenders, []);
  });

  it("does not change the ids the host mints", function () {
    const input = { quoteText, citationLabel: "(Kim, 2026)", contextItemId: 7 };
    assert.equal(buildQuoteCitationId(input), "Q_0i3e1kt");
    assert.equal(buildQuoteCitation(input)?.id, "Q_0i3e1kt");
    const citation = buildQuoteCitation({
      ...input,
      sourceMatchText: quoteText,
      sourceMatchKind: "exact",
      sourceMatchSource: "context-text",
    })!;
    const plan = buildQuoteRenderPlan({
      markdown: `[[quote:${citation.id}]]`,
      quoteCitations: [citation],
    });
    assert.equal(plan.displayMarkdown, "[[quote-occurrence:QO_0]]");
    assert.isTrue(isQuoteTokenId(citation.id));
    assert.isTrue(isQuoteTokenId(plan.occurrences[0].occurrenceId));
  });
});
