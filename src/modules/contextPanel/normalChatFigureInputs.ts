import type { ChatParams } from "../../utils/llmClient";
import type { AdvancedModelParams, PaperContextRef } from "./types";
import { parseDocumentReferences } from "../../shared/documentReferences";
import { resolveProviderCapabilities } from "../../providers";
import { readAttachmentBytes } from "./attachmentStorage";

export type NormalChatFigureInputs = {
  images: string[];
  assistantInstruction?: string;
  warnings: string[];
};

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
  }
  return btoa(binary);
}

export async function resolveNormalChatFigureInputs(params: {
  query: string;
  papers: PaperContextRef[];
  model: string;
  apiBase?: string;
  apiKey?: string;
  authMode?: ChatParams["authMode"];
  providerProtocol?: ChatParams["providerProtocol"];
  reasoning?: ChatParams["reasoning"];
  advanced?: AdvancedModelParams;
}): Promise<NormalChatFigureInputs> {
  const figureReferences = parseDocumentReferences(params.query).filter(
    (reference) => reference.kind === "figure",
  );
  if (!figureReferences.length || !params.papers.length) {
    return { images: [], warnings: [] };
  }
  const normalizedQuery = params.query
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const explicitlyNamedPapers = params.papers.filter((paper) => {
    const title = paper.title.toLocaleLowerCase().replace(/\s+/g, " ").trim();
    return title.length >= 4 && normalizedQuery.includes(title);
  });
  const targetPapers = explicitlyNamedPapers.length
    ? explicitlyNamedPapers
    : params.papers.slice(0, 1);
  const capabilities = resolveProviderCapabilities({
    model: params.model,
    apiBase: params.apiBase,
    authMode: params.authMode,
    protocol: params.providerProtocol,
    inputMode: params.advanced?.inputMode,
  });
  if (!capabilities.images) {
    return {
      images: [],
      warnings: [],
      assistantInstruction:
        "The selected model cannot inspect figure images. Base the figure explanation only on captions and surrounding paper text, and state that visual interpretation was unavailable.",
    };
  }

  try {
    const [
      { PdfService },
      { PdfPageService },
      { PdfFigureExtractionService },
      { ZoteroGateway },
    ] = await Promise.all([
      import("../../agent/services/pdfService"),
      import("../../agent/services/pdfPageService"),
      import("../../agent/services/pdfFigureExtractionService"),
      import("../../agent/services/zoteroGateway"),
    ]);
    const pdfService = new PdfService();
    const zoteroGateway = new ZoteroGateway();
    const pageService = new PdfPageService(pdfService, zoteroGateway);
    const extractionService = new PdfFigureExtractionService(pageService);
    const result = await extractionService.extractFigures({
      input: { query: params.query },
      context: {
        request: {
          conversationKey: 0,
          mode: "agent",
          userText: params.query,
          selectedPaperContexts: targetPapers,
          model: params.model,
          apiBase: params.apiBase,
          apiKey: params.apiKey,
          providerProtocol: params.providerProtocol,
          reasoning: params.reasoning,
          advanced: params.advanced,
        },
        item: null,
        currentAnswerText: "",
        modelName: params.model,
      } as never,
      paperContexts: targetPapers,
    });
    const mineruImagePaths = new Set(
      (result.figures || [])
        .filter((figure) => typeof figure.imagePath === "string")
        .map((figure) => String(figure.imagePath)),
    );
    const images: string[] = [];
    for (const artifact of result.artifacts || []) {
      if (
        artifact.kind !== "image" ||
        !artifact.storedPath ||
        !mineruImagePaths.has(artifact.storedPath)
      ) {
        continue;
      }
      const bytes = await readAttachmentBytes(artifact.storedPath);
      images.push(
        `data:${artifact.mimeType || "image/png"};base64,${encodeBase64(bytes)}`,
      );
    }
    if (images.length) {
      return {
        images,
        warnings: result.warnings || [],
        assistantInstruction:
          "The MinerU-mapped figure image is attached together with its caption and surrounding paper text. Inspect the complete image before making visual claims, and preserve any mapping warnings.",
      };
    }
    return {
      images: [],
      warnings: result.warnings || [],
      assistantInstruction:
        "No MinerU-mapped figure image was available. Base the explanation only on captions and surrounding paper text, state that limitation, and do not make unsupported visual claims.",
    };
  } catch (error) {
    return {
      images: [],
      warnings: [error instanceof Error ? error.message : String(error)],
      assistantInstruction:
        "Figure extraction failed. Base the explanation only on captions and surrounding paper text, state that limitation, and do not make unsupported visual claims.",
    };
  }
}
