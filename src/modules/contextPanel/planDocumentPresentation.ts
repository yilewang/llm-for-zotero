import { appLogger } from "../../core/logging";
import {
  isOutsideBibliographyEntry,
  isOutsideCitationSource,
  type OutsidePaperSnapshot,
  type PlanCitationSource,
  type PlanDocument,
  type ZoteroCitationSource,
} from "../../agent/documents/types";
import { outsidePaperUri } from "../../agent/documents/outsidePaperCitations";
import { launchInDefaultBrowser } from "./webSourcesSidePanel";
import { toFileUrl } from "../../utils/pathFileUrl";
import { t } from "../../utils/i18n";
import {
  CONTENT_FLAT_SCOPE_CLASS,
  appendContentCaption,
} from "./contentChrome";
import { createGeneratedImageFrame } from "./generatedImageRender";
import type { Message, PaperContextRef } from "./types";
import {
  renderAssistantRichText,
  type AssistantCitationContext,
} from "./assistantRichText";
import { renderRenderedMarkdownInto } from "./renderedMarkdown";
import {
  formatPaperSourceLabel,
  resolvePaperContextRefFromAttachment,
  resolvePaperContextRefFromItem,
} from "../../services/paperContent/paperAttribution";
import {
  mergeQuoteCitations,
  normalizeQuoteCitations,
} from "../../services/quotes/quoteCitations";
import { getMessageCitationPaperContexts } from "./citationContexts";
import { bindDocumentQuotesForDisplay } from "./documentQuoteDisplay";
import { bindDocumentCitationGroupsForDisplay } from "../../agent/documents/citationService";
import { ZoteroGateway } from "../../agent/services/zoteroGateway";

