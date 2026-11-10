import { assert } from "chai";
import {
  ConversationSnapshotBroker,
  sanitizeSnapshotHtml,
  saveConversationSnapshotAttachment,
} from "../src/webchat/conversationSnapshot";

const url = "https://chatgpt.com/c/test-123";
const payload = {
  id: "request-1",
  version: 1,
  url,
  messageCount: 2,
  warnings: [],
  html: '<html><head><style>.card{border-radius:12px}</style></head><body><section class="card"><table><tr><td>42</td></tr></table></section></body></html>',
};

describe("conversation snapshots", function () {
  it("delivers only the matching request once and retains visual markup", async function () {
    const broker = new ConversationSnapshotBroker();
    const result = broker.request(payload.id, url);
    assert.deepEqual(broker.poll(), { id: payload.id, url, version: 1 });
    assert.isNull(broker.poll());
    assert.throws(() => broker.submit({ ...payload, id: "other" }), /Unknown/);
    assert.throws(
      () => broker.submit({ ...payload, url: "https://chatgpt.com/c/other" }),
      /does not match/,
    );
    broker.submit(payload);
    const snapshot = await result;
    assert.include(snapshot.html, "border-radius:12px");
    assert.include(snapshot.html, "<table>");
    assert.include(snapshot.html, "Content-Security-Policy");
    assert.throws(() => broker.submit(payload), /expired/);
  });

  it("rejects concurrent saves and recovers after timeout or an extension error", async function () {
    const broker = new ConversationSnapshotBroker();
    const timedOut = broker.request("old", url, 5).then(
      () => "unexpected",
      (err) => err.message,
    );
    const busy = await broker.request("new", url).then(
      () => "unexpected",
      (err) => err.message,
    );
    assert.include(busy, "already being saved");
    assert.include(await timedOut, "timed out");
    const failed = broker.request("new", url).then(
      () => "unexpected",
      (err) => err.message,
    );
    broker.submit({ id: "new", error: "Open this conversation" });
    assert.equal(await failed, "Open this conversation");
    assert.isNull(broker.poll());
  });

  it("removes executable elements, hostile metadata, and remote images at the receiver", function () {
    const html = sanitizeSnapshotHtml(
      `<html><head><base href="https://evil.test"><meta http-equiv="refresh" content="0;url=https://evil.test"><style>.card{color:blue}</style></head><body onload="evil()"><script>evil()</script><iframe srcdoc="oops"></iframe><form><input></form><a href="javascript:evil()">bad</a><a href="https://example.com">source</a><img src="https://evil.test/a" onerror="evil()"><svg><foreignObject x="10" y="20"><div onclick="evil()">前 1 个<script>evil()</script><iframe src="https://evil.test"></iframe></div></foreignObject><path d="M0 0L10 10"></path></svg></body></html>`,
    );
    assert.notMatch(
      html,
      /evil|<script|<iframe|<form|<input|<base|onload|onerror/i,
    );
    assert.include(html, '<a href="https://example.com">');
    assert.include(html, "<path");
    assert.include(html, "<foreignObject");
    assert.include(html, "前 1 个");
    assert.include(html, "default-src 'none'");
    assert.include(html, ".card{color:blue}");
  });

  it("stores the sanitized file on the original parent and removes temporary files on success and failure", async function () {
    const original = globalThis.Zotero;
    let removed = 0;
    let saved: any;
    let written = "";
    let fail = false;
    const parent = {
      id: 42,
      libraryID: 1,
      isRegularItem: () => true,
    } as Zotero.Item;
    globalThis.Zotero = {
      Libraries: { get: () => ({ editable: true, filesEditable: true }) },
      getTempDirectory: () => ({
        path: "/tmp/test.html",
        append() {},
        exists: () => true,
        remove: () => {
          removed++;
        },
      }),
      Utilities: { randomString: () => "unique" },
      File: {
        putContentsAsync: async (_file: unknown, html: string) => {
          written = html;
        },
      },
      Attachments: {
        importFromFile: async (options: unknown) => {
          saved = options;
          if (fail) throw new Error("disk full");
          return { id: 99 };
        },
      },
    } as unknown as typeof Zotero;
    try {
      await saveConversationSnapshotAttachment(
        { ...payload, version: 1 },
        parent,
      );
      assert.equal(saved.parentItemID, 42);
      assert.equal(saved.contentType, "text/html");
      assert.include(written, "Content-Security-Policy");
      assert.equal(removed, 1);
      fail = true;
      const error = await saveConversationSnapshotAttachment(
        { ...payload, version: 1 },
        parent,
      ).then(
        () => "unexpected",
        (err) => err.message,
      );
      assert.equal(error, "disk full");
      assert.equal(removed, 2);
    } finally {
      globalThis.Zotero = original;
    }
  });
});
