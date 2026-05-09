import { normalizePaperContextRefs } from "./normalizers";
import { sanitizeText } from "./textUtils";
import type { PaperContextRef } from "./types";

export type CitationContextSource = {
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  paperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  citationPaperContexts?: PaperContextRef[];
};

export function mergeCitationPaperContexts(
  ...groups: unknown[]
): PaperContextRef[] {
  const flat: unknown[] = [];
  for (const group of groups) {
    if (Array.isArray(group)) {
      flat.push(...group.filter(Boolean));
    } else if (group) {
      flat.push(group);
    }
  }
  return normalizePaperContextRefs(flat, { sanitizeText });
}

export function getMessageCitationPaperContexts(
  message: CitationContextSource | null | undefined,
): PaperContextRef[] {
  return mergeCitationPaperContexts(
    message?.selectedTextPaperContexts,
    message?.paperContexts,
    message?.fullTextPaperContexts,
    message?.citationPaperContexts,
  );
}
