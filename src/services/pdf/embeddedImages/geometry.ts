import type { OPS, Util } from "pdfjs-dist";

/** pdf.js rectangle order in PDF user space: [minX, minY, maxX, maxY]. */
export type Rect = [number, number, number, number];

type Transform = [number, number, number, number, number, number];

/** The pdf.js geometry helpers used here; the loaded module's `Util`. */
export type PdfjsUtil = Pick<
  typeof Util,
  "transform" | "axialAlignedBoundingBox" | "rectBoundingBox" | "intersect"
>;

export type OperatorCodes = Pick<
  typeof OPS,
  | "save"
  | "restore"
  | "transform"
  | "paintImageXObject"
  | "paintFormXObjectBegin"
  | "paintFormXObjectEnd"
  | "constructPath"
  | "endPath"
  | "beginMarkedContent"
  | "beginMarkedContentProps"
  | "endMarkedContent"
>;

export type ImageDrawOp = { objId: string; rect: Rect };

/** A painted path and the marked-content ids open while it was drawn. */
export type PathBox = { rect: Rect; mcids: number[] };

export type PageGraphics = {
  images: ImageDrawOp[];
  paths: PathBox[];
  /** Form XObject BBoxes on the page. */
  forms: Rect[];
  /** Union of everything drawn inside each marked-content id (MCID). */
  mcidRects: Map<number, Rect>;
};

const IDENTITY: Transform = [1, 0, 0, 1, 0, 0];
const UNIT_SQUARE = [0, 0, 1, 1];

function numbers(value: unknown, length: number): number[] | null {
  if (!value || typeof (value as ArrayLike<number>).length !== "number") {
    return null;
  }
  const list = Array.from(value as ArrayLike<unknown>);
  if (list.length !== length) return null;
  return list.every(
    (entry) => typeof entry === "number" && Number.isFinite(entry),
  )
    ? (list as number[])
    : null;
}

function emptyRect(): Rect {
  return [Infinity, Infinity, -Infinity, -Infinity];
}

/** Bounds of `rect` after `transform`, via pdf.js. */
function transformedBounds(
  util: PdfjsUtil,
  rect: ArrayLike<number>,
  transform: Transform,
): Rect {
  const out = emptyRect();
  util.axialAlignedBoundingBox(rect, transform, out);
  return out;
}

/** `rect` merged into `target` (a new array), via pdf.js. */
export function unionRect(
  util: PdfjsUtil,
  target: Rect | undefined,
  rect: Rect,
): Rect {
  const out: Rect = target ? [...target] : emptyRect();
  util.rectBoundingBox(rect[0], rect[1], rect[2], rect[3], out);
  return out;
}

/**
 * Walks a pdf.js operator list once and returns where images, painted paths
 * and form XObjects land on the page, plus what each marked-content id holds.
 */
export function analyzeOperatorList(
  opList: { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> },
  ops: OperatorCodes,
  util: PdfjsUtil,
): PageGraphics {
  let ctm: Transform = IDENTITY;
  const stack: Transform[] = [];
  const markedContent: Array<number | null> = [];
  const graphics: PageGraphics = {
    images: [],
    paths: [],
    forms: [],
    mcidRects: new Map(),
  };
  const openMcids = () =>
    markedContent.filter((id): id is number => id !== null);
  const record = (rect: Rect) => {
    for (const mcid of openMcids()) {
      graphics.mcidRects.set(
        mcid,
        unionRect(util, graphics.mcidRects.get(mcid), rect),
      );
    }
  };
  const apply = (matrix: number[] | null) => {
    if (matrix) ctm = util.transform(ctm, matrix) as Transform;
  };

  const { fnArray, argsArray } = opList;
  for (let index = 0; index < fnArray.length; index += 1) {
    const fn = fnArray[index];
    const args = (argsArray[index] as unknown[] | null) || [];
    switch (fn) {
      case ops.save:
        stack.push(ctm);
        break;
      case ops.restore:
        ctm = stack.pop() ?? ctm;
        break;
      case ops.transform:
        apply(numbers(args, 6));
        break;
      case ops.paintFormXObjectBegin: {
        stack.push(ctm);
        apply(numbers(args[0], 6));
        const bbox = numbers(args[1], 4);
        if (bbox) graphics.forms.push(transformedBounds(util, bbox, ctm));
        break;
      }
      case ops.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm;
        break;
      case ops.paintImageXObject: {
        const objId = args[0];
        if (typeof objId !== "string") break;
        const rect = transformedBounds(util, UNIT_SQUARE, ctm);
        graphics.images.push({ objId, rect });
        record(rect);
        break;
      }
      case ops.constructPath: {
        // endPath only sets a clip; nothing is painted.
        if (args[0] === ops.endPath) break;
        const minMax = numbers(args[2], 4);
        if (!minMax || minMax[0] > minMax[2] || minMax[1] > minMax[3]) break;
        const rect = transformedBounds(util, minMax, ctm);
        graphics.paths.push({ rect, mcids: openMcids() });
        record(rect);
        break;
      }
      case ops.beginMarkedContent:
        markedContent.push(null);
        break;
      case ops.beginMarkedContentProps: {
        const mcid = args[1];
        markedContent.push(
          typeof mcid === "number" && Number.isInteger(mcid) ? mcid : null,
        );
        break;
      }
      case ops.endMarkedContent:
        markedContent.pop();
        break;
    }
  }
  return graphics;
}
