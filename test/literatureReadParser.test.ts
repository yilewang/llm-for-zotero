import { assert } from "chai";
import { readFileSync } from "node:fs";
import {
  decodeEntities,
  htmlFragmentToText,
  parseArxivAtom,
  parseArxivHtml,
  parseJatsArticle,
  parseMarkup,
} from "../src/agent/services/literatureReadParser";

const AUTHORED_JATS = `<?xml version="1.0"?>
<!DOCTYPE article PUBLIC "-//NLM//DTD JATS//EN" "x.dtd">
<pmc-articleset><article xmlns:mml="http://www.w3.org/1998/Math/MathML">
<front><article-meta>
  <article-id pub-id-type="pmid">111</article-id>
  <article-id pub-id-type="pmc">222</article-id>
  <article-id pub-id-type="doi">10.1000/xyz</article-id>
  <title-group><article-title>Grid cells &amp; place cells</article-title></title-group>
  <contrib-group>
    <contrib contrib-type="author"><name><surname>Smith</surname><given-names>Ann</given-names></name></contrib>
    <contrib contrib-type="editor"><name><surname>Ed</surname><given-names>Not</given-names></name></contrib>
    <contrib contrib-type="author"><collab>The Grid Consortium</collab></contrib>
  </contrib-group>
  <pub-date pub-type="epub"><day>1</day><year>2021</year></pub-date>
  <permissions><license xlink:href="https://creativecommons.org/licenses/by/4.0/"><license-p>CC BY</license-p></license></permissions>
  <abstract abstract-type="graphical"><p>Graphical abstract.</p></abstract>
  <abstract><title>Abstract</title>
    <sec><title>Background</title><p>Grid cells fire&#160;in a lattice.</p></sec>
    <sec><title>Results</title><p>They remap&#x2014;fast.</p></sec>
  </abstract>
</article-meta></front>
<body>
  <p>Loose opening paragraph.</p>
  <sec><label>1</label><title>Introduction</title>
    <p>Mixed <italic>content</italic> with a citation (Smith <xref ref-type="bibr" rid="b1">2020</xref>)<!-- note --> and <![CDATA[raw <text>]]>.</p>
    <p>Inline <inline-formula><mml:math alttext="x^2"><mml:msup><mml:mi>x</mml:mi><mml:mn>2</mml:mn></mml:msup></mml:math><tex-math>x^{2}</tex-math></inline-formula> math and <inline-formula><mml:math><mml:mi>y</mml:mi></mml:math></inline-formula> without alt.</p>
    <sec><title>Nested background</title>
      <p>Before the formula <disp-formula><label>(1)</label><mml:math><mml:mi>E</mml:mi></mml:math></disp-formula> after it.</p>
      <sec><title>Deeper</title><p>Third level.</p></sec>
    </sec>
  </sec>
  <sec><title>Results</title>
    <fig id="f1"><label>Figure 1.</label><caption><title>Lattice.</title><p>Firing map <xref rid="s1">S1</xref>.</p></caption><graphic xlink:href="f1.jpg"/></fig>
    <table-wrap><label>Table 1</label><caption><p>Cell counts.</p></caption><table><tr><td>SECRET CELL</td></tr></table><table-wrap-foot><p>Footnote text.</p></table-wrap-foot></table-wrap>
    <list><list-item><label>&#8226;</label><p>First item.</p></list-item><list-item><p>Second item.</p></list-item></list>
  </sec>
  <sec><title>Empty</title></sec>
  <sec><title>References</title><p>Smith A. 2020. Should not appear.</p></sec>
</body>
<back>
  <ack><title>Acknowledgments</title><p>We thank the lab.</p></ack>
  <ref-list><title>References</title><ref id="b1"><mixed-citation>Smith 2020 BIBLIOGRAPHY</mixed-citation></ref></ref-list>
  <fn-group><fn><p>FOOTNOTE ONLY</p></fn></fn-group>
</back>
</article></pmc-articleset>`;

