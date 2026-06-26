export type PdfFigureRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type PdfFigureBox = PdfFigureRect & {
  role?: "image" | "ink" | "text" | "path" | "form";
  text?: string;
};

export type PdfFigurePageGeometry = {
  pageNumber: number;
  width: number;
  height: number;
  textBoxes: PdfFigureBox[];
  imageBoxes: PdfFigureBox[];
  inkBoxes: PdfFigureBox[];
  regionBoxes?: PdfFigureBox[];
};

export type PdfFigureTarget = {
  label: string;
  pageNumber: number;
  captionText?: string;
  captionBox?: PdfFigureRect;
  visualBox?: PdfFigureRect;
  visualAspectRatio?: number;
};

export type PdfFigureCandidateSource =
  | "pdf-image-object"
  | "mineru-layout-region"
  | "caption-bounded-region"
  | "rendered-ink"
  | "pdf-vector-object";

export type PdfFigureCropCandidate = {
  source: PdfFigureCandidateSource;
  rect: PdfFigureRect;
  confidence: number;
  reasons: string[];
  warnings: string[];
};

export type PdfFigureCropResult = {
  target: PdfFigureTarget;
  best: PdfFigureCropCandidate | null;
  candidates: PdfFigureCropCandidate[];
};

type ScoredRect = {
  rect: PdfFigureRect;
  boxes: PdfFigureBox[];
  source: PdfFigureCandidateSource;
  reasons: string[];
  warnings?: string[];
};

const MIN_BOX_EDGE = 18;
const MIN_VISUAL_AREA_RATIO = 0.0015;

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function normalizeRect(rect: PdfFigureRect): PdfFigureRect {
  const left = finiteNumber(rect.left);
  const top = finiteNumber(rect.top);
  const width = Math.max(0, finiteNumber(rect.width));
  const height = Math.max(0, finiteNumber(rect.height));
  return { left, top, width, height };
}

function rectRight(rect: PdfFigureRect): number {
  return rect.left + rect.width;
}

function rectBottom(rect: PdfFigureRect): number {
  return rect.top + rect.height;
}