/** Adapt immutable document provenance to the same renderer used by chat. */
export function buildDocumentCitationContext(
  document: PlanDocument,
  source?: AssistantCitationContext,
): AssistantCitationContext | null {
  const papers = new Map<string, PaperContextRef>();
  const add = (paper: PaperContextRef | null) => {
    if (paper) papers.set(`${paper.itemId}:${paper.contextItemId}`, paper);
  };
  for (const paper of getMessageCitationPaperContexts(
    source?.pairedUserMessage || undefined,
  ) || [])
    add(paper);
  const quotes = [];
  for (const quote of document.verifiedQuotes) {
    const item = Zotero.Items.getByLibraryAndKey(
      quote.libraryID,
      quote.itemKey,
    );
    const attachment = Zotero.Items.getByLibraryAndKey(
      quote.libraryID,
      quote.attachmentItemKey,
    );
    if (
      !item ||
      !attachment ||
      attachment.parentID !== item.id ||
      attachment.id !== quote.certificate.contextItemId
    )
      continue;
    const paper = resolvePaperContextRefFromAttachment(attachment);
    if (!paper) continue;
    add(paper);
    quotes.push({
      id: quote.quoteId,
      quoteText: quote.text,
      citationLabel: formatPaperSourceLabel(paper),
      itemId: item.id,
      contextItemId: attachment.id,
      sourceFingerprint: quote.certificate.sourceFingerprint,
      sourceMatchText: quote.certificate.sourceMatchText,
      sourceMatchKind: quote.certificate.sourceMatchKind,
      sourceMatchSource: "pdf-page-text",
      sourceMatchPageOccurrence: quote.certificate.sourceMatchPageOccurrence,
      pageHintIndex: quote.certificate.pageIndex,
    });
  }
  for (const cluster of document.citationBundle.clusters) {
    for (const source of cluster.sources) {
      // An outside paper is not a Zotero paper the panel can scope to.
      if (isOutsideCitationSource(source)) continue;
      const item = Zotero.Items.getByLibraryAndKey(
        source.libraryID,
        source.itemKey,
      );
      const attachment =
        source.locator &&
        Zotero.Items.getByLibraryAndKey(
          source.libraryID,
          source.locator.attachmentItemKey,
        );
      if (attachment && item && attachment.parentID === item.id)
        add(resolvePaperContextRefFromAttachment(attachment));
      else if (item) add(resolvePaperContextRefFromItem(item));
    }
  }
  // Only the originating panel or the document's own native source identities
  // can provide scope; never consult the currently active reader or library.
  const panelItem =
    source?.panelItem ||
    (papers.size ? Zotero.Items.get([...papers.values()][0].itemId) : null);
  if (!panelItem) return null;
  if (!papers.size) add(resolvePaperContextRefFromItem(panelItem));
  const priorMessage = source?.assistantMessage;
  const certifiedQuotes = normalizeQuoteCitations(quotes);
  // The chat message may lead the document with text the model wrote before
  // calling the tool. Its display override then covers that text too: reuse
  // its citations, but its markdown only when it is the document's alone.
  const priorText = priorMessage?.text || "";
  const previousDisplay =
    document.visibleMarkdown && priorText.endsWith(document.visibleMarkdown)
      ? priorMessage?.quoteDisplayOverride
      : undefined;
  const quoteCitations = mergeQuoteCitations(
    previousDisplay?.quoteCitations || priorMessage?.quoteCitations,
    certifiedQuotes,
  );
  let displayMarkdown =
    (priorText === document.visibleMarkdown
      ? previousDisplay?.markdown
      : undefined) ?? document.visibleMarkdown;
  try {
    displayMarkdown = bindDocumentCitationGroupsForDisplay({
      markdown: displayMarkdown,
      bundle: document.citationBundle,
      gateway: new ZoteroGateway(),
    });
  } catch (error) {
    appLogger.warn("LLM document citation group display unavailable", error);
  }
  // Gecko's chrome-document HTML parser strips zotero:// attributes. Carry
  // only bundle-bound identities through it as inert fragments, then restore
  // their native links in the citation decorator after sanitization.
  for (const cluster of document.citationBundle.clusters) {
    for (const source of cluster.sources) {
      if (isOutsideCitationSource(source)) continue;
      const href = planDocumentCitationSourceHref(source);
      displayMarkdown = displayMarkdown
        .split(`](${href})`)
        .join(`](${documentCitationDisplayHref(href)})`);
    }
  }
  const assistantMessage: Message = {
    ...priorMessage,
    role: "assistant",
    text: document.visibleMarkdown,
    timestamp: document.createdAt,
    streaming: false,
    compactMarker: undefined,
    quoteDisplayOverride: {
      markdown: bindDocumentQuotesForDisplay(displayMarkdown, certifiedQuotes),
      quoteCitations,
    },
    quoteCitations,
    agentRunId:
      document.version === 2 && document.origin.kind === "direct"
        ? document.origin.runId
        : priorMessage?.agentRunId,
  };
  return {
    panelItem,
    assistantMessage,
    pairedUserMessage: {
      ...source?.pairedUserMessage,
      role: "user",
      text: source?.pairedUserMessage?.text || "",
      timestamp: source?.pairedUserMessage?.timestamp || document.createdAt,
      citationPaperContexts: [...papers.values()],
    },
  };
}

/** Roots whose display repair already ran; never repair the same one twice. */
const citationStyleRegistryRepairRoots = new WeakSet<object>();

/**
 * Zotero loads its citation style registry inside its own startup step, a few
 * seconds after the window is usable, and the display binding above is
 * synchronous. A document rendered in that window therefore shows its grouped
 * citations raw. Load the registry once, then re-render the still-mounted
 * document so the group becomes "(Alpha, 2020; Beta, 2021)" with its links.
 */
