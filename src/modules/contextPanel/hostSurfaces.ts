/**
 * Composition root for the capabilities the Zotero panel provides to services
 * and agent code through `src/services/**` bridges.
 *
 * This is the only place that knows both halves of each bridge. It runs once
 * from plugin startup — never as a side effect of importing a UI module — so
 * that whether a capability is available depends on the plugin being started,
 * not on which module some code path happened to import first.
 *
 * Bridges whose two halves both live in the panel are composed in
 * `panelSurfaces.ts` instead. That split is load-bearing: workflow test bundles
 * carry this module, and their bundler has no `.md` loader, so nothing reached
 * from here may import the chat renderer and its agent skill markdown.
 */
import { configureContextSelectionBridge } from "../../services/context/contextSelectionBridge";
import { configureAssistantNoteWriter } from "../../services/notes/assistantNoteWriterBridge";
import { configurePdfReaderTextBridge } from "../../services/pdf/readerTextBridge";
import { configureRetrievalCandidateInvalidator } from "../../services/retrieval/cacheInvalidation";
import {
  getActiveContextAttachmentFromTabs,
  resolveContextSourceItem,
} from "./contextResolution";
import {
  verifyCompleteQuoteInLivePdfJs,
  warmPageTextCache,
  warmPageTextCacheForAttachment,
} from "../../services/pdf/livePdfSelectionLocator";
import { clearRetrievalCandidateCache } from "./multiContextPlanner";
import {
  createNoteFromAssistantText,
  createStandaloneNoteFromAssistantText,
} from "./notes";

/**
 * Configures every host surface bridge and returns a disposer that undoes the
 * whole composition, in reverse order, on plugin shutdown.
 */
export function composeHostSurfaces(): () => void {
  const disposers = [
    configurePdfReaderTextBridge({
      warmPageTextCache,
      warmPageTextCacheForAttachment,
      verifyCompleteQuote: verifyCompleteQuoteInLivePdfJs,
    }),
    configureContextSelectionBridge({
      getActiveAttachment: getActiveContextAttachmentFromTabs,
      resolveContextItem: (item) => resolveContextSourceItem(item).contextItem,
    }),
    configureAssistantNoteWriter({
      writeItemNote: (params) =>
        createNoteFromAssistantText(
          params.item,
          params.content,
          params.modelName,
          undefined,
          {
            appendToTrackedNote: params.appendToTrackedNote,
            rememberCreatedNote: params.appendToTrackedNote,
            generatedImages: params.generatedImages,
          },
        ),
      writeStandaloneNote: async (params) => {
        const result = await createStandaloneNoteFromAssistantText(
          params.libraryID,
          params.content,
          params.modelName,
          undefined,
          undefined,
          params.generatedImages,
          undefined,
          undefined,
          params.collections,
        );
        return { ...result, status: "standalone_created" };
      },
    }),
    configureRetrievalCandidateInvalidator(clearRetrievalCandidateCache),
  ];
  return () => {
    for (const dispose of [...disposers].reverse()) dispose();
  };
}
