import { assert } from "chai";
import {
  BEFORE_FIRST_SECTION_TITLE,
  detectDocumentStructure,
  splitPdfTextPages,
  textPageOffset,
  type DetectedDocumentStructure,
  type PdfOutlineEntry,
} from "../src/services/paperContent/documentStructure";
import {
  BOOK_BOOKMARKS,
  BOOK_LEADING_BLANK_PAGES,
  BOOK_PAGES,
  DISSERTATION_PAGES,
  joinPages,
} from "./fixtures/longdoc/pageTexts";

function outline(structure: DetectedDocumentStructure | null) {
  return (structure?.sections || []).map((section) => ({
    title: section.title,
    level: section.level,
    parent:
      section.parentIndex === undefined
        ? null
        : structure!.sections[section.parentIndex].title,
    pages: [section.pageStart, section.pageEnd],
  }));
}

/** A paper laid out the way LaTeX sets it: sections start mid-page. */
const PAPER_PAGES: string[][] = [
  [
    "Adaptive front tracking for thin films",
    "Abstract. We track the front of a thin film with an adaptive mesh.",
    "1 Introduction",
    "Thin films spread over surfaces in many settings.",
  ],
  [
    "the spreading rate depends on the contact line.",
    "2 Methods",
    "We discretise the lubrication equation with finite elements.",
  ],
  [
    "the time step follows from a stability bound.",
    "3 Results",
    "The front advances at the predicted rate.",
  ],
  [
    "the error decreases with the mesh size.",
    "4 Discussion",
    "The scheme extends to three dimensions.",
    "References",
  ],
];

