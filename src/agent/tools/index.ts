import { AgentToolRegistry } from "./registry";
import { PdfService } from "../services/pdfService";
import { RetrievalService } from "../services/retrievalService";
import { ZoteroGateway } from "../services/zoteroGateway";
import { createQueryLibraryTool } from "./read/queryLibrary";
import { createReadLibraryTool } from "./read/readLibrary";
import {
  clearInspectPdfCache,
  createInspectPdfTool,
} from "./read/inspectPdf";
import { createSearchLiteratureOnlineTool } from "./read/searchLiteratureOnline";

import { createEditCurrentNoteTool } from "./write/editCurrentNote";
import { createUndoLastActionTool } from "./write/undoLastAction";
import { createApplyTagsTool } from "./write/applyTags";
import { createMoveToCollectionTool } from "./write/moveToCollection";
import { createUpdateMetadataTool } from "./write/updateMetadata";
import { createManageCollectionsTool } from "./write/manageCollections";
import { createImportIdentifiersTool } from "./write/importIdentifiers";
import { createTrashItemsTool } from "./write/trashItems";
import { createMergeItemsTool } from "./write/mergeItems";
import { createManageAttachmentsTool } from "./write/manageAttachments";
import { createRunCommandTool } from "./write/runCommand";
import { createImportLocalFilesTool } from "./write/importLocalFiles";
import { createFileIOTool } from "./write/fileIO";
import { PdfPageService } from "../services/pdfPageService";

type BuiltInAgentToolDeps = {
  zoteroGateway: ZoteroGateway;
  pdfService: PdfService;
  pdfPageService: PdfPageService;
  retrievalService: RetrievalService;
};

export function createBuiltInToolRegistry(
  deps: BuiltInAgentToolDeps,
): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  registry.register(createQueryLibraryTool(deps.zoteroGateway));
  registry.register(createReadLibraryTool(deps.zoteroGateway));
  registry.register(
    createInspectPdfTool(
      deps.pdfService,
      deps.pdfPageService,
      deps.retrievalService,
      deps.zoteroGateway,
    ),
  );
  registry.register(createSearchLiteratureOnlineTool(deps.zoteroGateway));
  registry.register(createApplyTagsTool(deps.zoteroGateway));
  registry.register(createMoveToCollectionTool(deps.zoteroGateway));
  registry.register(createUpdateMetadataTool(deps.zoteroGateway));
  registry.register(createManageCollectionsTool(deps.zoteroGateway));
  registry.register(createImportIdentifiersTool(deps.zoteroGateway));
  registry.register(createTrashItemsTool(deps.zoteroGateway));
  registry.register(createMergeItemsTool(deps.zoteroGateway));
  registry.register(createManageAttachmentsTool(deps.zoteroGateway));
  registry.register(createEditCurrentNoteTool(deps.zoteroGateway));
  registry.register(createRunCommandTool());
  registry.register(createImportLocalFilesTool(deps.zoteroGateway));
  registry.register(createFileIOTool());
  registry.register(createUndoLastActionTool());
  return registry;
}

export function clearAllAgentToolCaches(conversationKey: number): void {
  clearInspectPdfCache(conversationKey);
}
