import { imageObjectToCanvas, type PdfjsImageObject } from "./imageObject";
import {
  PDFJS_DOCUMENT_OPTIONS,
  resolvePdfjsImageObject,
  tryPdfjsStrategies,
} from "./pdfjsLoader";

type SpikeMatrix = [number, number, number, number, number, number];

type FormSummary = { widthPt: number; heightPt: number; pageSharePct: number };

export type PdfImageSpikeReport = {
  strategy?: string;
  strategyErrors: Record<string, string>;
  pdfjsVersion?: string;
  filePath?: string;
  numPages?: number;
  pages: Array<{
    pageNumber: number;
    imageDraws: number;
    /** Every image-painting operator on the page, by pdf.js OPS name. */
    imageOps?: Record<string, number>;
    /** Form XObjects painted on the page, largest first (top 6). */
    forms?: { count: number; largest: FormSummary[] };
    /** `<Figure>` nodes in the tagged-PDF structure tree; null if untagged. */
    structFigures?: number | null;
    firstImage?: {
      objId: string;
      width?: number;
      height?: number;
      shape: "bitmap" | "data" | "unresolved" | "unknown";
      kind?: number;
      pngBytes?: number;
    };
    textItems: number;
    sampleText: string[];
  }>;
  error?: string;
};

function multiply(m1: SpikeMatrix, m2: SpikeMatrix): SpikeMatrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function asNumbers(value: unknown, length: number): number[] | null {
  if (!value || typeof (value as ArrayLike<number>).length !== "number") {
    return null;
  }
  const list = Array.from(value as ArrayLike<unknown>);
  return list.length === length &&
    list.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? (list as number[])
    : null;
}

