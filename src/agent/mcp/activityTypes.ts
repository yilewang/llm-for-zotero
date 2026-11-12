import type { QuoteCitation } from "../../shared/types";
import type { AgentActionReceipt } from "../contracts/types";
import type { TaskPaperLedgerDelta } from "../context/taskPaperLedger";
import type {
  TrustedReadObservation,
  VerifiedReadSource,
} from "../context/readObservationTypes";
import type { AgentToolArtifact, AgentWorkCategory } from "../types";
import type { OutsidePaperRecord } from "../context/outsidePaperRecords";

export type ZoteroMcpToolActivityEvent = {
  requestId: string;
  runId?: string;
  conversationGeneration?: number;
  phase: "started" | "completed";
  toolName: string;
  toolLabel?: string;
  serverName: string;
  arguments?: unknown;
  ok?: boolean;
  error?: string;
  artifacts?: AgentToolArtifact[];
  actionReceipts?: AgentActionReceipt[];
  workCategory?: AgentWorkCategory;
  mutability?: "read" | "write";
  profileSignature?: string;
  conversationKey?: number;
  libraryID?: number;
  kind?: "global" | "paper";
  quoteCitations?: QuoteCitation[];
  verifiedReadSources?: VerifiedReadSource[];
  readObservations?: readonly TrustedReadObservation[];
  /**
   * The outside papers this successful literature_search or literature_read
   * call returned, for the run's record of citable outside papers.
   */
  outsidePapers?: readonly OutsidePaperRecord[];
  /**
   * The id of the document version this successful library_import call
   * published (kind:'document_citations'), so the host loads it for the turn.
   */
  publishedDocumentId?: string;
  /**
   * What this successful read call read from each paper, for the Task
   * progress view. Set only on a completed call inside a conversation.
   */
  paperLedgerDelta?: TaskPaperLedgerDelta;
  timestamp: number;
};