export function scheduleCitationStyleRegistryRepair(params: {
  document: PlanDocument;
  root: { isConnected: boolean };
  rerender: () => void;
}): boolean {
  const hasGroupedCluster = params.document.citationBundle.clusters.some(
    (cluster) => cluster.sources.length > 1,
  );
  if (!hasGroupedCluster) return false;
  const styles = (
    globalThis as unknown as {
      Zotero?: {
        Styles?: { initialized?: () => boolean; init?: () => unknown };
      };
    }
  ).Zotero?.Styles;
  if (typeof styles?.init !== "function") return false;
  let initialized = false;
  try {
    initialized = styles.initialized?.() === true;
  } catch (_err) {
    initialized = false;
  }
  if (initialized) return false;
  // One attempt per root: if the registry never reports itself ready, the
  // repaired render must not schedule another load forever.
  if (citationStyleRegistryRepairRoots.has(params.root)) return false;
  citationStyleRegistryRepairRoots.add(params.root);
  const report = (error: unknown) => {
    try {
      appLogger.warn(
        "LLM document citation group display repair unavailable",
        error,
      );
    } catch (_err) {
      /* ztoolkit is absent outside the plugin runtime. */
    }
  };
  try {
    void Promise.resolve(styles.init())
      .then(() => {
        if (params.root.isConnected) params.rerender();
      })
      .catch(report);
  } catch (error) {
    report(error);
    return false;
  }
  return true;
}

export function renderPlanDocumentContent(params: {
  doc: Document;
  root: HTMLElement;
  document: PlanDocument;
  citationContext?: AssistantCitationContext;
}): void {
  const content = params.root as HTMLDivElement;
  content.classList.add("llm-document-rich-text");
  const context = buildDocumentCitationContext(
    params.document,
    params.citationContext,
  );
  if (context)
    renderAssistantRichText({ ...context, body: params.root, bubble: content });
  else
    renderRenderedMarkdownInto(
      content,
      params.document.visibleMarkdown,
      params.doc,
    );
  decoratePlanDocumentCitations({ ...params, root: content });
  scheduleCitationStyleRegistryRepair({
    document: params.document,
    root: params.root,
    rerender: () => renderPlanDocumentContent(params),
  });
}

export function getPlanDocumentItemTitle(
  libraryID: number,
  itemKey: string,
): string {
  const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
  if (!item) return itemKey;
  return item.getDisplayTitle?.() || item.getField?.("title") || itemKey;
}

export function planDocumentCitationSourceHref(
  source: ZoteroCitationSource,
): string {
  const isUserLibrary =
    source.libraryID === Number(Zotero.Libraries.userLibraryID);
  const groupID = isUserLibrary
    ? undefined
    : (
        Zotero.Libraries.get(source.libraryID) as
          | { groupID?: number }
          | undefined
      )?.groupID;
  const libraryPath = groupID ? `groups/${groupID}` : "library";
  return source.locator
    ? `zotero://open-pdf/${libraryPath}/items/${source.locator.attachmentItemKey}?page=${source.locator.pageIndex + 1}`
    : `zotero://select/${libraryPath}/items/${source.itemKey}`;
}

function documentCitationDisplayHref(href: string): string {
  return `#llm-document-source-${encodeURIComponent(href)}`;
}

function selectZoteroLibraryTab(): void {
  const localTabs = (Zotero as unknown as { Tabs?: unknown }).Tabs;
  let mainWindowTabs: unknown;
  try {
    mainWindowTabs = (
      Zotero.getMainWindow?.() as
        | { Zotero?: { Tabs?: unknown } }
        | null
        | undefined
    )?.Zotero?.Tabs;
  } catch {
    mainWindowTabs = undefined;
  }
  for (const candidate of [localTabs, mainWindowTabs]) {
    const tabs = candidate as
      | { select?: (tabID: string | number) => unknown }
      | null
      | undefined;
    if (typeof tabs?.select !== "function") continue;
    try {
      tabs.select("zotero-pane");
      return;
    } catch {
      // Fall through to the next live Zotero window candidate.
    }
  }
}

