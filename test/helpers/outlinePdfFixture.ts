import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  StandardFonts,
  type PDFRef,
} from "pdf-lib";

/** One bookmark of a generated PDF; `named` routes it through `/Names /Dests`. */
export type OutlineFixtureEntry = {
  title: string;
  /** 0-based page the bookmark opens. */
  page: number;
  /** `/XYZ` top; omitted for a `/Fit` destination. */
  top?: number;
  named?: boolean;
  /** Write the title as a literal string (PDFDocEncoding), not UTF-16 hex. */
  literal?: boolean;
  children?: OutlineFixtureEntry[];
};

export const OUTLINE_FIXTURE_PAGE_HEIGHT = 600;
const LINE_HEIGHT = 16;
/** Space above a page's first line. */
const TOP_MARGIN = 40;

/**
 * A text PDF built with pdf-lib: one page per entry of `pages`, each line
 * drawn top-down as its own paragraph, with the given bookmarks.
 */
export async function createPdfWithOutline(params: {
  pages: string[][];
  outline?: OutlineFixtureEntry[];
  /** Taller pages hold more lines; the default is `OUTLINE_FIXTURE_PAGE_HEIGHT`. */
  pageHeight?: number;
}): Promise<Uint8Array> {
  const pageHeight = params.pageHeight ?? OUTLINE_FIXTURE_PAGE_HEIGHT;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = params.pages.map((lines) => {
    const page = doc.addPage([420, pageHeight]);
    lines.forEach((line, index) =>
      page.drawText(line, {
        x: 40,
        y: pageHeight - TOP_MARGIN - index * LINE_HEIGHT * 2,
        size: 11,
        font,
      }),
    );
    return page;
  });
  const context = doc.context;
  const outline = params.outline || [];
  if (!outline.length) return doc.save();
  const named: Array<[string, unknown]> = [];
  const destOf = (entry: OutlineFixtureEntry) => {
    const pageRef = pages[entry.page].ref;
    const array =
      entry.top === undefined
        ? context.obj([pageRef, "Fit"])
        : context.obj([pageRef, "XYZ", 0, entry.top, null]);
    if (!entry.named) return array;
    const key = `dest-${named.length}`;
    named.push([key, array]);
    return PDFString.of(key);
  };
  const build = (entries: OutlineFixtureEntry[], parent: PDFRef): PDFRef[] => {
    const refs = entries.map(() => context.nextRef());
    entries.forEach((entry, index) => {
      const dict = context.obj({
        Title: entry.literal
          ? PDFString.of(entry.title)
          : PDFHexString.fromText(entry.title),
        Parent: parent,
        Dest: destOf(entry),
      });
      if (index > 0) dict.set(PDFName.of("Prev"), refs[index - 1]);
      if (index + 1 < refs.length)
        dict.set(PDFName.of("Next"), refs[index + 1]);
      const children = build(entry.children || [], refs[index]);
      if (children.length) {
        dict.set(PDFName.of("First"), children[0]);
        dict.set(PDFName.of("Last"), children[children.length - 1]);
        dict.set(PDFName.of("Count"), context.obj(children.length));
      }
      context.assign(refs[index], dict);
    });
    return refs;
  };
  const outlinesRef = context.nextRef();
  const top = build(outline, outlinesRef);
  context.assign(
    outlinesRef,
    context.obj({
      Type: "Outlines",
      First: top[0],
      Last: top[top.length - 1],
      Count: top.length,
    }),
  );
  doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
  if (named.length) {
    const flat: unknown[] = [];
    for (const [key, array] of named.sort(([a], [b]) => a.localeCompare(b)))
      flat.push(PDFString.of(key), array);
    doc.catalog.set(
      PDFName.of("Names"),
      context.obj({ Dests: context.obj({ Names: flat as never }) }),
    );
  }
  return doc.save();
}
