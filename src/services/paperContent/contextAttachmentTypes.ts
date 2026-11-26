import type { PaperContentSourceMode } from "../../shared/types";

export type TextAttachmentSourceMode = Extract<
  PaperContentSourceMode,
  "markdown" | "html" | "txt" | "docx"
>;

export type ContextAttachmentSupport =
  | {
      kind: "pdf";
      attachmentType: "pdf";
      readableVia: "paper_read";
    }
  | {
      kind: "text";
      attachmentType: TextAttachmentSourceMode;
      contentSourceMode: TextAttachmentSourceMode;
      readableVia: "read_attachment";
    };
