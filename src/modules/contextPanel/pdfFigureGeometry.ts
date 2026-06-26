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

export type PdfFigureCandidateSource =
  | "pdf-image-object"
  // Legacy/diagnostic only. Normal runtime figure extraction is source-PDF based.
  | "mineru-layout-region"
  | "caption-bounded-region"
  | "rendered-ink"
  | "pdf-vector-object";