/** Size of a form's BBox after the current transform, in PDF points. */
function formSize(ctm: SpikeMatrix, bbox: number[]): { w: number; h: number } {
  const [x1, y1, x2, y2] = bbox;
  const corners = [
    [x1, y1],
    [x2, y1],
    [x1, y2],
    [x2, y2],
  ].map(([x, y]) => [
    ctm[0] * x + ctm[2] * y + ctm[4],
    ctm[1] * x + ctm[3] * y + ctm[5],
  ]);
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return {
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

function countFigureNodes(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const record = node as { role?: unknown; children?: unknown };
  const own = record.role === "Figure" ? 1 : 0;
  const children = Array.isArray(record.children) ? record.children : [];
  return (
    own + children.reduce((sum, child) => sum + countFigureNodes(child), 0)
  );
}

/**
 * Temporary diagnostic for the pdf.js feasibility check. Run in Zotero:
 * Tools → Developer → Run JavaScript (as async function):
 *   return JSON.stringify(await Zotero.LLMForZotero.api.pdfImageSpike(<attachmentID>), null, 2)
 */
export async function runPdfImageSpike(
  attachmentId: number,
  maxPages = 5,
): Promise<PdfImageSpikeReport> {
  const report: PdfImageSpikeReport = { strategyErrors: {}, pages: [] };
  try {
    const { loaded, errors } = await tryPdfjsStrategies();
    report.strategyErrors = errors;
    if (!loaded) throw new Error("no strategy loaded pdf.js");
    report.strategy = loaded.strategy;
    report.pdfjsVersion = loaded.pdfjs.version;

    const item = Zotero.Items.get(attachmentId);
    const path = await (
      item as unknown as { getFilePathAsync?: () => Promise<string | false> }
    ).getFilePathAsync?.();
    if (!path) throw new Error("attachment has no local file");
    report.filePath = path;
    const bytes = await IOUtils.read(path);

    const doc = await loaded.pdfjs.getDocument({
      data: bytes,
      ...PDFJS_DOCUMENT_OPTIONS,
    }).promise;
    report.numPages = doc.numPages;
    const OPS = loaded.pdfjs.OPS;
    const paintImage = OPS.paintImageXObject;
    const imageOpNames = new Map(
      Object.entries(OPS)
        .filter(([name]) => /image/i.test(name))
        .map(([name, code]) => [code, name] as const),
    );
    const win = Zotero.getMainWindow();
    try {
      for (let n = 1; n <= Math.min(maxPages, doc.numPages); n += 1) {
        const page = await doc.getPage(n);
        const opList = await page.getOperatorList();
        const view = asNumbers((page as unknown as { view?: unknown }).view, 4);
        const pageArea = view
          ? Math.abs((view[2] - view[0]) * (view[3] - view[1]))
          : 0;

        const imageArgs: unknown[][] = [];
        const imageOps: Record<string, number> = {};
        const forms: FormSummary[] = [];
        let ctm: SpikeMatrix = [1, 0, 0, 1, 0, 0];
        const stack: SpikeMatrix[] = [];
        opList.fnArray.forEach((fn, index) => {
          const args = (opList.argsArray[index] as unknown[] | null) || [];
          const imageName = imageOpNames.get(fn);
          if (imageName) imageOps[imageName] = (imageOps[imageName] || 0) + 1;
          if (fn === paintImage) imageArgs.push(args);
          if (fn === OPS.save) {
            stack.push(ctm);
          } else if (fn === OPS.restore) {
            ctm = stack.pop() ?? ctm;
          } else if (fn === OPS.transform) {
            const matrix = asNumbers(args, 6);
            if (matrix) ctm = multiply(ctm, matrix as SpikeMatrix);
          } else if (fn === OPS.paintFormXObjectBegin) {
            stack.push(ctm);
            const matrix = asNumbers(args[0], 6);
            if (matrix) ctm = multiply(ctm, matrix as SpikeMatrix);
            const bbox = asNumbers(args[1], 4);
            if (bbox) {
              const { w, h } = formSize(ctm, bbox);
              forms.push({
                widthPt: Math.round(w),
                heightPt: Math.round(h),
                pageSharePct: pageArea
                  ? Math.round(((w * h) / pageArea) * 1000) / 10
                  : 0,
              });
            }
          } else if (fn === OPS.paintFormXObjectEnd) {
            ctm = stack.pop() ?? ctm;
          }
        });

        let structFigures: number | null = null;
        try {
          const tree = await (
            page as unknown as { getStructTree?: () => Promise<unknown> }
          ).getStructTree?.();
          structFigures = tree ? countFigureNodes(tree) : null;
        } catch {
          structFigures = null;
        }

        const text = await page.getTextContent();
        const entry: PdfImageSpikeReport["pages"][number] = {
          pageNumber: n,
          imageDraws: imageArgs.length,
          ...(Object.keys(imageOps).length ? { imageOps } : {}),
          ...(forms.length
            ? {
                forms: {
                  count: forms.length,
                  largest: [...forms]
                    .sort((a, b) => b.pageSharePct - a.pageSharePct)
                    .slice(0, 6),
                },
              }
            : {}),
          structFigures,
          textItems: text.items.length,
          sampleText: text.items
            .map((item) => ("str" in item ? item.str : ""))
            .filter(Boolean)
            .slice(0, 3),
        };
        const objId = imageArgs[0]?.[0];
        if (typeof objId === "string") {
          const obj = resolvePdfjsImageObject(
            page,
            objId,
          ) as PdfjsImageObject | null;
          const shape = !obj
            ? "unresolved"
            : obj.bitmap
              ? "bitmap"
              : obj.data
                ? "data"
                : "unknown";
          const canvas = obj ? imageObjectToCanvas(win.document, obj) : null;
          entry.firstImage = {
            objId,
            width: obj?.width,
            height: obj?.height,
            shape,
            kind: obj?.kind,
            pngBytes: canvas?.toDataURL("image/png").length,
          };
        }
        report.pages.push(entry);
        page.cleanup?.();
      }
    } finally {
      await doc.destroy?.();
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  return report;
}
