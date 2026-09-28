import {
  unionRect,
  type PageGraphics,
  type PdfjsUtil,
  type Rect,
} from "./geometry";

export type StructFigure = { mcids: number[]; alt?: string; bbox?: Rect };

export type VectorRegionLayer = "tagged" | "form" | "cluster";

export type VectorRegion = {
  rect: Rect;
  layer: VectorRegionLayer;
  alt?: string;
};

export type VectorRegionLimits = {
  minSidePt: number;
  minPageShare: number;
  maxPageShare: number;
  clusterGapPt: number;
  minClusterPaths: number;
  padPt: number;
  maxRegionsPerPage: number;
  rasterCoverageSkip: number;
  overlapSkip: number;
};

export const VECTOR_REGION_LIMITS: VectorRegionLimits = {
  minSidePt: 36,
  minPageShare: 0.02,
  maxPageShare: 0.9,
  clusterGapPt: 12,
  minClusterPaths: 4,
  padPt: 12,
  maxRegionsPerPage: 6,
  rasterCoverageSkip: 0.5,
  overlapSkip: 0.5,
};

const MCID_SUFFIX = /_mc(\d+)$/;

const width = (r: Rect) => r[2] - r[0];
const height = (r: Rect) => r[3] - r[1];
const area = (r: Rect) => Math.max(0, width(r)) * Math.max(0, height(r));
const pad = (r: Rect, d: number): Rect => [
  r[0] - d,
  r[1] - d,
  r[2] + d,
  r[3] + d,
];

function toRect(value: unknown): Rect | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  if (!value.every((v) => typeof v === "number" && Number.isFinite(v))) {
    return undefined;
  }
  const [x1, y1, x2, y2] = value as number[];
  return [
    Math.min(x1, x2),
    Math.min(y1, y2),
    Math.max(x1, x2),
    Math.max(y1, y2),
  ];
}

type StructNode = {
  role?: unknown;
  type?: unknown;
  id?: unknown;
  alt?: unknown;
  bbox?: unknown;
  children?: unknown;
};

function childrenOf(node: StructNode): StructNode[] {
  return Array.isArray(node.children) ? (node.children as StructNode[]) : [];
}

function collectMcids(node: StructNode, out: number[]): void {
  for (const child of childrenOf(node)) {
    if (!child || typeof child !== "object") continue;
    if (child.type === "content" && typeof child.id === "string") {
      const match = MCID_SUFFIX.exec(child.id);
      if (match) out.push(Number(match[1]));
    } else if (child.role !== undefined) {
      collectMcids(child, out);
    }
  }
}

/** Figure elements of a page's tagged-PDF structure tree (`getStructTree`). */
export function collectStructFigures(tree: unknown): StructFigure[] {
  const figures: StructFigure[] = [];
  const walk = (node: StructNode | null | undefined) => {
    if (!node || typeof node !== "object") return;
    if (node.role === "Figure") {
      const mcids: number[] = [];
      collectMcids(node, mcids);
      const bbox = toRect(node.bbox);
      const alt = typeof node.alt === "string" ? node.alt.trim() : "";
      figures.push({
        mcids,
        ...(alt ? { alt } : {}),
        ...(bbox ? { bbox } : {}),
      });
    }
    for (const child of childrenOf(node)) walk(child);
  };
  walk(tree as StructNode);
  return figures;
}

function gapTouches(a: Rect, b: Rect, gap: number): boolean {
  return (
    a[0] - gap <= b[2] &&
    b[0] - gap <= a[2] &&
    a[1] - gap <= b[3] &&
    b[1] - gap <= a[3]
  );
}

/** Merges boxes whose gap is at most `gap`, until nothing changes. */
export function clusterRects(
  rects: Rect[],
  gap: number,
  util: PdfjsUtil,
): Array<{ rect: Rect; count: number }> {
  let clusters = rects.map((rect) => ({ rect, count: 1 }));
  let merged = true;
  while (merged) {
    merged = false;
    const next: Array<{ rect: Rect; count: number }> = [];
    for (const cluster of clusters) {
      const target = next.find((candidate) =>
        gapTouches(candidate.rect, cluster.rect, gap),
      );
      if (target) {
        target.rect = unionRect(util, target.rect, cluster.rect);
        target.count += cluster.count;
        merged = true;
      } else {
        next.push({ ...cluster });
      }
    }
    clusters = next;
  }
  return clusters;
}

/**
 * Vector figure regions of one page, in three layers: tagged `<Figure>`
 * elements, form XObjects, then clusters of the remaining loose paths.
 */
export function findVectorRegions(params: {
  graphics: PageGraphics;
  figures: StructFigure[];
  page: Rect;
  util: PdfjsUtil;
  limits?: VectorRegionLimits;
}): VectorRegion[] {
  const { graphics, page, util } = params;
  const limits = params.limits ?? VECTOR_REGION_LIMITS;
  const pageArea = area(page);
  if (!pageArea) return [];
  const accepted: VectorRegion[] = [];

  const overlapArea = (a: Rect, b: Rect) => {
    const shared = util.intersect(a, b);
    return shared ? area(shared as Rect) : 0;
  };
  const sizeOk = (r: Rect) => {
    const share = area(r) / pageArea;
    return (
      width(r) >= limits.minSidePt &&
      height(r) >= limits.minSidePt &&
      share >= limits.minPageShare &&
      share <= limits.maxPageShare
    );
  };
  const rasterCovered = (r: Rect) =>
    graphics.images.reduce(
      (sum, image) => sum + overlapArea(image.rect, r),
      0,
    ) /
      area(r) >=
    limits.rasterCoverageSkip;
  const overlapsAccepted = (r: Rect) =>
    accepted.some(
      (region) => overlapArea(region.rect, r) / area(r) >= limits.overlapSkip,
    );
  const consider = (rect: Rect, layer: VectorRegionLayer, alt?: string) => {
    const clipped = util.intersect(rect, page) as Rect | null;
    if (!clipped || !sizeOk(clipped)) return;
    if (rasterCovered(clipped) || overlapsAccepted(clipped)) return;
    accepted.push({ rect: clipped, layer, ...(alt ? { alt } : {}) });
  };
  const holdsCenter = (outer: Rect, inner: Rect) => {
    const x = (inner[0] + inner[2]) / 2;
    const y = (inner[1] + inner[3]) / 2;
    return x >= outer[0] && x <= outer[2] && y >= outer[1] && y <= outer[3];
  };

  for (const figure of params.figures) {
    if (figure.bbox) {
      consider(figure.bbox, "tagged", figure.alt);
      continue;
    }
    let union: Rect | undefined;
    for (const mcid of figure.mcids) {
      const rect = graphics.mcidRects.get(mcid);
      if (rect) union = unionRect(util, union, rect);
    }
    if (union) consider(pad(union, limits.padPt), "tagged", figure.alt);
  }

  for (const form of graphics.forms) consider(form, "form");

  const loose = graphics.paths
    .map((path) => path.rect)
    .filter(
      (r) =>
        area(r) / pageArea < limits.maxPageShare &&
        !accepted.some((region) => holdsCenter(region.rect, r)),
    );
  for (const cluster of clusterRects(loose, limits.clusterGapPt, util)) {
    if (cluster.count < limits.minClusterPaths) continue;
    consider(pad(cluster.rect, limits.padPt), "cluster");
  }

  return accepted
    .sort((a, b) => area(b.rect) - area(a.rect))
    .slice(0, limits.maxRegionsPerPage);
}