export async function navigatePlanDocumentCitationSource(
  source: ZoteroCitationSource,
): Promise<boolean> {
  const revealSource = (success: boolean): boolean => {
    if (success) Zotero.getMainWindow?.()?.focus?.();
    return success;
  };
  if (source.locator) {
    const attachment = Zotero.Items.getByLibraryAndKey(
      source.libraryID,
      source.locator.attachmentItemKey,
    );
    const reader = Zotero.Reader as
      | {
          open?: (
            itemID: number,
            location?: _ZoteroTypes.Reader.Location,
          ) => Promise<unknown>;
        }
      | undefined;
    if (attachment && typeof reader?.open === "function") {
      await reader.open(Number(attachment.id), {
        pageIndex: source.locator.pageIndex,
      });
      return revealSource(true);
    }
  }

  const item = Zotero.Items.getByLibraryAndKey(
    source.libraryID,
    source.itemKey,
  );
  if (!item) return false;
  // selectItems() updates the library selection but does not necessarily make
  // it visible when the user clicked from a reader-backed document card.
  selectZoteroLibraryTab();
  const pane = Zotero.getActiveZoteroPane?.() as
    | _ZoteroTypes.ZoteroPane
    | undefined;
  if (!pane) return false;
  if (typeof pane.selectItems === "function") {
    const selected = await (
      pane.selectItems as (
        itemIDs: number[],
        options?: { selectInLibrary?: boolean },
      ) => unknown
    )([Number(item.id)], { selectInLibrary: true });
    if (selected !== false) return revealSource(true);
  }
  if (typeof pane.selectItem === "function") {
    return revealSource(pane.selectItem(Number(item.id), true) !== false);
  }
  return false;
}

function attachSourceNavigation(
  link: HTMLAnchorElement,
  source: ZoteroCitationSource,
  afterNavigate?: () => void,
): void {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    // Mirror the quote citation button's completion marker so observers can
    // tell a started navigation from a finished one.
    link.dataset.loading = "true";
    void navigatePlanDocumentCitationSource(source).finally(() => {
      link.dataset.loading = "false";
      afterNavigate?.();
    });
  });
}

/** Every form an outside paper's link takes in the rendered document. */
function outsidePapersByHref(
  papers: readonly OutsidePaperSnapshot[],
): Map<string, { paper: OutsidePaperSnapshot; href: string }> {
  const byHref = new Map<
    string,
    { paper: OutsidePaperSnapshot; href: string }
  >();
  for (const paper of papers) {
    const href = outsidePaperUri(paper);
    if (!href) continue;
    byHref.set(href, { paper, href });
    try {
      byHref.set(decodeURI(href), { paper, href });
    } catch {
      // The escaped URI remains the canonical lookup key.
    }
  }
  return byHref;
}

/** An outside paper's link opens its DOI or page in the user's browser. */
function attachOutsidePaperLink(
  link: HTMLAnchorElement,
  paper: OutsidePaperSnapshot,
  href: string,
): void {
  link.setAttribute("href", href);
  link.dataset.llmPlanCitationSource = "outside";
  link.title = paper.doi ? "Open at doi.org" : "Open paper page";
  link.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    launchInDefaultBrowser(href);
  });
}

const OUTSIDE_REFERENCE_MARKER_CLASS = "llm-plan-document-outside-marker";

/**
 * After an outside paper's References entry, a muted "Not in library". It
 * is drawn here only: the stored Markdown, copies, notes and exports never
 * carry it.
 */
function markOutsideReference(params: {
  doc: Document;
  link: HTMLAnchorElement;
  document: PlanDocument;
  paperId: string;
}): void {
  // A References entry is a list item's link (a loose list wraps it in <p>).
  const tag = (element: Element | null | undefined) =>
    element?.tagName?.toLowerCase();
  const parent = params.link.parentElement;
  if (
    !parent ||
    (tag(parent) !== "li" &&
      !(tag(parent) === "p" && tag(parent.parentElement) === "li"))
  )
    return;
  const text = (params.link.textContent || "").replace(/\s+/g, " ").trim();
  const isEntry = params.document.citationBundle.bibliographyEntries.some(
    (entry) =>
      isOutsideBibliographyEntry(entry) &&
      entry.paperId === params.paperId &&
      entry.text.replace(/\s+/g, " ").trim() === text,
  );
  if (!isEntry) return;
  const next = params.link.nextSibling as Element | null;
  if (next?.classList?.contains?.(OUTSIDE_REFERENCE_MARKER_CLASS)) return;
  const marker = params.doc.createElement("span");
  marker.className = OUTSIDE_REFERENCE_MARKER_CLASS;
  marker.textContent = ` \u00b7 ${t("Not in library")}`;
  parent.insertBefore(marker, params.link.nextSibling);
}

