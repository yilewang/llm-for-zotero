import { afterEach, describe, expect, it } from "vitest";
import { collectLocalPdfs } from "../src/local-pdf.js";

function resource(absolutePath: string) {
  return {
    kind: "local_pdf",
    sourceKey: "zotero-pdf:7:7",
    itemId: 7,
    contextItemId: 7,
    title: "Paper",
    name: "paper.pdf",
    mimeType: "application/pdf",
    absolutePath,
  };
}

const posixOnly = process.platform === "win32" ? describe.skip : describe;

posixOnly("collectLocalPdfs on POSIX", () => {
  it("maps a Windows drive-letter path onto the WSL automount root", () => {
    const [pdf] = collectLocalPdfs({
      localDocuments: [
        resource("C:\\Users\\yche\\Zotero\\storage\\AB12\\paper.pdf"),
      ],
    });
    expect(pdf.absolutePath).toBe(
      "/mnt/c/Users/yche/Zotero/storage/AB12/paper.pdf",
    );
  });

  it("accepts forward slashes after the drive letter", () => {
    const [pdf] = collectLocalPdfs({
      localDocuments: [resource("D:/papers/paper.pdf")],
    });
    expect(pdf.absolutePath).toBe("/mnt/d/papers/paper.pdf");
  });

  afterEach(() => {
    delete process.env.ADAPTER_WINDOWS_DRIVE_MOUNT_ROOT;
  });

  it("honours a non-default automount root", () => {
    process.env.ADAPTER_WINDOWS_DRIVE_MOUNT_ROOT = "/windows/";
    const [pdf] = collectLocalPdfs({
      localDocuments: [resource("C:\\papers\\paper.pdf")],
    });
    expect(pdf.absolutePath).toBe("/windows/c/papers/paper.pdf");
  });

  it("still rejects a UNC path, which has no mount to map onto", () => {
    expect(() =>
      collectLocalPdfs({
        localDocuments: [resource("\\\\server\\share\\paper.pdf")],
      }),
    ).toThrow("Invalid local PDF resource batch.");
  });

  it("leaves a POSIX absolute path untouched", () => {
    const [pdf] = collectLocalPdfs({
      localDocuments: [resource("/home/yche/paper.pdf")],
    });
    expect(pdf.absolutePath).toBe("/home/yche/paper.pdf");
  });
});
