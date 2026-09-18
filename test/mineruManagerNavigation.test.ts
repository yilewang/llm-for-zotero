import { assert } from "chai";
import {
  clearMineruManagerNavigationForTests,
  collectMineruPdfAttachmentIds,
  hasPendingMineruManagerOpenRequest,
  hasPendingMineruManagerSelection,
  registerMineruManagerOpenTarget,
  registerMineruManagerSelectionTarget,
  requestMineruManagerOpen,
  requestMineruManagerSelection,
} from "../src/modules/mineruManagerNavigation";

function attachment(
  id: number,
  contentType: string,
  libraryID = 1,
): Zotero.Item {
  return {
    id,
    libraryID,
    isRegularItem: () => false,
    isAttachment: () => true,
    attachmentContentType: contentType,
  } as unknown as Zotero.Item;
}

function regularItem(
  id: number,
  attachmentIds: number[],
  libraryID = 1,
): Zotero.Item {
  return {
    id,
    libraryID,
    isRegularItem: () => true,
    isAttachment: () => false,
    getAttachments: () => attachmentIds,
  } as unknown as Zotero.Item;
}

describe("mineruManagerNavigation", function () {
  afterEach(function () {
    clearMineruManagerNavigationForTests();
  });

  it("collects PDF children and direct PDF selections without duplicates", function () {
    const pdfA = attachment(11, "application/pdf");
    const pdfB = attachment(12, "application/pdf");
    const html = attachment(13, "text/html");
    const itemById = new Map<number, Zotero.Item>([
      [11, pdfA],
      [12, pdfB],
      [13, html],
    ]);

    assert.deepEqual(
      collectMineruPdfAttachmentIds(
        [regularItem(1, [11, 12, 13]), pdfA],
        (id) => itemById.get(id),
        1,
      ),
      [11, 12],
    );
  });

  it("collects PDFs across multiple parents while skipping missing children", function () {
    const firstPdf = attachment(21, "application/pdf");
    const secondPdf = attachment(22, "application/pdf");
    const itemById = new Map<number, Zotero.Item>([
      [21, firstPdf],
      [22, secondPdf],
    ]);

    assert.deepEqual(
      collectMineruPdfAttachmentIds(
        [regularItem(1, [21, 99]), regularItem(2, [22, 100])],
        (id) => {
          if (id === 100) throw new Error("stale Zotero item");
          return itemById.get(id);
        },
        1,
      ),
      [21, 22],
    );
  });

  it("ignores PDFs from libraries the MinerU manager cannot display", function () {
    const userPdf = attachment(31, "application/pdf", 1);
    const groupPdf = attachment(32, "application/pdf", 2);
    const itemById = new Map<number, Zotero.Item>([
      [31, userPdf],
      [32, groupPdf],
    ]);

    assert.deepEqual(
      collectMineruPdfAttachmentIds(
        [regularItem(1, [31], 1), regularItem(2, [32], 2), groupPdf],
        (id) => itemById.get(id),
        1,
      ),
      [31],
    );
  });

  it("keeps an open request pending until the preferences MinerU target is ready", function () {
    requestMineruManagerOpen();
    assert.isTrue(hasPendingMineruManagerOpenRequest());

    let openCount = 0;
    registerMineruManagerOpenTarget(() => {
      openCount += 1;
      return true;
    });

    assert.equal(openCount, 1);
    assert.isFalse(hasPendingMineruManagerOpenRequest());

    requestMineruManagerOpen();
    assert.equal(openCount, 2);
    assert.isFalse(hasPendingMineruManagerOpenRequest());
  });

  it("keeps a selection pending until a MinerU manager target is ready", function () {
    assert.isTrue(requestMineruManagerSelection([22, 21, 22]));
    assert.isTrue(hasPendingMineruManagerSelection());

    let received: readonly number[] = [];
    registerMineruManagerSelectionTarget((attachmentIds) => {
      received = [...attachmentIds];
      return true;
    });

    assert.deepEqual(received, [22, 21]);
    assert.isFalse(hasPendingMineruManagerSelection());
  });

  it("delivers a later selection immediately to an active manager", function () {
    const received: number[][] = [];
    const unregister = registerMineruManagerSelectionTarget((attachmentIds) => {
      received.push([...attachmentIds]);
      return true;
    });

    assert.isTrue(requestMineruManagerSelection([31, 32]));
    assert.deepEqual(received, [[31, 32]]);
    assert.isFalse(hasPendingMineruManagerSelection());

    unregister();
    assert.isTrue(requestMineruManagerSelection([33]));
    assert.isTrue(hasPendingMineruManagerSelection());
  });
});