function rectArea(rect: PdfFigureRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function intersectArea(left: PdfFigureRect, right: PdfFigureRect): number {
  const x1 = Math.max(left.left, right.left);
  const y1 = Math.max(left.top, right.top);
  const x2 = Math.min(rectRight(left), rectRight(right));
  const y2 = Math.min(rectBottom(left), rectBottom(right));
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function horizontalOverlapRatio(
  left: PdfFigureRect,
  right: PdfFigureRect,
): number {
  const overlap =
    Math.min(rectRight(left), rectRight(right)) -
    Math.max(left.left, right.left);
  return Math.max(0, overlap) / Math.max(1, Math.min(left.width, right.width));
}

function verticalGap(left: PdfFigureRect, right: PdfFigureRect): number {
  if (rectBottom(left) < right.top) return right.top - rectBottom(left);
  if (rectBottom(right) < left.top) return left.top - rectBottom(right);
  return 0;
}

function unionRects(rects: PdfFigureRect[]): PdfFigureRect {
  const normalized = rects
    .map(normalizeRect)
    .filter((rect) => rectArea(rect) > 0);
  if (!normalized.length) return { left: 0, top: 0, width: 0, height: 0 };
  const left = Math.min(...normalized.map((rect) => rect.left));
  const top = Math.min(...normalized.map((rect) => rect.top));
  const right = Math.max(...normalized.map(rectRight));
  const bottom = Math.max(...normalized.map(rectBottom));
  return { left, top, width: right - left, height: bottom - top };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function isPageFurniture(
  box: PdfFigureBox,
  page: PdfFigurePageGeometry,
): boolean {
  const widthRatio = box.width / Math.max(1, page.width);
  const heightRatio = box.height / Math.max(1, page.height);
  const areaRatio = rectArea(box) / Math.max(1, page.width * page.height);
  return (
    (widthRatio < 0.08 && heightRatio > 0.45) ||
    areaRatio < MIN_VISUAL_AREA_RATIO ||
    box.width < MIN_BOX_EDGE ||
    box.height < MIN_BOX_EDGE
  );
}

function isCaptionTextBox(box: PdfFigureBox, target: PdfFigureTarget): boolean {
  if (target.captionBox && intersectArea(box, target.captionBox) > 0) {
    return true;
  }
  const text = `${box.text || ""}`.trim();
  if (!text) return false;
  const normalizedLabel = target.label
    .replace(/\bfig(?:ure)?\.?/i, "fig")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const normalizedText = text
    .replace(/\bfig(?:ure)?\.?/i, "fig")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return normalizedText.includes(normalizedLabel);
}

function looksLikePageHeaderText(text: string | undefined): boolean {
  const normalized = `${text || ""}`.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized) return true;
  return [
    "article",
    "research article",
    "open access",
    "cellpress",
    "cell press",
    "neuron",
    "nature",
    "science",
    "downloaded from",
    "https://",
    "doi.org",
  ].some((term) => normalized.includes(term));
}

function hasTopFigureEvidence(
  rect: PdfFigureRect,
  headerFloor: number,
  page: PdfFigurePageGeometry,
  target: PdfFigureTarget,
): boolean {
  const topBandHeight = headerFloor - rect.top;
  if (topBandHeight <= 0) return false;
  const topBand = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: topBandHeight,
  };
  const textBoxes = page.textBoxes.filter((box) => {
    if (isCaptionTextBox(box, target)) return false;
    if (looksLikePageHeaderText(box.text)) return false;
    return intersectArea(box, topBand) / Math.max(1, rectArea(box)) >= 0.35;
  });
  if (textBoxes.length >= 5) return true;
  const textArea = textBoxes.reduce(
    (sum, box) => sum + intersectArea(box, topBand),
    0,
  );
  if (textArea / Math.max(1, rectArea(topBand)) >= 0.012) return true;
  const imageArea = page.imageBoxes
    .filter((box) => !isPageFurniture(box, page))
    .reduce((sum, box) => sum + intersectArea(box, topBand), 0);
  return imageArea / Math.max(1, rectArea(topBand)) >= 0.012;
}

function isParagraphLikeBox(box: PdfFigureBox, rect: PdfFigureRect): boolean {
  const text = `${box.text || ""}`.trim();
  return text.length >= 38 || box.width >= Math.min(240, rect.width * 0.34);
}

function trimLeadingParagraphText(
  rect: PdfFigureRect,
  page: PdfFigurePageGeometry,
  target: PdfFigureTarget,
): PdfFigureRect {
  const paragraphBoxes = page.textBoxes.filter((box) => {
    if (isCaptionTextBox(box, target)) return false;
    if (!isParagraphLikeBox(box, rect)) return false;
    if (box.top >= rect.top + rect.height * 0.35) return false;
    return intersectArea(box, rect) / Math.max(1, rectArea(box)) >= 0.65;
  });
  if (paragraphBoxes.length < 4) return rect;
  const top = Math.max(...paragraphBoxes.map(rectBottom)) + 6;
  if (rectBottom(rect) - top < Math.max(48, page.height * 0.12)) {
    return rect;
  }
  return normalizeRect({
    left: rect.left,
    top,
    width: rect.width,
    height: rectBottom(rect) - top,
  });
}

function refineCaptionBoundedRegionRect(
  rect: PdfFigureRect,
  page: PdfFigurePageGeometry,
  target: PdfFigureTarget,
): { rect: PdfFigureRect; warnings: string[] } {
  const warnings: string[] = [];
  let refined = normalizeRect(rect);
  const headerFloor = page.height * 0.11;
  const headerProbe = {
    left: refined.left,
    top: 0,
    width: refined.width,
    height: headerFloor + 8,
  };
  const hasHeaderText = page.textBoxes.some(
    (box) =>
      !isCaptionTextBox(box, target) && intersectArea(box, headerProbe) > 0,
  );
  if (
    hasHeaderText &&
    refined.top < headerFloor &&
    rectBottom(refined) - headerFloor >= page.height * 0.08 &&
    !hasTopFigureEvidence(refined, headerFloor, page, target)
  ) {
    refined = normalizeRect({
      left: refined.left,
      top: headerFloor,
      width: refined.width,
      height: rectBottom(refined) - headerFloor,
    });
    warnings.push("trimmed page header band");
  }
  const paragraphTrimmed = trimLeadingParagraphText(refined, page, target);
  if (
    paragraphTrimmed.top !== refined.top ||
    paragraphTrimmed.height !== refined.height
  ) {
    refined = paragraphTrimmed;
    warnings.push("trimmed leading paragraph text");
  }
  return { rect: refined, warnings };
}

function textOverlapRatio(
  rect: PdfFigureRect,
  page: PdfFigurePageGeometry,
  target: PdfFigureTarget,
): number {
  const area = Math.max(1, rectArea(rect));
  let overlap = 0;
  for (const box of page.textBoxes) {
    if (isCaptionTextBox(box, target)) continue;
    overlap += intersectArea(rect, box);
  }
  return overlap / area;
}

function paragraphTextOverlapRatio(
  rect: PdfFigureRect,
  page: PdfFigurePageGeometry,
  target: PdfFigureTarget,
): number {
  const area = Math.max(1, rectArea(rect));
  let overlap = 0;
  for (const box of page.textBoxes) {
    if (isCaptionTextBox(box, target)) continue;
    const text = `${box.text || ""}`.trim();
    const looksLikeParagraph =
      text.length >= 38 || box.width >= Math.min(240, rect.width * 0.34);
    if (!looksLikeParagraph || box.height > 32) continue;
    const boxOverlap = intersectArea(rect, box);
    if (boxOverlap / Math.max(1, rectArea(box)) < 0.65) continue;
    overlap += boxOverlap;
  }
  return overlap / area;
}

function captionDistanceScore(
  rect: PdfFigureRect,
  captionBox: PdfFigureRect | undefined,
  page: PdfFigurePageGeometry,
): { score: number; reasons: string[] } {
  if (!captionBox) {
    return { score: 0.04, reasons: ["no caption geometry"] };
  }
  const gap = verticalGap(rect, captionBox);
  const gapRatio = gap / Math.max(1, page.height);
  const horizontalOverlap = horizontalOverlapRatio(rect, captionBox);
  const reasons: string[] = [];
  let score = 0;
  if (gapRatio <= 0.04) {
    score += 0.18;
    reasons.push("touches caption band");
  } else if (gapRatio <= 0.18) {
    score += 0.12;
    reasons.push("near caption");
  } else if (gapRatio <= 0.32) {
    score += 0.07;
    reasons.push("same page as caption");
  }
  if (horizontalOverlap >= 0.65) {
    score += 0.1;
    reasons.push("same column as caption");
  } else if (horizontalOverlap >= 0.25) {
    score += 0.05;
    reasons.push("partial caption-column overlap");
  }
  return { score, reasons };
}

function scoreCandidate(
  candidate: ScoredRect,
  page: PdfFigurePageGeometry,
  target: PdfFigureTarget,
): PdfFigureCropCandidate {
  const areaRatio =
    rectArea(candidate.rect) / Math.max(1, page.width * page.height);
  const distance = captionDistanceScore(
    candidate.rect,
    target.captionBox,
    page,
  );
  const overlap = textOverlapRatio(candidate.rect, page, target);
  const paragraphOverlap = paragraphTextOverlapRatio(
    candidate.rect,
    page,
    target,
  );
  const warnings: string[] = [];
  let confidence =
    candidate.source === "pdf-image-object"
      ? 0.64
      : candidate.source === "mineru-layout-region"
        ? 0.84
        : candidate.source === "caption-bounded-region"
          ? 0.76
          : 0.48;
  confidence += Math.min(0.08, areaRatio * 0.55);
  confidence += distance.score;
  if (candidate.boxes.length > 1) confidence += 0.04;
  const overlapLimit =
    candidate.source === "mineru-layout-region"
      ? 0.18
      : candidate.source === "caption-bounded-region"
        ? 0.12
        : 0.03;
  if (overlap > overlapLimit) {
    confidence -= Math.min(0.5, overlap * 2.4);
    warnings.push("substantial non-caption text overlap");
  }
  if (paragraphOverlap > 0.04) {
    confidence -= Math.min(0.55, paragraphOverlap * 4.0);
    warnings.push("paragraph-like text overlap");
  }
  if (
    candidate.source === "caption-bounded-region" &&
    paragraphOverlap > 0.12
  ) {
    confidence = Math.min(confidence, 0.36);
  }
  return {
    source: candidate.source,
    rect: candidate.rect,
    confidence: clamp01(confidence),
    reasons: [...candidate.reasons, ...distance.reasons],
    warnings: [...(candidate.warnings || []), ...warnings],
  };
}

function candidateIsNearCaption(
  rect: PdfFigureRect,
  target: PdfFigureTarget,
  page: PdfFigurePageGeometry,
): boolean {
  if (!target.captionBox) return true;
  const gap = verticalGap(rect, target.captionBox) / Math.max(1, page.height);
  return gap <= 0.34 && horizontalOverlapRatio(rect, target.captionBox) >= 0.18;
}

function buildObjectCandidates(
  page: PdfFigurePageGeometry,
  target: PdfFigureTarget,
): ScoredRect[] {
  const boxes = page.imageBoxes
    .map(normalizeRect)
    .map((rect, index) => ({ ...rect, ...page.imageBoxes[index] }))
    .filter((box) => !isPageFurniture(box, page));
  const candidates: ScoredRect[] = boxes.map((box) => ({
    source: "pdf-image-object",
    rect: normalizeRect(box),
    boxes: [box],
    reasons: ["pdf image object"],
  }));
  const near = boxes.filter((box) => candidateIsNearCaption(box, target, page));
  if (near.length > 1) {
    candidates.push({
      source: "pdf-image-object",
      rect: unionRects(near),
      boxes: near,
      reasons: ["compound pdf image object group"],
    });
  }
  return candidates;
}

function buildMineruLayoutCandidates(
  page: PdfFigurePageGeometry,
  target: PdfFigureTarget,
): ScoredRect[] {
  if (!target.visualBox) return [];
  const box = repairMineruVisualRect(
    normalizeRect(target.visualBox),
    target,
    page,
  );
  if (isPageFurniture(box, page)) return [];
  return [
    {
      source: "mineru-layout-region",
      rect: box,
      boxes: [box],
      reasons: ["MinerU visual block"],
    },
  ];
}

function repairMineruVisualRect(
  box: PdfFigureRect,
  target: PdfFigureTarget,
  page: PdfFigurePageGeometry,
): PdfFigureRect {
  const aspect = target.visualAspectRatio;
  if (!aspect || !Number.isFinite(aspect) || aspect <= 0) return box;
  if (box.width <= 0 || box.height <= 0) return box;

  const currentAspect = box.width / box.height;
  const tolerance = 0.08;
  const maxGrow = 2.5;
  let width = box.width;
  let height = box.height;

  if (currentAspect > aspect * (1 + tolerance)) {
    const desiredHeight = Math.min(width / aspect, height * maxGrow);
    if (desiredHeight > height) {
      let maxBottom = page.height;
      if (
        target.captionBox &&
        target.captionBox.top >= rectBottom(box) &&
        horizontalOverlapRatio(box, target.captionBox) >= 0.15
      ) {
        maxBottom = Math.min(maxBottom, target.captionBox.top - 4);
      }
      height = Math.min(desiredHeight, Math.max(height, maxBottom - box.top));
    }
  } else if (currentAspect < aspect * (1 - tolerance)) {
    const desiredWidth = Math.min(height * aspect, width * maxGrow);
    if (desiredWidth > width) {
      let maxRight = page.width;
      if (
        target.captionBox &&
        target.captionBox.left >= rectRight(box) &&
        verticalGap(box, target.captionBox) <= page.height * 0.08
      ) {
        maxRight = Math.min(maxRight, target.captionBox.left - 4);
      }
      width = Math.min(desiredWidth, Math.max(width, maxRight - box.left));
    }
  }

  return normalizeRect({
    left: box.left,
    top: box.top,
    width,
    height,
  });
}

function buildRegionCandidates(
  page: PdfFigurePageGeometry,
  target: PdfFigureTarget,
): ScoredRect[] {
  const boxes = (page.regionBoxes || [])
    .map(normalizeRect)
    .map((rect, index) => ({ ...rect, ...(page.regionBoxes || [])[index] }))
    .filter((box) => !isPageFurniture(box, page))
    .filter((box) => candidateIsNearCaption(box, target, page));
  return boxes.map((box) => {
    const refined = refineCaptionBoundedRegionRect(box, page, target);
    return {
      source: "caption-bounded-region",
      rect: refined.rect,
      boxes: [box],
      reasons: ["rendered pixels bounded by caption"],
      warnings: refined.warnings,
    };
  });
}

function buildInkCandidates(
  page: PdfFigurePageGeometry,
  target: PdfFigureTarget,
): ScoredRect[] {
  const boxes = page.inkBoxes
    .map(normalizeRect)
    .map((rect, index) => ({ ...rect, ...page.inkBoxes[index] }))
    .filter((box) => !isPageFurniture(box, page))
    .filter((box) => textOverlapRatio(box, page, target) < 0.25)
    .filter((box) => candidateIsNearCaption(box, target, page));
  if (!boxes.length) return [];
  const candidates: ScoredRect[] = boxes.map((box) => ({
    source: "rendered-ink",
    rect: normalizeRect(box),
    boxes: [box],
    reasons: ["rendered ink component"],
  }));
  if (boxes.length > 1) {
    candidates.push({
      source: "rendered-ink",
      rect: unionRects(boxes),
      boxes,
      reasons: ["compound rendered ink component group"],
    });
  }
  return candidates;
}

function chooseBestCandidate(
  candidates: PdfFigureCropCandidate[],
): PdfFigureCropCandidate | null {
  const best =
    candidates.reduce<PdfFigureCropCandidate | null>(
      (current, candidate) =>
        !current || candidate.confidence > current.confidence
          ? candidate
          : current,
      null,
    ) || null;
  if (best?.source === "mineru-layout-region") {
    const largerPdfObject = candidates
      .filter((candidate) => candidate.source === "pdf-image-object")
      .filter((candidate) => candidate.confidence >= 0.78)
      .filter(
        (candidate) => rectArea(candidate.rect) >= rectArea(best.rect) * 1.25,
      )
      .sort((left, right) => {
        const areaDelta = rectArea(right.rect) - rectArea(left.rect);
        if (Math.abs(areaDelta) > 1) return areaDelta;
        return right.confidence - left.confidence;
      })[0];
    if (largerPdfObject) return largerPdfObject;
  }
  if (!best || best.source !== "pdf-image-object") return best;
  const largerVisualCandidate = candidates
    .filter((candidate) =>
      ["caption-bounded-region", "rendered-ink"].includes(candidate.source),
    )
    .filter((candidate) => candidate.confidence >= 0.45)
    .filter((candidate) => {
      const multiplier =
        candidate.source === "caption-bounded-region" ? 1.25 : 1.8;
      return rectArea(candidate.rect) >= rectArea(best.rect) * multiplier;
    })
    .sort((left, right) => {
      const areaDelta = rectArea(right.rect) - rectArea(left.rect);
      if (Math.abs(areaDelta) > 1) return areaDelta;
      return right.confidence - left.confidence;
    })[0];
  return largerVisualCandidate || best;
}

export function resolveFigureCropForTarget(params: {
  target: PdfFigureTarget;
  page: PdfFigurePageGeometry;
}): PdfFigureCropResult {
  const objectCandidates = buildObjectCandidates(params.page, params.target);
  const mineruLayoutCandidates = buildMineruLayoutCandidates(
    params.page,
    params.target,
  );
  const regionCandidates = buildRegionCandidates(params.page, params.target);
  const inkCandidates = buildInkCandidates(params.page, params.target);
  const candidates = [
    ...objectCandidates,
    ...mineruLayoutCandidates,
    ...regionCandidates,
    ...inkCandidates,
  ].map((candidate) => scoreCandidate(candidate, params.page, params.target));
  const best = chooseBestCandidate(candidates);
  return {
    target: params.target,
    best,
    candidates,
  };
}
