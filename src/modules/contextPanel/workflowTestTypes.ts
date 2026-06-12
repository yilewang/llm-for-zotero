import type { ResolvedContextSource, SendQuestionOptions } from "./types";
import type { QuoteCitation } from "../../shared/types";

export type WorkflowTestFixture = {
  parentItemId: number;
  pdfAttachmentId: number;
  tempPdfPath: string;
};

export type WorkflowTestAttachmentFixture = {
  attachmentItemId: number;
  tempPath: string;
  title: string;
  filename: string;
  contentType: string;
};

export type WorkflowTestPanel = {
  panelId: string;
  itemId: number;
  contextSnapshot: ResolvedContextSource | null;
};

export type WorkflowTestDiagnostics = {
  panelId?: string;
  activeItemId?: number;
  contextSnapshot?: ResolvedContextSource | null;
  chipText: string[];
  inputValue?: string;
  statusText?: string;
  lastSend: SendQuestionOptions | null;
};

export type WorkflowTestAssistantRenderResult = {
  renderedText: string;
  quoteCardBodies: string[];
};

export type WorkflowTestStandaloneDiagnostics = {
  activeTab?: "paper" | "open" | null;
  conversationKey?: number;
  activeItemId?: number;
  rawContextItemId?: number;
  basePaperItemId?: number;
  contextItemId?: number;
  conversationKind?: string;
  titleText?: string;
  paperTabText?: string;
  openTabText?: string;
  statusText?: string;
  lastSend: SendQuestionOptions | null;
};

export type WorkflowTestApi = {
  reset: () => Promise<void>;
  createPaperWithPdfFixture: (input: {
    title: string;
    pdfTitle: string;
  }) => Promise<WorkflowTestFixture>;
  createStandaloneAttachmentFixture: (input: {
    title: string;
    filename: string;
    contentType: string;
    text?: string;
  }) => Promise<WorkflowTestAttachmentFixture>;
  renderPanelForItem: (itemId: number) => Promise<WorkflowTestPanel>;
  ask: (panelId: string, text: string) => Promise<SendQuestionOptions>;
  renderAssistantForPanel: (
    panelId: string,
    input: {
      text: string;
      quoteCitations?: QuoteCitation[];
    },
  ) => Promise<WorkflowTestAssistantRenderResult>;
  openStandaloneForItem: (
    itemId: number,
  ) => Promise<WorkflowTestStandaloneDiagnostics>;
  clickStandaloneTab: (
    tab: "paper" | "open",
  ) => Promise<WorkflowTestStandaloneDiagnostics>;
  askStandalone: (text: string) => Promise<SendQuestionOptions>;
  notifyStandaloneItemChanged: (
    itemId: number | null,
  ) => Promise<WorkflowTestStandaloneDiagnostics>;
  getStandaloneDiagnostics: () => Promise<WorkflowTestStandaloneDiagnostics>;
  closeStandalone: () => Promise<void>;
  getLastSend: () => SendQuestionOptions | null;
  getDiagnostics: (panelId?: string) => Promise<WorkflowTestDiagnostics>;
  cleanupFixture: (
    fixture: WorkflowTestFixture | WorkflowTestAttachmentFixture,
  ) => Promise<void>;
};
