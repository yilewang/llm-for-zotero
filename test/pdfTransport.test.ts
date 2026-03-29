import { assert } from "chai";
import {
  buildPdfPartForChat,
  buildPdfPartForResponses,
} from "../src/providers/pdfTransport";

describe("pdf transport", function () {
  it("builds OpenAI/native Responses file-id payloads", function () {
    assert.deepEqual(
      buildPdfPartForResponses({
        request: {
          model: "gpt-5.4",
          protocol: "responses_api",
          apiBase: "https://api.openai.com/v1/responses",
          authMode: "api_key",
        },
        filename: "paper.pdf",
        fileIds: ["file-123"],
      }),
      [{ type: "input_file", file_id: "file-123" }],
    );
  });

  it("builds inline Responses file_data payloads for third-party providers", function () {
    assert.deepEqual(
      buildPdfPartForResponses({
        request: {
          model: "gpt-5.4",
          protocol: "responses_api",
          apiBase: "https://openrouter.ai/api/v1/responses",
          authMode: "api_key",
        },
        filename: "paper.pdf",
        dataUrl: "data:application/pdf;base64,AAA",
      }),
      [
        {
          type: "input_file",
          filename: "paper.pdf",
          file_data: "data:application/pdf;base64,AAA",
        },
      ],
    );
  });

  it("builds inline chat file parts for third-party chat providers", function () {
    assert.deepEqual(
      buildPdfPartForChat({
        request: {
          model: "gpt-5.4",
          protocol: "openai_chat_compat",
          apiBase: "https://openrouter.ai/api/v1/chat/completions",
          authMode: "api_key",
        },
        filename: "paper.pdf",
        dataUrl: "data:application/pdf;base64,AAA",
      }),
      [
        {
          type: "file",
          file: {
            filename: "paper.pdf",
            file_data: "data:application/pdf;base64,AAA",
          },
        },
      ],
    );
  });
});
