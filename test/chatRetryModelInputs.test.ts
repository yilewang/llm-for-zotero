import { assert } from "chai";
import {
  QUOTE_RENDER_OCCURRENCE_PATTERN,
  buildAssistantDisplayMarkdownForRender,
  buildRenderedMarkdownClipboardPayload,
  resolveRetryModelInputsForTests,
  type EffectiveRequestConfig,
} from "../src/modules/contextPanel/chat";
import { buildQuoteCitation } from "../src/modules/contextPanel/quoteCitations";
import type {
  ChatAttachment,
  Message,
} from "../src/modules/contextPanel/types";
import { FULL_PDF_UNSUPPORTED_MESSAGE } from "../src/modules/contextPanel/pdfSupportMessages";

describe("chat retry model inputs", function () {
  const visiblePdf: ChatAttachment = {
    id: "pdf-paper-123-1",
    name: "paper.pdf",
    mimeType: "application/pdf",
    sizeBytes: 10,
    category: "pdf",
    storedPath: "/tmp/paper.pdf",
  };

  it("converts known quote anchors into render occurrence markers for interactive assistant rendering", function () {
    const quoteCitation = buildQuoteCitation({
      quoteText: "Rendered quote anchors should not leak.",
      citationLabel: "(Lee, 2026)",
      contextItemId: 42,
    });
    assert.isDefined(quoteCitation);

    const rendered = buildAssistantDisplayMarkdownForRender({
      text: `Evidence:\n\n[[quote:${quoteCitation!.id}]]`,
      quoteCitations: [quoteCitation!],
    });

    assert.include(rendered, "[[quote-occurrence:");
    assert.notInclude(rendered, `[[quote:${quoteCitation!.id}]]`);
    assert.notInclude(rendered, "> Rendered quote anchors");
    assert.notInclude(rendered, "(Lee, 2026)");
  });

  it("isolates preserved quote anchors from following assistant prose", function () {
    const quoteCitation = buildQuoteCitation({
      quoteText: "Quote card boundaries should remain block-level.",
      citationLabel: "(Lee, 2026)",
      contextItemId: 42,
    });
    assert.isDefined(quoteCitation);

    const rendered = buildAssistantDisplayMarkdownForRender({
      text: `Evidence:\n\n[[quote:${quoteCitation!.id}]]\nSo **one component** handles all angles.`,
      quoteCitations: [quoteCitation!],
    });

    assert.include(rendered, "[[quote-occurrence:");
    assert.include(rendered, "]]\n\nSo **one");
    assert.notInclude(rendered, `[[quote:${quoteCitation!.id}]]`);
    assert.notInclude(rendered, "> Quote card boundaries");
  });

  it("isolates preserved quote anchors in nested lists from emphasized continuation text", function () {
    const quoteCitation = buildQuoteCitation({
      quoteText:
        "We trained and tested non-linear decoders on every recording session pair.",
      citationLabel: "(Carrasco et al., 2026)",
      contextItemId: 42,
    });
    assert.isDefined(quoteCitation);

    const rendered = buildAssistantDisplayMarkdownForRender({
      text: [
        "- **Decoding and Classification:**",
        "  - **Head Direction Decoding:** Non-linear decoders were trained.",
        "",
        `    [[quote:${quoteCitation!.id}]]`,
        "*Environment Classification:* Classifiers were trained.",
      ].join("\n"),
      quoteCitations: [quoteCitation!],
    });

    assert.include(rendered, "]]\n\n*Environment Classification:*");
    assert.include(rendered, "[[quote-occurrence:");
    assert.notInclude(rendered, `[[quote:${quoteCitation!.id}]]`);
    assert.notInclude(rendered, "(Carrasco et al., 2026)");
    assert.notInclude(rendered, "> We trained");
  });

  it("omits unresolved quote anchors in assistant bubbles", function () {
    const rendered = buildAssistantDisplayMarkdownForRender({
      text: "Evidence:\n\n[[quote:Q_missing]]\n\nContinue.",
      quoteCitations: [],
    });

    assert.include(rendered, "Evidence");
    assert.include(rendered, "Continue.");
    assert.notInclude(rendered, "[[quote:");
    assert.notInclude(rendered, "[quote unavailable]");
  });

  it("expands quote anchors in rendered clipboard payloads", function () {
    const quoteCitation = buildQuoteCitation({
      quoteText: "Clipboard quote anchors should not leak.",
      citationLabel: "(Lee, 2026)",
      contextItemId: 42,
    });
    assert.isDefined(quoteCitation);

    const payload = buildRenderedMarkdownClipboardPayload(
      `Evidence:\n\n[[quote:${quoteCitation!.id}]]`,
      [quoteCitation!],
    );

    assert.isNotNull(payload);
    assert.include(payload!.plainText, "> Clipboard quote anchors");
    assert.include(payload!.plainText, "(Lee, 2026)");
    assert.notInclude(payload!.plainText, "[[quote:");
    assert.include(payload!.renderedHtml, "<blockquote>");
    assert.notInclude(payload!.renderedHtml, "[[quote:");
  });

  it("expands legacy markdown-only quote blocks in rendered clipboard payloads", function () {
    const payload = buildRenderedMarkdownClipboardPayload(
      [
        "Evidence:",
        "",
        "> Legacy quote blocks should remain useful for old history.",
        ">",
        "> (Rentzeperis et al., 2026)",
      ].join("\n"),
      undefined,
    );

    assert.isNotNull(payload);
    assert.include(payload!.plainText, "> Legacy quote blocks");
    assert.include(payload!.plainText, "(Rentzeperis et al., 2026)");
    assert.notInclude(payload!.plainText, "[[quote");
    assert.include(payload!.renderedHtml, "<blockquote>");
  });

  it("does not restore a rejected quote attribution in clipboard output", function () {
    const quote =
      "This interpretation has no searchable wording in the complete source.";
    const payload = buildRenderedMarkdownClipboardPayload(
      `> ${quote}\n>\n> Not a source quote`,
      undefined,
    );

    assert.equal(payload?.plainText, `> ${quote}\n>\n> Not a source quote`);
    assert.notInclude(payload?.renderedHtml || "", "Eppler");
    assert.include(payload?.renderedHtml || "", "<blockquote>");
  });

  it("renders expanded quote anchors before emphasized continuation text in clipboard payloads", function () {
    const quoteCitation = buildQuoteCitation({
      quoteText:
        "The primary measures were the absolute change in preferred direction.",
      citationLabel: "(Carrasco et al., 2026)",
      contextItemId: 42,
    });
    assert.isDefined(quoteCitation);

    const payload = buildRenderedMarkdownClipboardPayload(
      [
        "- **Stability Metrics:** Primary measures were compared across days.",
        "",
        `[[quote:${quoteCitation!.id}]]`,
        "*Environment Classification:* Classifiers were trained.",
      ].join("\n"),
      [quoteCitation!],
    );

    assert.isNotNull(payload);
    assert.include(payload!.plainText, "> The primary measures");
    assert.include(payload!.plainText, "(Carrasco et al., 2026)");
    assert.notInclude(payload!.plainText, "[[quote:");
    assert.include(payload!.renderedHtml, "<blockquote>");
    assert.include(
      payload!.renderedHtml,
      "<p>(Carrasco et al., 2026)</p></blockquote><p><em>Environment Classification:</em> Classifiers were trained.</p>",
    );
    assert.notInclude(
      payload!.renderedHtml,
      "(Carrasco et al., 2026) <em>Environment Classification:</em>",
    );
    assert.notInclude(payload!.renderedHtml, "*Environment Classification:*");
  });

  it("renders expanded quote anchors before unordered continuation text in clipboard payloads", function () {
    const quoteCitation = buildQuoteCitation({
      quoteText:
        "The primary measures were the absolute change in preferred direction.",
      citationLabel: "(Carrasco et al., 2026)",
      contextItemId: 42,
    });
    assert.isDefined(quoteCitation);

    const payload = buildRenderedMarkdownClipboardPayload(
      [
        `[[quote:${quoteCitation!.id}]]`,
        "- **Environment Classification:** Classifiers were trained.",
      ].join("\n"),
      [quoteCitation!],
    );

    assert.isNotNull(payload);
    assert.include(payload!.renderedHtml, "<blockquote>");
    assert.include(
      payload!.renderedHtml,
      "</blockquote><ul><li><strong>Environment Classification:</strong> Classifiers were trained.</li></ul>",
    );
    assert.notInclude(
      payload!.renderedHtml,
      "(Carrasco et al., 2026) - <strong>Environment",
    );
  });

  it("omits unresolved quote anchors in clipboard payloads", function () {
    const payload = buildRenderedMarkdownClipboardPayload(
      "Evidence:\n\n[[quote:Q_missing]]\n\nContinue.",
      [],
    );

    assert.isNotNull(payload);
    assert.include(payload!.plainText, "Evidence");
    assert.include(payload!.plainText, "Continue.");
    assert.notInclude(payload!.plainText, "[[quote:");
    assert.notInclude(payload!.plainText, "[quote unavailable]");
    assert.notInclude(payload!.renderedHtml, "[[quote:");
    assert.notInclude(payload!.renderedHtml, "[quote unavailable]");
  });

  it("converts untrusted leaked source metadata quotes before assistant rendering", function () {
    const rendered = buildAssistantDisplayMarkdownForRender({
      text: '"our results provide evidence that the activity of dynamic engrams..." [[source=(Tomé, 2024), section=Dynamic and selective engrams emerge with memory consolidation, chunk=28]]',
      quoteCitations: [],
    });

    assert.include(rendered, "[[quote-occurrence:");
    assert.notInclude(rendered, "> our results provide evidence");
    assert.notInclude(rendered, "(Tomé, 2024)");
    assert.notInclude(rendered, "[[source=");
    assert.notInclude(rendered, "section=");
    assert.notInclude(rendered, "chunk=");
  });

  it("preserves untrusted leaked source metadata quotes in clipboard payloads", function () {
    const payload = buildRenderedMarkdownClipboardPayload(
      '"our model predicted that memory engrams are highly dynamic" [[source=(Tomé, 2024), section=Dynamic and selective engrams emerge with memory consolidation, chunk=8]]',
      [],
    );

    assert.isNotNull(payload);
    assert.include(payload!.plainText, "> our model predicted");
    assert.include(payload!.plainText, "(Tomé, 2024)");
    assert.include(payload!.renderedHtml, "<blockquote>");
    assert.notInclude(payload!.plainText, "[[source=");
    assert.notInclude(payload!.renderedHtml, "section=");
  });

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

  it("fails same-provider retries when the target no longer supports full PDF mode", async function () {
    const screenshotImages = ["data:image/png;base64,abc"];

    try {
      await resolveRetryModelInputsForTests({
        userMessage: retryUserMessage(),
        visibleAttachments: [visiblePdf],
        screenshotImages,
        effectiveRequestConfig: visionConfig,
      });
      assert.fail("Expected non-native PDF retry to reject");
    } catch (err) {
      assert.equal(
        err instanceof Error ? err.message : String(err),
        FULL_PDF_UNSUPPORTED_MESSAGE,
      );
    }
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

  it("fails PDF retries when retry switches to a text-only model", async function () {
    const textOnlyConfig: EffectiveRequestConfig = {
      ...visionConfig,
      model: "local-text-only",
      modelEntryId: "text-only-entry",
      modelProviderLabel: "Local text-only",
    };

    try {
      await resolveRetryModelInputsForTests({
        userMessage: retryUserMessage(),
        visibleAttachments: [visiblePdf],
        screenshotImages: [],
        effectiveRequestConfig: textOnlyConfig,
      });
      assert.fail("Expected text-only PDF retry to reject");
    } catch (err) {
      assert.equal(
        err instanceof Error ? err.message : String(err),
        FULL_PDF_UNSUPPORTED_MESSAGE,
      );
    }
  });

  it("fails Moonshot PDF retries before provider upload preparation", async function () {
    const missingStoredPathPdf: ChatAttachment = {
      id: "pdf-paper-123-1",
      name: "paper.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      category: "pdf",
    };
    const uploadConfig: EffectiveRequestConfig = {
      ...visionConfig,
      model: "kimi-k2.5",
      apiBase: "https://api.moonshot.cn/v1",
      apiKey: "test-key",
      modelEntryId: "kimi-entry",
      modelProviderLabel: "Kimi",
    };

    try {
      await resolveRetryModelInputsForTests({
        userMessage: {
          ...retryUserMessage(),
          attachments: [missingStoredPathPdf],
        },
        visibleAttachments: [missingStoredPathPdf],
        screenshotImages: [],
        effectiveRequestConfig: uploadConfig,
      });
      assert.fail("Expected Moonshot PDF retry to reject");
    } catch (err) {
      assert.equal(
        err instanceof Error ? err.message : String(err),
        FULL_PDF_UNSUPPORTED_MESSAGE,
      );
    }
  });
});
