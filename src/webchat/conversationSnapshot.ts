import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";

export const SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export type ConversationSnapshot = {
  version: 1;
  url: string;
  html: string;
  messageCount: number;
  warnings: string[];
};

export function canonicalSnapshotUrl(value: string): string {
  const url = new URL(value);
  if (
    url.origin !== "https://chatgpt.com" ||
    !/^\/c\/[a-zA-Z0-9-]+\/?$/.test(url.pathname)
  ) {
    throw new Error("Open a saved ChatGPT conversation first.");
  }
  return url.origin + url.pathname.replace(/\/$/, "");
}

const allowedTags = new Set(
  "html head body title style div span p section article header footer main h1 h2 h3 h4 h5 h6 strong b em i u s del small sub sup br hr blockquote pre code ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col a img figure figcaption details summary svg foreignobject g path circle ellipse line polyline polygon rect text tspan defs marker clippath math semantics annotation mrow mi mn mo ms mtext mfrac msqrt mroot msub msup msubsup munder mover munderover mtable mtr mtd".split(
    " ",
  ),
);
const allowedAttributes = new Set(
  "class style colspan rowspan scope start reversed value open title alt dir lang viewbox d fill stroke stroke-width x y x1 x2 y1 y2 cx cy r rx ry points width height transform xmlns display encoding accent stretchy mathvariant mathsize movablelimits columnalign rowalign columnspacing rowspacing text-anchor dominant-baseline dx dy stroke-linecap stroke-linejoin preserveaspectratio".split(
    " ",
  ),
);
const csp =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

/** Rebuild a passive document at the receiving trust boundary, even for a faulty extension. */
export function sanitizeSnapshotHtml(html: string): string {
  if (
    typeof html !== "string" ||
    !html.trim() ||
    new TextEncoder().encode(html).length > SNAPSHOT_MAX_BYTES
  ) {
    throw new Error("Empty or oversized conversation snapshot.");
  }
  const tree = parse(html);
  type Parent = DefaultTreeAdapterMap["parentNode"];
  function clean(parent: Parent) {
    parent.childNodes = parent.childNodes.filter((node) => {
      if (node.nodeName === "#text" || node.nodeName === "#documentType")
        return true;
      if (!("tagName" in node) || !allowedTags.has(node.tagName.toLowerCase()))
        return false;
      const tag = node.tagName.toLowerCase();
      node.attrs = node.attrs.filter((attr) => {
        if (attr.namespace || attr.prefix) return false;
        if (attr.name === "href" && tag === "a")
          return /^https?:\/\//i.test(attr.value);
        if (attr.name === "src" && tag === "img")
          return /^data:image\/(png|jpeg|gif|webp|avif);base64,[a-zA-Z0-9+/=\s]+$/.test(
            attr.value,
          );
        return allowedAttributes.has(attr.name.toLowerCase());
      });
      clean(node);
      return true;
    });
  }
  clean(tree);
  // All input meta/base/link nodes were removed. This CSP precedes every style and image.
  return serialize(tree).replace(
    "<head>",
    `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`,
  );
}

export class ConversationSnapshotBroker {
  private pending: {
    id: string;
    url: string;
    claimed: boolean;
    resolve: (value: ConversationSnapshot) => void;
    reject: (reason: Error) => void;
  } | null = null;

  request(
    id: string,
    url: string,
    timeoutMs = 60000,
  ): Promise<ConversationSnapshot> {
    if (this.pending)
      return Promise.reject(
        new Error("A conversation snapshot is already being saved."),
      );
    const canonical = canonicalSnapshotUrl(url);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id === id)
          this.cancel(
            "Snapshot timed out. Update Sync for Zotero and keep the matching conversation open.",
          );
      }, timeoutMs);
      this.pending = {
        id,
        url: canonical,
        claimed: false,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  poll() {
    if (!this.pending || this.pending.claimed) return null;
    this.pending.claimed = true;
    return { id: this.pending.id, url: this.pending.url, version: 1 };
  }

  submit(body: Record<string, unknown>): void {
    const pending = this.pending;
    if (!pending || body.id !== pending.id)
      throw new Error("Unknown or expired snapshot request.");
    if (body.error) {
      this.cancel(String(body.error).slice(0, 500));
      return;
    }
    if (
      body.version !== 1 ||
      canonicalSnapshotUrl(String(body.url)) !== pending.url
    )
      throw new Error("Snapshot conversation does not match the request.");
    const count = Number(body.messageCount);
    if (!Number.isInteger(count) || count < 1 || count > 12000)
      throw new Error("Invalid snapshot message count.");
    const html = sanitizeSnapshotHtml(body.html as string);
    this.pending = null;
    pending.resolve({
      version: 1,
      url: pending.url,
      html,
      messageCount: count,
      warnings: Array.isArray(body.warnings)
        ? body.warnings
            .filter((v): v is string => typeof v === "string")
            .slice(0, 20)
            .map((v) => v.slice(0, 500))
        : [],
    });
  }

  cancel(message = "Snapshot cancelled.") {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new Error(message));
  }
}

/** Use Zotero's shared endpoint registry, matching the main relay's cross-sandbox storage. */
export function getConversationSnapshotBroker(): ConversationSnapshotBroker {
  const registry = Zotero.Server.Endpoints as unknown as Record<
    string,
    unknown
  >;
  const key = "__llmConversationSnapshotBroker";
  if (!registry[key]) registry[key] = new ConversationSnapshotBroker();
  return registry[key] as ConversationSnapshotBroker;
}

export async function saveConversationSnapshotAttachment(
  snapshot: ConversationSnapshot,
  parent: Zotero.Item,
): Promise<Zotero.Item> {
  if (!parent.id || !parent.isRegularItem() || parent.deleted)
    throw new Error("Select a paper to save the conversation snapshot.");
  const library = Zotero.Libraries.get(parent.libraryID);
  if (!library || !library.editable || !library.filesEditable)
    throw new Error("This library does not allow saving attachments.");
  const file = Zotero.getTempDirectory();
  file.append(`chatgpt-snapshot-${Zotero.Utilities.randomString(16)}.html`);
  try {
    await Zotero.File.putContentsAsync(
      file,
      sanitizeSnapshotHtml(snapshot.html),
    );
    return await Zotero.Attachments.importFromFile({
      file: file.path,
      parentItemID: parent.id,
      title: `ChatGPT conversation snapshot — ${new Date().toISOString().slice(0, 19).replace("T", " ")}`,
      contentType: "text/html",
    });
  } finally {
    if (file.exists()) file.remove(false);
  }
}
