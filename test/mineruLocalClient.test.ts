import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { strToU8, zipSync } from "fflate";
import { parsePdfWithMineruLocal } from "../src/utils/mineruClient";
import type { MineruLocalOptions } from "../src/utils/mineruConfig";

describe("mineru local client", function () {
  const globalScope = globalThis as typeof globalThis & {
    IOUtils?: unknown;
    ztoolkit?: unknown;
  };
  const originalIOUtils = globalScope.IOUtils;
  const originalZtoolkit = globalScope.ztoolkit;
  const originalFetch = globalThis.fetch;
  const originalFormData = globalThis.FormData;
  const originalBlob = globalThis.Blob;

  beforeEach(function () {
    globalScope.IOUtils = {
      read: async () => strToU8("%PDF-1.7\n"),
    };
    globalScope.ztoolkit = {
      log: () => undefined,
      getGlobal: (name: string) =>
        name === "fetch" ? globalThis.fetch : undefined,
    };
  });

  afterEach(function () {
    globalScope.IOUtils = originalIOUtils;
    globalScope.ztoolkit = originalZtoolkit;
    globalThis.fetch = originalFetch;
    globalThis.FormData = originalFormData;
    globalThis.Blob = originalBlob;
  });

  it("uploads to /file_parse and extracts the returned ZIP", async function () {
    const zipBytes = zipSync({
      "full.md": strToU8("# Parsed\nbody"),
      "images/fig.png": new Uint8Array([1, 2, 3]),
    });
    let requestedUrl = "";
    let body: unknown;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      body = init?.body;
      return new Response(zipBytes, {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    }) as typeof fetch;

    const options: MineruLocalOptions = {
      baseUrl: "http://127.0.0.1:8000",
      host: "127.0.0.1",
      port: "8000",
      language: "ch",
      backend: "hybrid-auto-engine",
      parseMethod: "auto",
      formulaEnable: true,
      tableEnable: true,
    };
    const result = await parsePdfWithMineruLocal("/tmp/paper.pdf", options);

    assert.equal(requestedUrl, "http://127.0.0.1:8000/file_parse");
    assert.instanceOf(body, FormData);
    assert.equal(result?.mdContent, "# Parsed\nbody");
    assert.sameMembers(
      result?.files.map((file) => file.relativePath) || [],
      ["full.md", "images/fig.png"],
    );
  });

  it("falls back to manual multipart when FormData is unavailable", async function () {
    const zipBytes = zipSync({
      "full.md": strToU8("# Parsed\nbody"),
    });
    let contentType = "";
    let body: unknown;
    globalThis.FormData = undefined as unknown as typeof FormData;
    globalThis.Blob = undefined as unknown as typeof Blob;
    globalScope.ztoolkit = {
      log: () => undefined,
      getGlobal: (name: string) =>
        name === "fetch" ? globalThis.fetch : undefined,
    };
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      assert.equal(String(input), "http://127.0.0.1:8000/file_parse");
      contentType = String(
        (init?.headers as Record<string, string>)?.["Content-Type"] || "",
      );
      body = init?.body;
      return new Response(zipBytes, {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    }) as typeof fetch;

    const options: MineruLocalOptions = {
      baseUrl: "http://127.0.0.1:8000",
      host: "127.0.0.1",
      port: "8000",
      language: "ch",
      backend: "hybrid-auto-engine",
      parseMethod: "auto",
      formulaEnable: true,
      tableEnable: true,
    };
    const result = await parsePdfWithMineruLocal("/tmp/paper.pdf", options);

    assert.match(contentType, /^multipart\/form-data; boundary=/);
    assert.instanceOf(body, Uint8Array);
    const bodyText = new TextDecoder().decode(body as Uint8Array);
    assert.include(bodyText, 'name="files"; filename="paper.pdf"');
    assert.include(bodyText, 'name="response_format_zip"');
    assert.equal(result?.mdContent, "# Parsed\nbody");
  });
});