export function decoratePlanDocumentCitations(params: {
  doc: Document;
  root: HTMLElement;
  document: PlanDocument;
}): void {
  const outsideByHref = outsidePapersByHref(
    params.document.citationBundle.outsidePapers || [],
  );
  // Outside papers are decorated by their own links, below.
  const zoteroSources = (cluster: { sources: readonly PlanCitationSource[] }) =>
    cluster.sources.filter(
      (source): source is ZoteroCitationSource =>
        !isOutsideCitationSource(source),
    );
  const singleSourceByText = new Map(
    params.document.citationBundle.clusters
      .filter(
        (cluster) =>
          cluster.sources.length === 1 &&
          zoteroSources(cluster).length === 1 &&
          cluster.text.trim(),
      )
      .map((cluster) => [cluster.text.trim(), zoteroSources(cluster)[0]]),
  );
  const sources =
    params.document.citationBundle.clusters.flatMap(zoteroSources);
  const sourceByHref = new Map<string, ZoteroCitationSource>();
  for (const source of sources) {
    const hrefs = [
      planDocumentCitationSourceHref(source),
      planDocumentCitationSourceHref({ ...source, locator: undefined }),
    ];
    for (const href of hrefs) {
      sourceByHref.set(href, source);
      sourceByHref.set(documentCitationDisplayHref(href), source);
      try {
        sourceByHref.set(decodeURI(href), source);
      } catch {
        // The raw URI remains the canonical lookup key.
      }
    }
  }
  for (const node of Array.from(params.root.querySelectorAll("a"))) {
    const link = node as HTMLAnchorElement;
    const href = link.getAttribute("href") || "";
    let decodedHref = href;
    try {
      decodedHref = decodeURI(href);
    } catch {
      decodedHref = href;
    }
    const outside = outsideByHref.get(href) || outsideByHref.get(decodedHref);
    if (outside) {
      attachOutsidePaperLink(link, outside.paper, outside.href);
      markOutsideReference({
        doc: params.doc,
        link,
        document: params.document,
        paperId: outside.paper.paperId,
      });
      continue;
    }
    const source =
      sourceByHref.get(href) ||
      sourceByHref.get(decodedHref) ||
      singleSourceByText.get((link.textContent || "").trim());
    if (!source) continue;
    link.setAttribute("href", planDocumentCitationSourceHref(source));
    link.dataset.llmPlanCitationSource = "true";
    link.title = "Open cited Zotero source";
    attachSourceNavigation(link, source);
  }
}

export function renderPlanDocumentFigures(
  doc: Document,
  document: PlanDocument,
): HTMLElement | null {
  if (!document.assets.length) return null;
  const gallery = doc.createElement("section");
  // The gallery sets its own flat scope: in the chat card it sits outside the
  // document body, and the standalone window is already in scope.
  gallery.className = [
    "llm-plan-document-figures",
    "llm-assistant-generated-images",
    "llm-agent-image-artifacts-grid",
    "llm-agent-figure-strip",
    CONTENT_FLAT_SCOPE_CLASS,
  ].join(" ");
  let frameCount = 0;
  for (const asset of document.assets) {
    const frame = createGeneratedImageFrame(
      gallery,
      {
        id: asset.assetId,
        label: asset.caption,
        path: asset.durablePath,
        src: toFileUrl(asset.durablePath) || undefined,
      },
      doc,
      { flatChrome: true, allowMoveToSidePanel: false },
    );
    if (!frame) continue;
    const provenance =
      asset.provenance.origin === "extracted"
        ? `Extracted from ${getPlanDocumentItemTitle(
            asset.provenance.libraryID,
            asset.provenance.itemKey,
          )}, PDF page ${asset.provenance.pageIndex + 1}`
        : `Generated asset \u00b7 ${asset.provenance.generator}`;
    // The document's own caption and provenance replace the file name.
    appendContentCaption(
      frame,
      {
        kind: t("Figure"),
        text: [asset.caption, provenance].filter(Boolean).join(" \u2014 "),
      },
      doc,
    );
    gallery.appendChild(frame);
    frameCount += 1;
  }
  return frameCount ? gallery : null;
}
