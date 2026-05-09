import { assert } from "chai";
import {
  buildManualMultipartBody,
  buildMultipartRequest,
} from "../src/utils/multipart";

describe("multipart", function () {
  it("builds a sanitized manual multipart body", function () {
    const result = buildManualMultipartBody(
      [
        { name: 'purpose"\r\nx', value: "assistants" },
        {
          name: "file",
          filename: 'paper"\n.pdf',
          contentType: "application/pdf",
          data: new Uint8Array([1, 2, 3]),
        },
      ],
      { boundaryPrefix: "TestBoundary" },
    );

    assert.match(result.contentType, /^multipart\/form-data; boundary=/);

    const bodyText = new TextDecoder().decode(result.body);
    assert.include(bodyText, 'name="purpose___x"');
    assert.include(bodyText, 'filename="paper__.pdf"');
    assert.include(bodyText, "Content-Type: application/pdf");
    assert.include(bodyText, "assistants");
  });

  it("prefers FormData and lets fetch set multipart Content-Type", function () {
    class FakeBlob {
      readonly parts: unknown[];
      readonly options?: { type?: string };

      constructor(parts: unknown[], options?: { type?: string }) {
        this.parts = parts;
        this.options = options;
      }
    }

    class FakeFormData {
      readonly fields: Array<{
        name: string;
        value: unknown;
        filename?: string;
      }> = [];

      append(name: string, value: unknown, filename?: string): void {
        this.fields.push({ name, value, filename });
      }
    }

    const globals = globalThis as unknown as {
      Blob?: typeof Blob;
      FormData?: typeof FormData;
    };
    const originalBlob = globals.Blob;
    const originalFormData = globals.FormData;

    try {
      globals.Blob = FakeBlob as unknown as typeof Blob;
      globals.FormData = FakeFormData as unknown as typeof FormData;

      const result = buildMultipartRequest(
        [
          { name: "purpose", value: "assistants" },
          {
            name: "file",
            filename: "paper.pdf",
            contentType: "application/pdf",
            data: new Uint8Array([1, 2, 3]),
          },
        ],
        { preferFormData: true },
      );

      assert.equal(result.mode, "formdata");
      assert.isUndefined(result.contentType);
      assert.instanceOf(result.body, FakeFormData);

      const body = result.body as unknown as FakeFormData;
      assert.deepEqual(body.fields[0], {
        name: "purpose",
        value: "assistants",
        filename: undefined,
      });
      assert.equal(body.fields[1].name, "file");
      assert.equal(body.fields[1].filename, "paper.pdf");

      const fileBlob = body.fields[1].value as FakeBlob;
      assert.instanceOf(fileBlob, FakeBlob);
      assert.deepEqual(fileBlob.parts, [new Uint8Array([1, 2, 3])]);
      assert.deepEqual(fileBlob.options, { type: "application/pdf" });
    } finally {
      if (originalBlob) globals.Blob = originalBlob;
      else delete globals.Blob;
      if (originalFormData) globals.FormData = originalFormData;
      else delete globals.FormData;
    }
  });

  it("falls back to manual when FormData/Blob are unavailable", function () {
    const globals = globalThis as unknown as {
      Blob?: typeof Blob;
      FormData?: typeof FormData;
    };
    const originalBlob = globals.Blob;
    const originalFormData = globals.FormData;
    const originalToolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;

    try {
      delete globals.Blob;
      delete globals.FormData;
      (globalThis as { ztoolkit?: unknown }).ztoolkit = {
        getGlobal: () => undefined,
      };

      const result = buildMultipartRequest(
        [
          { name: "purpose", value: "assistants" },
          {
            name: "file",
            filename: "paper.pdf",
            contentType: "application/pdf",
            data: new Uint8Array([1, 2, 3]),
          },
        ],
        { preferFormData: true, boundaryPrefix: "FallbackBoundary" },
      );

      assert.equal(result.mode, "manual");
      assert.match(
        result.contentType ?? "",
        /^multipart\/form-data; boundary=----FallbackBoundary/,
      );
      assert.instanceOf(result.body, Uint8Array);

      const bodyText = new TextDecoder().decode(result.body as Uint8Array);
      assert.include(bodyText, 'name="purpose"');
      assert.include(bodyText, "assistants");
      assert.include(bodyText, 'filename="paper.pdf"');
      assert.include(bodyText, "Content-Type: application/pdf");
    } finally {
      if (originalBlob) globals.Blob = originalBlob;
      if (originalFormData) globals.FormData = originalFormData;
      if (originalToolkit !== undefined) {
        (globalThis as { ztoolkit?: unknown }).ztoolkit = originalToolkit;
      } else {
        delete (globalThis as { ztoolkit?: unknown }).ztoolkit;
      }
    }
  });
});