describe("document structure of plain PDF text", function () {
  it("splits pages at form feeds and by page character counts", function () {
    const text = joinPages([["a"], ["b"], ["c"]]);
    assert.deepEqual(
      splitPdfTextPages(text)?.map((page) => text.slice(page.start, page.end)),
      ["a\n\n", "b\n\n", "c"],
    );
    assert.deepEqual(splitPdfTextPages("abcdef", { pageChars: [2, 4] }), [
      { index: 0, start: 0, end: 2 },
      { index: 1, start: 2, end: 6 },
    ]);
    assert.isNull(splitPdfTextPages("abc", { pageChars: [2, 4] }));
  });

  it("finds chapters that open pages and their numbered subsections", function () {
    const text = joinPages(DISSERTATION_PAGES);
    const structure = detectDocumentStructure({
      text,
      layout: { totalPages: DISSERTATION_PAGES.length },
    });
    assert.equal(structure?.source, "headings");
    assert.deepEqual(outline(structure), [
      {
        title: BEFORE_FIRST_SECTION_TITLE,
        level: 1,
        parent: null,
        pages: [0, 1],
      },
      {
        title: "Chapter 1:Introduction",
        level: 1,
        parent: null,
        pages: [2, 5],
      },
      {
        title: "1.1Visual processing and representations in the brain",
        level: 2,
        parent: "Chapter 1:Introduction",
        pages: [4, 5],
      },
      {
        title: "1.2Hierarchical architecture of the visual cortex",
        level: 2,
        parent: "Chapter 1:Introduction",
        pages: [5, 5],
      },
      {
        title: "Chapter 2:Philosophical and historical background",
        level: 1,
        parent: null,
        pages: [6, 7],
      },
      {
        title: "2.1The relationship between perception and reality",
        level: 2,
        parent: "Chapter 2:Philosophical and historical background",
        pages: [6, 7],
      },
      {
        title: "2.1.1Plato and the Allegory of the Cave",
        level: 3,
        parent: "2.1The relationship between perception and reality",
        pages: [6, 7],
      },
      {
        title: "2.1.2Ibn Al-Haytham and subjectivity of perception",
        level: 3,
        parent: "2.1The relationship between perception and reality",
        pages: [7, 7],
      },
      {
        title:
          "Chapter 3:Variational Inference & Variational Autoencoders (VAE)",
        level: 1,
        parent: null,
        pages: [8, 9],
      },
    ]);
    const chapter = structure!.sections[1];
    assert.equal(text.slice(chapter.charStart).split("\n")[0], chapter.title);
    assert.isAbove(chapter.tokens, 0);
    assert.isAbove(
      chapter.chars,
      chapter.ownChars,
      "ranges include subsections",
    );
  });

  it("takes bookmarks first and aligns them past trimmed blank pages", function () {
    const text = joinPages(BOOK_PAGES);
    const structure = detectDocumentStructure({
      text,
      layout: { totalPages: BOOK_PAGES.length + BOOK_LEADING_BLANK_PAGES },
      bookmarks: BOOK_BOOKMARKS,
    });
    assert.equal(structure?.source, "bookmarks");
    assert.equal(structure?.pageOffset, BOOK_LEADING_BLANK_PAGES);
    const rows = outline(structure);
    assert.deepEqual(
      rows.filter((row) => row.level === 1),
      [
        { title: "Contents", level: 1, parent: null, pages: [2, 2] },
        { title: "Preface", level: 1, parent: null, pages: [3, 3] },
        {
          title: "Chapter 1 Introduction to Psychology",
          level: 1,
          parent: null,
          pages: [4, 5],
        },
        {
          title: "Chapter 2 Psychological Research",
          level: 1,
          parent: null,
          pages: [6, 7],
        },
      ],
    );
    // A chapter whose title closes its opening page still owns that page.
    const chapter = structure!.sections.find(
      (section) => section.title === "Chapter 1 Introduction to Psychology",
    )!;
    assert.match(text.slice(chapter.charStart), /^FIGURE 1\.1/);
    assert.include(
      rows.map((row) => row.title),
      "1.1 What Is Psychology?",
    );
  });

  it("keeps two top-level bookmarks on one page as two sections", function () {
    // Both front-matter bookmarks point at the page top; a subsection's
    // lower destination shows that the destinations carry position.
    const pages = [
      ["Acknowledgments", "I thank my advisor.", "Abstract", "This thesis."],
      ["Chapter 1", "Introduction", "Brains compute.", "1.1 Cells", "Neurons."],
      ["Chapter 2", "Methods", "We record."],
    ];
    const text = joinPages(pages);
    const at = (title: string, pageIndex: number, top: number, depth = 0) => ({
      depth,
      title,
      pageIndex,
      top,
      fitsPage: false,
    });
    const structure = detectDocumentStructure({
      text,
      layout: { totalPages: pages.length },
      bookmarks: [
        at("Acknowledgments", 0, 760),
        at("Abstract", 0, 760),
        at("Chapter 1 Introduction", 1, 760),
        at("1.1 Cells", 1, 420, 1),
        at("Chapter 2 Methods", 2, 760),
      ],
    });
    const start = (title: string) =>
      structure!.sections.find((section) => section.title === title)!.charStart;
    assert.deepEqual(
      outline(structure).map((row) => row.title),
      [
        "Acknowledgments",
        "Abstract",
        "Chapter 1 Introduction",
        "1.1 Cells",
        "Chapter 2 Methods",
      ],
    );
    assert.match(text.slice(start("Acknowledgments")), /^Acknowledgments\n/);
    assert.match(text.slice(start("Abstract")), /^Abstract\nThis thesis\./);
    // A title split over lines that opens its page starts at the page.
    assert.match(text.slice(start("Chapter 1 Introduction")), /^Chapter 1\n/);
  });

  describe("bookmarked papers and books", function () {
    const entry = (
      title: string,
      pageIndex: number,
      top: number | null,
      fitsPage = false,
      depth = 0,
    ) => ({ depth, title, pageIndex, top, fitsPage });
    const SECTION_TITLES = [
      "1 Introduction",
      "2 Methods",
      "3 Results",
      "4 Discussion",
      "References",
    ];
    const SECTION_PAGES = [0, 1, 2, 3, 3];
    const MID_PAGE_PAPER = [
      [
        "Adaptive front tracking",
        "Abstract. We track.",
        "1 Introduction",
        "Thin films spread.",
      ],
      ["the rate depends.", "2 Methods", "We discretise."],
      ["the step follows.", "3 Results", "The front advances."],
      [
        "the error decreases.",
        "4 Discussion",
        "The scheme extends.",
        "References",
      ],
    ];

    it("leaves a NeurIPS paper unchaptered: sections mid-page, appendix and checklist open pages", function () {
      const pages = [
        [
          "A Neural Method",
          "Anonymous",
          "Abstract",
          "We propose.",
          "1 Introduction",
          "Deep nets.",
        ],
        ["more intro.", "2 Related Work", "Prior art.", "3 Method", "We do."],
        [
          "more method.",
          "4 Experiments",
          "We test.",
          "5 Conclusion",
          "Done.",
          "References",
          "[1] X.",
        ],
        ["A Proofs", "Proof of theorem 1.", "A.1 Lemma", "Proof."],
        ["NeurIPS Paper Checklist", "1. Claims", "Answer: Yes"],
      ];
      const bookmarks = [
        entry("1 Introduction", 0, null),
        entry("2 Related Work", 1, null),
        entry("3 Method", 1, null),
        entry("4 Experiments", 2, null),
        entry("5 Conclusion", 2, null),
        entry("References", 2, null),
        entry("A Proofs", 3, null),
        entry("A.1 Lemma", 3, null, false, 1),
        entry("NeurIPS Paper Checklist", 4, null),
      ];
      assert.isNull(
        detectDocumentStructure({
          text: joinPages(pages),
          layout: { totalPages: 5 },
          bookmarks,
        }),
      );
    });

    it("leaves an all-/Fit paper unchaptered", function () {
      const bookmarks = SECTION_TITLES.map((title, index) =>
        entry(title, SECTION_PAGES[index], null, true),
      );
      assert.isNull(
        detectDocumentStructure({
          text: joinPages(MID_PAGE_PAPER),
          layout: { totalPages: 4 },
          bookmarks,
        }),
      );
    });

    it("leaves a paper unchaptered when every destination shares one top", function () {
      const bookmarks = SECTION_TITLES.map((title, index) =>
        entry(title, SECTION_PAGES[index], 792),
      );
      assert.isNull(
        detectDocumentStructure({
          text: joinPages(MID_PAGE_PAPER),
          layout: { totalPages: 4 },
          bookmarks,
        }),
      );
    });

    it("leaves a paper unchaptered when a running header precedes sections that open pages", function () {
      const pages = [
        [
          "Adaptive front tracking",
          "Abstract. We track.",
          "1 Introduction",
          "Thin films spread.",
        ],
        ["Smith et al. 2", "2 Methods", "We discretise the equation."],
        ["Smith et al. 3", "3 Results", "The front advances."],
        [
          "Smith et al. 4",
          "the error decreases.",
          "4 Discussion",
          "The scheme extends.",
          "References",
        ],
      ];
      const bookmarks = SECTION_TITLES.map((title, index) =>
        entry(title, SECTION_PAGES[index], [500, 760, 760, 400, 200][index]),
      );
      assert.isNull(
        detectDocumentStructure({
          text: joinPages(pages),
          layout: { totalPages: 4 },
          bookmarks,
        }),
      );
    });

    it("leaves a paper with positional bookmarks unchaptered when two sections happen to start at a page top", function () {
      const pages = [
        [
          "Adaptive front tracking",
          "Abstract. We track.",
          "1 Introduction",
          "Thin films spread.",
        ],
        ["2 Methods", "We discretise the equation with finite elements."],
        ["3 Results", "The front advances at the predicted rate."],
        [
          "the error decreases.",
          "4 Discussion",
          "The scheme extends.",
          "References",
          "[1] A.",
        ],
      ];
      const bookmarks = SECTION_TITLES.map((title, index) =>
        entry(title, SECTION_PAGES[index], [500, 760, 760, 400, 200][index]),
      );
      assert.isNull(
        detectDocumentStructure({
          text: joinPages(pages),
          layout: { totalPages: 4 },
          bookmarks,
        }),
      );
    });

    it("chapters a book with positional bookmarks whose chapter titles are not where its pages start", function () {
      // A textbook's chapter page opens with a figure caption and prints the
      // title last, without the bookmark's "Chapter" word.
      const pages = [
        ["Contents", "Preface 2", "1 Memory 3"],
        ["Preface", "This book is for students."],
        ["FIGURE 1.1 A photograph.", "INTRODUCTION", "1", "Memory"],
        ["1.1 How Memory Functions", "Memory stores what we learn."],
        ["FIGURE 2.1 A painting.", "INTRODUCTION", "2", "Learning"],
        ["2.1 What Is Learning?", "Learning changes behavior."],
      ];
      const bookmarks = [
        entry("Contents", 0, 734),
        entry("Preface", 1, 734),
        entry("Chapter 1 Memory", 2, 745),
        entry("1.1 How Memory Functions", 3, 690, false, 1),
        entry("Chapter 2 Learning", 4, 745),
        entry("2.1 What Is Learning?", 5, 690, false, 1),
      ];
      const text = joinPages(pages);
      const structure = detectDocumentStructure({
        text,
        layout: { totalPages: pages.length },
        bookmarks,
      });
      assert.equal(structure?.source, "bookmarks");
      assert.deepEqual(
        outline(structure)
          .filter((row) => row.level === 1)
          .map((row) => [row.title, row.pages]),
        [
          ["Contents", [0, 0]],
          ["Preface", [1, 1]],
          ["Chapter 1 Memory", [2, 3]],
          ["Chapter 2 Learning", [4, 5]],
        ],
      );
      const chapter = structure!.sections.find(
        (section) => section.title === "Chapter 1 Memory",
      )!;
      assert.match(text.slice(chapter.charStart), /^FIGURE 1\.1/);
    });

    it("chapters a textbook by its text alone when its chapter titles close their opening pages", function () {
      // The Psychology 2e shape without destination heights: each opening
      // page starts with its figure and ends with "N" and the title.
      const pages = [
        ["Contents", "Preface 2", "1 Memory 3"],
        ["Preface", "This book is for students."],
        ["FIGURE 1.1 A photograph.", "INTRODUCTION", "1", "Memory"],
        ["1.1 How Memory Functions", "Memory stores what we learn."],
        ["FIGURE 2.1 A painting.", "INTRODUCTION", "2", "Learning"],
        ["2.1 What Is Learning?", "Learning changes behavior."],
      ];
      const text = joinPages(pages);
      const structure = detectDocumentStructure({
        text,
        layout: { totalPages: pages.length },
        bookmarks: [
          entry("Contents", 0, null),
          entry("Preface", 1, null),
          entry("Chapter 1 Memory", 2, null),
          entry("1.1 How Memory Functions", 3, null, false, 1),
          entry("Chapter 2 Learning", 4, null),
          entry("2.1 What Is Learning?", 5, null, false, 1),
        ],
      });
      assert.deepEqual(
        outline(structure)
          .filter((row) => row.level === 1)
          .map((row) => [row.title, row.pages]),
        [
          ["Contents", [0, 0]],
          ["Preface", [1, 1]],
          ["Chapter 1 Memory", [2, 3]],
          ["Chapter 2 Learning", [4, 5]],
        ],
      );
      // The chapter owns its opening page, title last.
      const chapter = structure!.sections.find(
        (section) => section.title === "Chapter 1 Memory",
      )!;
      assert.match(text.slice(chapter.charStart), /^FIGURE 1\.1/);
    });

    // A paper's sections start mid-page with lower destinations: whatever
    // numbers its pages, its first section fails, so it stays unchaptered.
    const REVIEW_PAPER = [
      [
        "A Neural Method",
        "Abstract",
        "We propose.",
        "1 Introduction",
        "Deep nets.",
      ],
      ["more intro.", "2 Methods", "We do."],
      ["more.", "3 Results", "Done.", "References", "[1] X"],
      ["Supplementary Information", "S1 Proofs", "Proof."],
      ["S2 Tables", "Table."],
    ];
    const REVIEW_BOOKMARKS = [
      entry("1 Introduction", 0, 500),
      entry("2 Methods", 1, 600),
      entry("3 Results", 2, 650),
      entry("References", 2, 300),
      entry("Supplementary Information", 3, 760),
      entry("S1 Proofs", 3, 700, false, 1),
      entry("S2 Tables", 4, 760, false, 1),
    ];
    const detectPages = (pages: string[][], bookmarks: PdfOutlineEntry[]) =>
      detectDocumentStructure({
        text: joinPages(pages),
        layout: { totalPages: pages.length },
        bookmarks,
      });

    it("leaves a paper with a supplement that opens a page unchaptered (its PDF may label the supplement S1…)", function () {
      assert.isNull(detectPages(REVIEW_PAPER, REVIEW_BOOKMARKS));
    });

    it("leaves a journal paper behind an unnumbered cover page unchaptered", function () {
      const shifted = REVIEW_BOOKMARKS.slice(0, 4).map((bookmark) => ({
        ...bookmark,
        pageIndex: bookmark.pageIndex + 1,
      }));
      assert.isNull(
        detectPages(
          [
            ["Downloaded from journal.org", "Cover"],
            ...REVIEW_PAPER.slice(0, 3),
          ],
          shifted,
        ),
      );
      // The same with a title page numbered "i" before pages 1…n.
      assert.isNull(
        detectPages([["Title page"], ...REVIEW_PAPER.slice(0, 3)], shifted),
      );
    });

    it("does not take an orphan heading at one page's foot for a page start", function () {
      assert.isNull(
        detectPages(
          [
            ["Title", "1 Introduction", "Text."],
            ["more.", "2 Methods"],
            ["We do.", "3 Results", "Done."],
          ],
          [
            entry("1 Introduction", 0, null),
            entry("2 Methods", 1, null),
            entry("3 Results", 2, null),
          ],
        ),
      );
    });

    it("leaves papers unchaptered whose headings sit at a page's foot or under a running header", function () {
      const unnumbered = [
        entry("Introduction", 0, null),
        entry("Methods", 1, null),
        entry("Results", 2, null),
      ];
      const numbered = [
        entry("1 Introduction", 0, null),
        entry("2 Methods", 1, null),
        entry("3 Results", 2, null),
      ];
      const cases: Array<[string[][], ReturnType<typeof entry>[]]> = [
        // Numbered headings, one at a page's foot.
        [
          [
            ["Title", "Abstract", "1 Introduction", "Text."],
            ["more.", "2 Methods"],
            ["more.", "3 Results", "Done."],
          ],
          numbered,
        ],
        // An unnumbered heading at every page's foot, with no label.
        [
          [
            ["Title", "Abstract", "x", "Introduction"],
            ["more.", "Methods"],
            ["more.", "Results"],
          ],
          unnumbered,
        ],
        // A body line that ends in a number is no label line.
        [
          [
            ["Title", "Abstract", "as in Table 1", "Introduction"],
            ["see Figure 2", "Methods"],
            ["see Table 3", "Results"],
          ],
          unnumbered,
        ],
        // A heading, then the page number as the footer.
        [
          [
            ["Title", "Text.", "Introduction", "1"],
            ["more.", "Methods", "2"],
            ["more.", "Results", "3"],
          ],
          unnumbered,
        ],
        // A running header, then the heading.
        [
          [
            ["Journal of X 12", "Introduction", "Text."],
            ["Journal of X 13", "Methods", "Text."],
            ["Journal of X 14", "Results", "Text."],
          ],
          numbered,
        ],
        // A running header that ends in its page number is no label line.
        [
          [
            ["Journal of X 12", "Introduction", "Text."],
            ["Journal of X 13", "Methods", "Text."],
            ["Journal of X 14", "Results", "Text."],
          ],
          unnumbered,
        ],
        [
          [
            ["Smith et al.", "Introduction", "Text."],
            ["Smith et al.", "Methods", "Text."],
          ],
          unnumbered.slice(0, 2),
        ],
      ];
      for (const [pages, bookmarks] of cases)
        assert.isNull(detectPages(pages, bookmarks), pages[0].join(" | "));
    });

    it("matches a title less its label only as whole lines, never inside a word or a sentence", function () {
      const bookmarks = [
        entry("1 Introduction", 0, null),
        entry("2 Methods", 1, null),
        entry("3 Results", 2, null),
      ];
      // Pages that end in a word ending in the next title, or a sentence
      // ending in it ("…these results.").
      assert.isNull(
        detectPages(
          [
            ["Introduction", "Deep nets matter for our methods"],
            ["2 Methods", "We do. These are our results"],
            ["the rest.", "3 Results", "Done; we report the discussion"],
          ],
          bookmarks,
        ),
      );
      assert.isNull(
        detectPages(
          [
            ["Introduction", "text"],
            ["blah", "we propose newmethods"],
            ["Results", "x"],
          ],
          bookmarks,
        ),
      );
      assert.isNull(
        detectPages(
          [
            ["Introduction", "text"],
            ["2 Methods", "We do."],
            ["more.", "We discuss these results."],
          ],
          bookmarks,
        ),
      );
      // A title on its own lines at the page's end, over two lines, matches.
      assert.isNotNull(
        detectPages(
          [
            ["Introduction", "text"],
            ["FIGURE 2.1 A plot.", "2", "Industrial-Organizational", "Methods"],
            ["Results", "x"],
          ],
          [
            entry("1 Introduction", 0, null),
            entry("2 Industrial-Organizational Methods", 1, null),
            entry("3 Results", 2, null),
          ],
        ),
      );
    });

    it("starts a part that only its destination places at the page start, not at a lower line with its title", function () {
      const pages = [
        ["Preface", "This book."],
        ["Part One", "Overview of what follows.", "Methods", "We record."],
        ["Chapter 2", "Results", "We find."],
      ];
      const text = joinPages(pages);
      const structure = detectDocumentStructure({
        text,
        layout: { totalPages: pages.length },
        bookmarks: [
          entry("Preface", 0, 760),
          entry("Methods", 1, 760),
          entry("2.1 Data", 2, 400, false, 1),
          entry("Chapter 2 Results", 2, 760),
        ],
      });
      const methods = structure!.sections.find(
        (section) => section.title === "Methods",
      )!;
      assert.match(text.slice(methods.charStart), /^Part One\n/);
    });

    it("chapters a thesis whose part's bookmark sits mid-page when its page opens with a Roman label line", function () {
      // Part IV's page prints "Part IV" then the title; the bookmark's
      // destination is below the page top.
      const pages = [
        ["Declaration", "I declare."],
        ["Part I", "SYNOPSIS", "This part."],
        ["Part IV", "MANUSCRIPTS", "The papers."],
      ];
      const text = joinPages(pages);
      const structure = detectPages(pages, [
        entry("Declaration", 0, 777),
        entry("Synopsis", 1, 777),
        entry("Manuscripts", 2, 398),
      ]);
      const manuscripts = structure!.sections.find(
        (section) => section.title === "Manuscripts",
      )!;
      assert.match(text.slice(manuscripts.charStart), /^Part IV\n/);
    });

    it("chapters a LaTeX book whose part bookmarks carry Roman numerals and sit mid-page", function () {
      const structure = detectPages(
        [
          ["Contents", "I Foundations 3", "1 Intro 5"],
          ["Preface", "This book."],
          ["Part I", "Foundations"],
          ["Chapter 1", "Introduction", "Text."],
          ["1.1 Scope", "Text."],
          ["Part II", "Methods"],
          ["Chapter 2", "Models", "Text."],
          ["Bibliography", "[1] X"],
        ],
        [
          entry("Contents", 0, 745),
          entry("Preface", 1, 745),
          entry("I Foundations", 2, 420),
          entry("1 Introduction", 3, 745, false, 1),
          entry("1.1 Scope", 4, 600, false, 2),
          entry("II Methods", 5, 420),
          entry("2 Models", 6, 745, false, 1),
          entry("Bibliography", 7, 745),
        ],
      );
      assert.deepEqual(
        structure!.sections
          .filter((section) => section.level === 1)
          .map((section) => [section.title, section.pageStart]),
        [
          ["Contents", 0],
          ["Preface", 1],
          ["I Foundations", 2],
          ["II Methods", 5],
          ["Bibliography", 7],
        ],
      );
    });

    it("takes a Roman label only as a whole token or a whole line before the title", function () {
      const bookmarks = [
        entry("Declaration", 0, 777),
        entry("Synopsis", 1, 398),
        entry("Manuscripts", 2, 398),
      ];
      // A word that only begins with Roman letters is no label.
      assert.isNull(
        detectPages(
          [
            ["Declaration", "I declare."],
            ["Mixsynopsis", "This part."],
            ["Part IV", "MANUSCRIPTS", "The papers."],
          ],
          bookmarks,
        ),
      );
      // A body line before the title is no label line.
      assert.isNull(
        detectPages(
          [
            ["Declaration", "I declare."],
            ["Part I of the thesis", "SYNOPSIS", "This part."],
            ["Part IV", "MANUSCRIPTS", "The papers."],
          ],
          bookmarks,
        ),
      );
    });

    it("known limit: leaves an ebook with a cover and whole-page chapter bookmarks unchaptered", function () {
      const pages = [
        [""],
        ["The Book Title", "An Author"],
        ["Copyright 2020 Publisher"],
        ["Contents", "1 Intro"],
        ["1", "Introduction", "Text."],
        ["2", "Models", "Text."],
      ];
      const bookmarks = [
        entry("Cover", 0, null, true),
        entry("Title Page", 1, null, true),
        entry("Copyright", 2, null, true),
        entry("Contents", 3, null, true),
        entry("1 Introduction", 4, null, true),
        entry("2 Models", 5, null, true),
      ];
      assert.isNull(
        detectDocumentStructure({
          text: joinPages(pages),
          layout: { totalPages: pages.length },
          bookmarks,
        }),
      );
    });

    it("known limit: chapters a preprint whose title bookmark heads its sections and whose supplement opens a page", function () {
      const pages = [
        [
          "Adaptive Front Tracking",
          "A. Author",
          "Abstract",
          "We track.",
          "1 Introduction",
          "Films.",
        ],
        ["more.", "2 Methods", "We do."],
        ["more.", "3 Results", "Done.", "References", "[1] X"],
        ["Supplementary Material", "S1 Proofs", "Proof."],
      ];
      const bookmarks = [
        entry("Adaptive Front Tracking", 0, 780),
        entry("1 Introduction", 0, 500, false, 1),
        entry("2 Methods", 1, 600, false, 1),
        entry("3 Results", 2, 650, false, 1),
        entry("References", 2, 300, false, 1),
        entry("Supplementary Material", 3, 780),
        entry("S1 Proofs", 3, 700, false, 1),
      ];
      assert.isNotNull(
        detectDocumentStructure({
          text: joinPages(pages),
          layout: { totalPages: pages.length },
          bookmarks,
        }),
      );
    });

    it("known limit: chapters a paper whose every section starts at a page top", function () {
      const pages = [
        ["Abstract", "We track.", "Films spread.", "1 Introduction", "Films."],
        ["2 Methods", "We do."],
        ["more.", "3 Results", "Done."],
      ];
      const bookmarks = [
        entry("Abstract", 0, 760),
        entry("1 Introduction", 0, 760),
        entry("2 Methods", 1, 760),
        entry("3 Results", 2, 760),
        entry("3.1 Sub", 2, 400, false, 1),
      ];
      assert.isNotNull(
        detectDocumentStructure({
          text: joinPages(pages),
          layout: { totalPages: pages.length },
          bookmarks,
        }),
      );
    });
  });

  it("leaves a paper whose bookmarked sections start mid-page unchaptered", function () {
    const text = joinPages(PAPER_PAGES);
    const structure = detectDocumentStructure({
      text,
      layout: { totalPages: PAPER_PAGES.length },
      bookmarks: [
        {
          depth: 0,
          title: "1 Introduction",
          pageIndex: 0,
          top: 640,
          fitsPage: false,
        },
        {
          depth: 0,
          title: "2 Methods",
          pageIndex: 1,
          top: 512,
          fitsPage: false,
        },
        {
          depth: 0,
          title: "3 Results",
          pageIndex: 2,
          top: 498,
          fitsPage: false,
        },
        {
          depth: 0,
          title: "4 Discussion",
          pageIndex: 3,
          top: 530,
          fitsPage: false,
        },
        {
          depth: 0,
          title: "References",
          pageIndex: 3,
          top: 210,
          fitsPage: false,
        },
      ],
    });
    assert.isNull(structure);
  });

  it("leaves a paper without bookmarks unchaptered", function () {
    const text = joinPages(PAPER_PAGES);
    assert.isNull(
      detectDocumentStructure({
        text,
        layout: { totalPages: PAPER_PAGES.length },
      }),
    );
  });

  it("does not take numbered running headers for chapters", function () {
    const pages = [1, 2, 3, 4].map((page) => [
      `${page} J. Smith and A. Jones`,
      `Body text of page ${page} continues the argument.`,
    ]);
    assert.isNull(
      detectDocumentStructure({
        text: joinPages(pages),
        layout: { totalPages: pages.length },
      }),
    );
  });

  it("does not take numbered captions for chapters when their numbering continues mid-page", function () {
    const figures = [
      ["Figure 1: Overview of the model", "Body"],
      ["more body text"],
      ["Figure 2: Results of the model", "Body"],
      ["more body text", "Figure 3: Error of the model", "Body"],
    ];
    const tables = [
      ["Thin films", "Body"],
      ["Table 1. Parameters of the runs", "Body"],
      ["more body text"],
      ["Table 2. Errors of the runs", "Body"],
      ["more body text", "Table 3. Timings of the runs", "Body"],
    ];
    for (const pages of [figures, tables])
      assert.isNull(
        detectDocumentStructure({
          text: joinPages(pages),
          layout: { totalPages: pages.length },
        }),
      );
  });

  it("leaves a paper unchaptered when some of its sections happen to open pages", function () {
    const pages = [
      ["Thin films", "1 Introduction", "Films spread over surfaces."],
      ["2 Methods", "We discretise the equation."],
      ["the time step follows from a bound."],
      ["3 Results", "The front advances."],
      ["the error decreases.", "4 Discussion", "The scheme extends."],
    ];
    assert.isNull(
      detectDocumentStructure({
        text: joinPages(pages),
        layout: { totalPages: pages.length },
      }),
    );
  });

  describe("label grammar", function () {
    const entry = (title: string, pageIndex: number) => ({
      depth: 0,
      title,
      pageIndex,
      top: null,
      fitsPage: false,
    });
    const run = (pages: string[][], titles: string[]) =>
      detectDocumentStructure({
        text: joinPages(pages),
        layout: { totalPages: pages.length },
        bookmarks: titles.map((title, index) => entry(title, index)),
      });

    for (const [name, first, second] of [
      ["did", "did", "did"],
      ["mix", "mix", "mix"],
      ["John M.", "John M.", "Mary C."],
    ]) {
      it(`leaves a paper unchaptered when "${name}" precedes the titles`, function () {
        assert.isNull(
          run(
            [
              [first, "Introduction", "x"],
              [second, "Methods", "y"],
            ],
            ["Introduction", "Methods"],
          ),
        );
      });
    }

    it("reads a number glued to its title as label plus title", function () {
      const result = run(
        [
          ["Contents"],
          ["1Introduction", "text"],
          ["2Methods", "text"],
          ["3Results", "text"],
        ],
        ["Contents", "Introduction", "Methods", "Results"],
      );
      assert.isNotNull(result);
      const glued = run(
        [
          ["Contents"],
          ["Chapter 1Introduction", "text"],
          ["Chapter 2Methods", "text"],
          ["Chapter 3Results", "text"],
        ],
        ["Contents", "Introduction", "Methods", "Results"],
      );
      assert.isNotNull(glued);
    });
  });

  describe("the PDF page of the text's first page", function () {
    it("is the shift the bookmarks show past trimmed blank pages", function () {
      assert.equal(
        textPageOffset({
          text: joinPages(BOOK_PAGES),
          layout: { totalPages: BOOK_PAGES.length + BOOK_LEADING_BLANK_PAGES },
          bookmarks: BOOK_BOOKMARKS,
        }),
        BOOK_LEADING_BLANK_PAGES,
      );
    });

    it("is unknown when two shifts put equally many titles on their page", function () {
      // Both text pages carry the title, so shift 0 and shift 1 each put
      // it on its page: the bookmarks prove neither.
      const text = joinPages([
        ["Alpha", "First body."],
        ["Alpha", "Second body."],
      ]);
      assert.isNull(
        textPageOffset({
          text,
          layout: { totalPages: 3 },
          bookmarks: [
            {
              depth: 0,
              title: "Alpha",
              pageIndex: 1,
              top: null,
              fitsPage: false,
            },
          ],
        }),
      );
    });

    it("is unknown when no title is on its page under any shift", function () {
      assert.isNull(
        textPageOffset({
          text: joinPages([["First body."], ["Second body."]]),
          layout: { totalPages: 3 },
          bookmarks: [
            {
              depth: 0,
              title: "Gamma",
              pageIndex: 1,
              top: null,
              fitsPage: false,
            },
          ],
        }),
      );
    });
  });

  it("returns nothing when the page split does not match the PDF without bookmarks", function () {
    const text = joinPages(DISSERTATION_PAGES);
    assert.isNull(
      detectDocumentStructure({
        text,
        layout: { totalPages: DISSERTATION_PAGES.length + 1 },
      }),
    );
  });

  it("falls back to headings when bookmarks are out of page order", function () {
    const text = joinPages(DISSERTATION_PAGES);
    const structure = detectDocumentStructure({
      text,
      layout: { totalPages: DISSERTATION_PAGES.length },
      bookmarks: [
        {
          depth: 0,
          title: "Chapter 2",
          pageIndex: 6,
          top: 700,
          fitsPage: false,
        },
        {
          depth: 0,
          title: "Chapter 1",
          pageIndex: 2,
          top: 700,
          fitsPage: false,
        },
      ],
    });
    assert.equal(structure?.source, "headings");
  });

  describe("in any language", function () {
    /** Chapters that open pages under `heading(n)`, each with a numbered subsection. */
    function chapteredPages(
      front: string,
      heading: (chapter: number) => string,
      subsection: (chapter: number) => string,
    ): string[][] {
      const pages: string[][] = [[front, "......"]];
      for (const chapter of [1, 2, 3])
        pages.push(
          [heading(chapter), "body text", "body text"],
          ["body text", `${chapter}.1 ${subsection(chapter)}`, "text"],
        );
      return pages;
    }

    const cases: Array<[string, string[][], string[]]> = [
      [
        "German",
        chapteredPages(
          "Vorwort",
          (n) =>
            [
              "",
              "Kapitel 1 Einleitung",
              "Kapitel 2 Grundlagen",
              "Kapitel 3 Methoden",
            ][n],
          (n) => `Überblick ${n}`,
        ),
        ["Kapitel 1 Einleitung", "Kapitel 2 Grundlagen", "Kapitel 3 Methoden"],
      ],
      [
        "Russian",
        chapteredPages(
          "Предисловие",
          (n) => ["", "Глава 1 Введение", "Глава 2 Обзор", "Глава 3 Методы"][n],
          (n) => `Выборка ${n}`,
        ),
        ["Глава 1 Введение", "Глава 2 Обзор", "Глава 3 Методы"],
      ],
      [
        "Chinese with Arabic digits",
        chapteredPages(
          "摘要",
          (n) => ["", "第1章 绪论", "第2章 文献综述", "第3章 研究方法"][n],
          (n) => `研究设计${n}`,
        ),
        ["第1章 绪论", "第2章 文献综述", "第3章 研究方法"],
      ],
    ];
    for (const [language, pages, chapters] of cases)
      it(`finds ${language} chapters that open pages, with their subsections`, function () {
        const structure = detectDocumentStructure({
          text: joinPages(pages),
          layout: { totalPages: pages.length },
        });
        assert.equal(structure?.source, "headings");
        const rows = outline(structure);
        assert.deepEqual(
          rows.filter((row) => row.level === 1).map((row) => row.title),
          [BEFORE_FIRST_SECTION_TITLE, ...chapters],
        );
        assert.deepEqual(
          rows.filter((row) => row.level === 2).map((row) => row.parent),
          chapters,
        );
      });

    it("leaves chapters numbered without Arabic digits unchaptered when there are no bookmarks", function () {
      const han = chapteredPages(
        "摘要",
        (n) => ["", "第一章 绪论", "第二章 文献综述", "第三章 研究方法"][n],
        (n) => `研究设计${n}`,
      );
      const roman = chapteredPages(
        "Preface",
        (n) =>
          [
            "",
            "Chapter I Introduction",
            "Chapter II Background",
            "Chapter III Methods",
          ][n],
        (n) => `Sampling ${n}`,
      );
      for (const pages of [han, roman])
        assert.isNull(
          detectDocumentStructure({
            text: joinPages(pages),
            layout: { totalPages: pages.length },
          }),
        );
    });

    it("takes chapters numbered without Arabic digits from bookmarks, titles unchanged", function () {
      const titles = ["第一章 绪论", "第二章 文献综述", "第三章 研究方法"];
      const pages = chapteredPages(
        "摘要",
        (n) => titles[n - 1],
        (n) => `研究设计${n}`,
      );
      const structure = detectDocumentStructure({
        text: joinPages(pages),
        layout: { totalPages: pages.length },
        bookmarks: titles.map((title, index) => ({
          depth: 0,
          title,
          pageIndex: 1 + index * 2,
          top: 560,
          fitsPage: false,
        })),
      });
      assert.equal(structure?.source, "bookmarks");
      assert.deepEqual(
        outline(structure).map((row) => [row.title, ...row.pages]),
        [
          [BEFORE_FIRST_SECTION_TITLE, 0, 0],
          ["第一章 绪论", 1, 2],
          ["第二章 文献综述", 3, 4],
          ["第三章 研究方法", 5, 6],
        ],
      );
    });
  });
});
