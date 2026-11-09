/**
 * Small page-text excerpts, as Zotero's PDF worker extracts them (one line
 * per paragraph; pages joined by form feeds), cut to their first lines.
 *
 * Sources, both licensed CC BY 4.0:
 * - Hadi Vafaii, "Unveiling Secrets of Brain Function with Generative
 *   Modeling" (PhD dissertation, arXiv:2412.19845).
 * - Rose M. Spielman, William J. Jenkins, Marilyn D. Lovett, "Psychology 2e"
 *   (OpenStax, Rice University), https://openstax.org/details/books/psychology-2e.
 */

/** Dissertation pages (no bookmarks): chapters open pages as "Chapter N:Title". */
export const DISSERTATION_PAGES: string[][] = [
  [
    "ABSTRACT",
    "Title of Dissertation: Unveiling Secrets of Brain Function with Generative Modeling:",
    "Motion Perception in Primates & Cortical Network Organization in Mice",
  ],
  [
    "Preface",
    "I was admitted to the University of Maryland to work on condensed matter physics and",
  ],
  [
    "Chapter 1:Introduction",
    "This Dissertation is composed of two projects. The first project is about the problem of",
    "1.9to1.13are related to the second project. The rest of the chapter is background.",
  ],
  [
    "inference, derive the VAE loss function, and explore some other details related to VAEs.",
    "Variational inference is a statistical framework that has found application in a wide variety",
  ],
  [
    "1.1Visual processing and representations in the brain",
    "For millennia, humans have sought to understand the connection between the world we",
  ],
  [
    "ab",
    "Figure 1.1: Receptive field integration in visual neurons. (a) A mechanistic model depicting how orientation-s",
    "1.2Hierarchical architecture of the visual cortex",
    "layer 4) of region A, region B is described as having “feedback” connections to region A. In a",
  ],
  [
    "Chapter 2:Philosophical and historical background",
    "2.1The relationship between perception and reality",
    "Does the human mind have access to the world out there, in its entirety? This question has",
    "2.1.1Plato and the Allegory of the Cave",
  ],
  [
    "Figure 2.1: Plato’s “Allegory of the Cave” explores the idea that human perception may not unveil the full sco",
    "2.1.2Ibn Al-Haytham and subjectivity of perception",
    "Fast-forwarding some 1400 years, we encounter Ibn Al-Haytham, also known as Alhazen,",
  ],
  [
    "Chapter 3:Variational Inference & Variational Autoencoders (VAE)",
    "In this Dissertation, we assume a subjective Bayesian interpretation of probabilities. As",
  ],
  [
    "Most notably, both lines of research aim to model the data using latent variables and",
    "variational inference, where the ultimate goal is to learn a generative model of the observations.",
  ],
];

/**
 * Book pages, text as extracted: a chapter's number and title come last on
 * its opening page (the page opens with a figure caption), and two blank
 * cover pages precede them in the PDF, so the extracted text lost them.
 */
export const BOOK_PAGES: string[][] = [
  ["CONTENTS", "Preface 1", "States of Consciousness 109"],
  [
    "Preface",
    "Welcome to Psychology2e, an OpenStax resource. This textbook was written to increase student access to high-qu",
  ],
  [
    'FIGURE 1.1 Psychology is the scientific study of mind and behavior. (credit "background": modification of work',
    "INTRODUCTION",
    "CHAPTER OUTLINE",
    "1",
    "Introduction to Psychology",
  ],
  [
    "psychology has explored these questions.",
    "1.1 What Is Psychology?",
    "8 1 • Introduction to Psychology",
    "Access for free at openstax.org",
  ],
  [
    "FIGURE 2.1 How does television content impact children’s behavior? (credit: modification of work by",
    "“antisocialtory”/Flickr)",
    "2",
    "Psychological Research",
  ],
  [
    "2.1 Why Is Research Important?",
    "LEARNING OBJECTIVES",
    "36 2 • Psychological Research",
    "Access for free at openstax.org",
  ],
];

/** Blank pages before `BOOK_PAGES` in the PDF. */
export const BOOK_LEADING_BLANK_PAGES = 2;

/** The book's bookmarks, as the PDF lists them (0-based PDF pages, `/XYZ` tops). */
export const BOOK_BOOKMARKS = [
  { depth: 0, title: "Contents", pageIndex: 2, top: 734, fitsPage: false },
  { depth: 0, title: "Preface", pageIndex: 3, top: 734, fitsPage: false },
  {
    depth: 0,
    title: "Chapter 1 Introduction to Psychology",
    pageIndex: 4,
    top: 745,
    fitsPage: false,
  },
  {
    depth: 1,
    title: "Chapter Outline",
    pageIndex: 4,
    top: 295,
    fitsPage: false,
  },
  { depth: 1, title: "Introduction", pageIndex: 4, top: 210, fitsPage: false },
  {
    depth: 1,
    title: "1.1 What Is Psychology?",
    pageIndex: 5,
    top: 715,
    fitsPage: false,
  },
  {
    depth: 0,
    title: "Chapter 2 Psychological Research",
    pageIndex: 6,
    top: 745,
    fitsPage: false,
  },
  {
    depth: 1,
    title: "2.1 Why Is Research Important?",
    pageIndex: 7,
    top: 734,
    fitsPage: false,
  },
];

/** Pages joined as Zotero's PDF worker joins them: blank line, form feed. */
export function joinPages(pages: string[][]): string {
  return pages
    .map((lines) => `${lines.join("\n")}\n\n`)
    .join("\f")
    .trim();
}
