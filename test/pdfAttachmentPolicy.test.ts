import { assert } from "chai";
import {
  getZoteroAttachmentFilename,
  isZoteroPdfAttachmentCandidate,
} from "../src/modules/contextPanel/setupHandlers/controllers/pdfAttachmentPolicy";

describe("PDF attachment filename metadata", function () {
  it("uses recovered path metadata before trying other filename accessors", function () {
    let fallbackCalls = 0;
    const item = {
      isAttachment: () => true,
      attachmentContentType: "application/octet-stream",
      attachmentPath: "F:\\legacy\\paper.PDF",
      get attachmentFilename() {
        throw new Error("NS_ERROR_FILE_UNRECOGNIZED_PATH");
      },
      getFilename() {
        fallbackCalls++;
        throw new Error("invalid path");
      },
      getField() {
        fallbackCalls++;
        return "";
      },
    };
    assert.equal(getZoteroAttachmentFilename(item), "paper.PDF");
    assert.isTrue(isZoteroPdfAttachmentCandidate(item));
    assert.equal(fallbackCalls, 0);
  });

  it("retains legacy method fallbacks and isolates accessor failures", function () {
    assert.equal(
      getZoteroAttachmentFilename({ getFilename: () => "method.pdf" }),
      "method.pdf",
    );
    assert.equal(
      getZoteroAttachmentFilename({
        getFilename() {
          throw new Error("unavailable");
        },
        getField: () => "field.pdf",
      }),
      "field.pdf",
    );
    assert.equal(getZoteroAttachmentFilename(null), "");
  });
});