const AUTHORED_LATEXML = `<!DOCTYPE html><html><head>
<title>Paper</title><style>.x{color:red}</style>
<script>var secret = "<p>SCRIPT TEXT</p>";</script>
</head><body>
<nav class="ltx_page_navbar"><a>NAV TEXT</a></nav>
<div class="ltx_page_main"><article class="ltx_document">
<h1 class="ltx_title ltx_title_document">Attention <span class="ltx_tag">X</span>Paper</h1>
<div class="ltx_authors"><span class="ltx_personname">AUTHOR NAME</span></div>
<div class="ltx_abstract"><h6 class="ltx_title ltx_title_abstract">Abstract</h6>
<p class="ltx_p">We propose a model.</p></div>
<section id="S1" class="ltx_section">
<h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">1 </span>Introduction</h2>
<div class="ltx_para"><p class="ltx_p">Recurrent models <cite class="ltx_cite">[<a href="#bib.bib1" class="ltx_ref">13</a>]</cite> compute <math alttext="h_{t}" display="inline"><semantics><msub><mi>h</mi><mi>t</mi></msub><annotation encoding="application/x-tex">h_{t}</annotation></semantics></math> sequentially.<br>Next line.<span class="ltx_note ltx_role_footnote"><sup class="ltx_note_mark">1</sup><span class="ltx_note_content">FOOTNOTE TEXT</span></span></p></div>
<table class="ltx_equation ltx_eqn_table"><tr><td class="ltx_eqn_cell"><math alttext="E=mc^{2}" display="block"><mi>E</mi></math></td><td class="ltx_eqn_cell"><span class="ltx_tag ltx_tag_equation">(1)</span></td></tr></table>
<section id="S1.SS1" class="ltx_subsection">
<h3 class="ltx_title ltx_title_subsection"><span class="ltx_tag">1.1 </span>Details</h3>
<section class="ltx_paragraph"><h5 class="ltx_title ltx_title_paragraph">Encoder:</h5>
<div class="ltx_para"><p class="ltx_p">Six layers.</p></div></section>
<figure class="ltx_figure"><img src="f.png" alt="Refer to caption"><figcaption class="ltx_caption"><span class="ltx_tag ltx_tag_figure">Figure 1: </span>The model.</figcaption></figure>
<figure class="ltx_table"><figcaption class="ltx_caption"><span class="ltx_tag ltx_tag_table">Table 1: </span>Scores.</figcaption><table class="ltx_tabular"><tr><td>TABLE CELL</td></tr></table></figure>
</section>
</section>
<section class="ltx_bibliography"><h2 class="ltx_title ltx_title_bibliography">References</h2><ul><li class="ltx_bibitem">BIB ENTRY</li></ul></section>
</article></div>
<footer>FOOTER TEXT</footer>
</body></html>`;

