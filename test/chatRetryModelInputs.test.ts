import { assert } from "chai";
import {
  resolveRetryModelInputsForTests,
  type EffectiveRequestConfig,
} from "../src/modules/contextPanel/chat";
import type {
  ChatAttachment,
  Message,
} from "../src/modules/contextPanel/types";

describe("chat retry model inputs", function () {
  const visiblePdf: ChatAttachment = {
    id: "pdf-paper-123-1",
    name: "paper.pdf",
    mimeType: "application/pdf",
    sizeBytes: 10,
    category: "pdf",
    storedPath: "/tmp/paper.pdf",
  };

  const visionConfig: EffectiveRequestConfig = {
    model: "third-party-vision",
    apiBase: "https://example.test/v1",
    apiKey: "",
    authMode: "api_key",
    providerProtocol: "openai_chat_compat",
    modelEntryId: "vision-entry",
    modelProviderLabel: "OpenAI compatible",
    reasoning: undefined,
    advanced: undefined,
  };

  function retryUserMessage(): Message {
    return {
      role: "user",
      text: "Read this PDF",
      timestamp: 1,
      attachments: [visiblePdf],
      modelAttachments: [],
      modelName: visionConfig.model,
      modelEntryId: visionConfig.modelEntryId,
      modelProviderLabel: visionConfig.modelProviderLabel,
    };
  }

  it("reuses the provider-safe split for same-provider vision PDF retry", async function () {
    const screenshotImages = ["data:image/png;base64,abc"];

    const result = await resolveRetryModelInputsForTests({
      userMessage: retryUserMessage(),
      visibleAttachments: [visiblePdf],
      screenshotImages,
      effectiveRequestConfig: visionConfig,
    });

    assert.deepEqual(result.modelAttachments, []);
    assert.deepEqual(result.screenshotImages, screenshotImages);
  });

  it("recomputes PDF handling when retry switches to a native PDF provider", async function () {
    const nativeConfig: EffectiveRequestConfig = {
      ...visionConfig,
      model: "gpt-4.1",
      apiBase: "https://api.openai.com/v1",
      providerProtocol: "responses_api",
      modelEntryId: "openai-entry",
      modelProviderLabel: "OpenAI",
    };

    const result = await resolveRetryModelInputsForTests({
      userMessage: retryUserMessage(),
      visibleAttachments: [visiblePdf],
      screenshotImages: [],
      effectiveRequestConfig: nativeConfig,
    });

    assert.lengthOf(result.modelAttachments || [], 1);
    assert.equal(result.modelAttachments?.[0]?.id, visiblePdf.id);
    assert.equal(result.modelAttachments?.[0]?.category, "pdf");
  });

  it("drops PDF model attachments when retry switches to a text-only model", async function () {
    const textOnlyConfig: EffectiveRequestConfig = {
      ...visionConfig,
      model: "deepseek-reasoner",
      modelEntryId: "deepseek-entry",
      modelProviderLabel: "DeepSeek",
    };

    const result = await resolveRetryModelInputsForTests({
      userMessage: retryUserMessage(),
      visibleAttachments: [visiblePdf],
      screenshotImages: [],
      effectiveRequestConfig: textOnlyConfig,
    });

    assert.deepEqual(result.modelAttachments, []);
  });
});