describe("literature_read parsers", function () {
  it("decodes named and numeric entities and leaves unknown ones", function () {
    assert.equal(
      decodeEntities("a &amp; b &lt;c&gt; &#8212; &#x3b1; &mdash; &bogus; &"),
      "a & b <c> — α — &bogus; &",
    );
  });

  it("tolerates unmatched closing tags and keeps void elements empty", function () {
    const root = parseMarkup("<div><p>one</span> two<br>three</p></div>", {
      html: true,
    });
    const div = root.children[0] as { children: unknown[] };
    assert.lengthOf(div.children, 1);
  });

  it("turns JATS into an abstract and numbered sections without references, tables or formulas", function () {
    const parsed = parseJatsArticle(AUTHORED_JATS)!;
    assert.equal(parsed.title, "Grid cells & place cells");
    assert.deepEqual(parsed.authors, ["Ann Smith", "The Grid Consortium"]);
    assert.equal(parsed.year, 2021);
    assert.equal(parsed.pmcid, "PMC222");
    assert.equal(
      parsed.license,
      "https://creativecommons.org/licenses/by/4.0/",
    );
    assert.equal(
      parsed.abstract,
      "Background: Grid cells fire in a lattice.\n\nResults: They remap—fast.",
    );
    assert.deepEqual(
      parsed.sections.map((section) => [section.number, section.title]),
      [
        ["main", "Main text"],
        ["1", "Introduction"],
        ["u1", "Nested background"],
        ["u2", "Deeper"],
        ["u3", "Results"],
        ["u4", "Acknowledgments"],
      ],
    );
    const text = (number: string) =>
      parsed.sections.find((section) => section.number === number)!.paragraphs;
    assert.deepEqual(text("main"), ["Loose opening paragraph."]);
    assert.deepEqual(text("1"), [
      "Mixed content with a citation (Smith 2020) and raw <text>.",
      "Inline x^2 math and y without alt.",
    ]);
    // A dropped display formula leaves its paragraph whole.
    assert.deepEqual(text("u1"), ["Before the formula after it."]);
    assert.deepEqual(text("u3"), [
      "Figure 1: Lattice. Firing map S1.",
      "Table 1: Cell counts.",
      "First item.",
      "Second item.",
    ]);
    const all = JSON.stringify(parsed);
    for (const dropped of [
      "SECRET CELL",
      "Footnote text",
      "BIBLIOGRAPHY",
      "Should not appear",
      "FOOTNOTE ONLY",
      "Graphical abstract",
      "x^{2}",
    ]) {
      assert.notInclude(all, dropped);
    }
  });

  it("parses a real CC BY JATS excerpt", function () {
    const xml = readFileSync(
      new URL(
        "./fixtures/literatureRead/PMC13588937-excerpt.xml",
        import.meta.url,
      ),
      "utf8",
    );
    const parsed = parseJatsArticle(xml)!;
    assert.match(parsed.title!, /^Decoding Medial Entorhinal Cortical/);
    assert.deepEqual(parsed.authors, [
      "Masahiro Nakano",
      "Caswell Barry",
      "Claudia Clopath",
    ]);
    assert.equal(parsed.doi, "10.1002/hipo.70131");
    assert.equal(
      parsed.license,
      "https://creativecommons.org/licenses/by/4.0/",
    );
    assert.match(parsed.abstract, /^The hippocampus is central to memory/);
    assert.notInclude(parsed.abstract, "ABSTRACT");
    assert.deepEqual(
      parsed.sections.map((section) => section.title),
      [
        "Introduction",
        "Materials and Methods",
        "Simulation of Left–Right Sweeps",
        "Results",
        "Acknowledgments",
      ],
    );
    const all = parsed.sections.flatMap((section) => section.paragraphs);
    assert.isTrue(all.some((p) => p.startsWith("FIGURE 1: Modeling")));
    assert.include(all, "TABLE 1: Parameters used in the simulation.");
    assert.include(all.join(" "), "(Scoville and Milner 1957;");
    // The paper's own labels are the section numbers.
    assert.deepEqual(
      parsed.sections.map((section) => section.number),
      ["1", "2", "2.1", "3", "u1"],
    );
    // References are dropped; MathML without alttext keeps its plain text.
    assert.notInclude(all.join(" "), "Neuropsychologia");
    assert.include(all.join(" "), "The firing rate r was calculated as");
  });

  it("turns LaTeXML HTML into sections, keeping math alttext and captions only", function () {
    const parsed = parseArxivHtml(AUTHORED_LATEXML)!;
    assert.equal(parsed.title, "Attention Paper");
    assert.equal(parsed.abstract, "We propose a model.");
    assert.deepEqual(
      parsed.sections.map((section) => [section.number, section.title]),
      [
        ["1", "Introduction"],
        ["1.1", "Details"],
      ],
    );
    assert.deepEqual(parsed.sections[0].paragraphs, [
      "Recurrent models [13] compute h_{t} sequentially. Next line.",
      "E=mc^{2} (1)",
    ]);
    assert.deepEqual(parsed.sections[1].paragraphs, [
      "Encoder:",
      "Six layers.",
      "Figure 1: The model.",
      "Table 1: Scores.",
    ]);
    const all = JSON.stringify(parsed);
    for (const dropped of [
      "SCRIPT TEXT",
      "NAV TEXT",
      "AUTHOR NAME",
      "FOOTNOTE TEXT",
      "TABLE CELL",
      "BIB ENTRY",
      "FOOTER TEXT",
      "color:red",
    ]) {
      assert.notInclude(all, dropped);
    }
  });

  it("keeps the paper's own labels and never numbers loose text", function () {
    const parsed = parseArxivHtml(`<html><body><article class="ltx_document">
<div class="ltx_para"><p class="ltx_p">Permission note before section 1.</p></div>
<section class="ltx_section"><h2 class="ltx_title"><span class="ltx_tag ltx_tag_section">1 </span>Introduction</h2><div class="ltx_para"><p class="ltx_p">Intro text.</p></div></section>
<section class="ltx_section"><h2 class="ltx_title"><span class="ltx_tag ltx_tag_section">3 </span>Model</h2><div class="ltx_para"><p class="ltx_p">Model text.</p></div>
<section class="ltx_subsection"><h3 class="ltx_title"><span class="ltx_tag ltx_tag_subsection">3.2 </span>Attention</h3><div class="ltx_para"><p class="ltx_p">Attention text.</p></div></section></section>
<section class="ltx_appendix"><h2 class="ltx_title"><span class="ltx_tag ltx_tag_appendix">Appendix A: </span>Extra</h2><div class="ltx_para"><p class="ltx_p">Extra text.</p></div></section>
<figure class="ltx_figure"><figcaption class="ltx_caption">Figure 9: Trailing caption.</figcaption></figure>
</article></body></html>`)!;
    assert.deepEqual(
      parsed.sections.map((section) => [section.number, section.title]),
      [
        ["main", "Main text"],
        ["1", "Introduction"],
        ["3", "Model"],
        ["3.2", "Attention"],
        ["Appendix A", "Extra"],
        ["main-2", "Main text"],
      ],
    );
  });

  it("returns null for an HTML page without a LaTeXML document", function () {
    assert.isNull(
      parseArxivHtml(
        "<html><body><h1>Article identifier not recognized</h1></body></html>",
      ),
    );
  });

  it("reads the first arXiv Atom entry and rejects the error entry", function () {
    const entry =
      parseArxivAtom(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
      <entry><id>http://arxiv.org/abs/1706.03762v7</id><title>Attention Is
        All You Need</title><summary> The dominant models. </summary>
        <published>2017-06-12T17:57:34Z</published>
        <link href="https://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf" title="pdf"/>
        <arxiv:doi>10.48550/arXiv.1706.03762</arxiv:doi>
        <author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author></entry></feed>`)!;
    assert.deepEqual(entry, {
      title: "Attention Is All You Need",
      abstract: "The dominant models.",
      authors: ["Ashish Vaswani", "Noam Shazeer"],
      year: 2017,
      doi: "10.48550/arXiv.1706.03762",
      pdfUrl: "https://arxiv.org/pdf/1706.03762v7",
    });
    assert.isNull(
      parseArxivAtom(
        `<feed><entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_x</id><title>Error</title><summary>incorrect id format</summary></entry></feed>`,
      ),
    );
    assert.isNull(parseArxivAtom("<feed></feed>"));
  });

  it("flattens a Europe PMC HTML abstract by block", function () {
    assert.equal(
      htmlFragmentToText(
        "<h4>Background</h4>Grid <i>cells</i> fire.<h4>Results</h4>They remap &amp; drift.",
      ),
      "Background\n\nGrid cells fire.\n\nResults\n\nThey remap & drift.",
    );
    assert.equal(htmlFragmentToText("Plain &amp; simple"), "Plain & simple");
  });
});
