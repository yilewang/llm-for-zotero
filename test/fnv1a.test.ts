import { assert } from "chai";
import { fnv1a32, fnv1a32Raw } from "../src/utils/fnv1a";
import { buildActionCallDigest } from "../src/agent/authorization/proposal";
import { fingerprintText } from "../src/agent/contracts/actionOperationEvidence";
import { digestCacheKey } from "../src/agent/digests/paperDigestWorker";
import { buildSkillProfileSignature } from "../src/agent/skills/nativeSkillPaths";
import { createAgentToolResultHandleRecord } from "../src/agent/store/toolResultHandles";
import { buildInstructionInventory } from "../src/agent/model/instructionInventory";
import { getDefaultClaudeManagedInstructionBlock } from "../src/claudeCode/bootstrap";
import { buildClaudeProfileSignature } from "../src/claudeCode/projectSkills";
import { buildCitationQuoteHash } from "../src/modules/contextPanel/citationNavigationCache";
import { quoteValidationCacheKey } from "../src/modules/contextPanel/quoteValidation/caches";
import { buildPinnedSelectedTextKey } from "../src/modules/contextPanel/setupHandlers/controllers/pinnedContextController";
import { buildPdfFigureCropStableHash } from "../src/services/pdf/pdfFigureCropCache";
import { buildQuoteCitationId } from "../src/services/quotes/quoteCitations";
import { buildProfileSignature } from "../src/shared/conversationRegistry";
import { buildDocumentFingerprint } from "../src/shared/exhaustiveDocumentReader";
import type { PaperContextRef } from "../src/shared/types";
import type { PdfContext } from "../src/services/paperContent/types";
import { fingerprintSecret } from "../src/utils/secretFingerprint";
import { buildWebSourceId } from "../src/webAccess/tavilyClient";

const UNICODE_SAMPLE = "Zürich – 文献 🧠 naïve";

/** The two inline forms the call sites used before they shared one owner. */
function inlineFinalMask(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function inlinePerStepMask(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function seededStrings(count: number): string[] {
  let seed = 12345;
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed;
  };
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const length = next() % 64;
    let text = "";
    for (let j = 0; j < length; j += 1) {
      // Cover ASCII, BMP, and lone surrogate code units.
      text += String.fromCharCode(next() % 0x10000);
    }
    out.push(text);
  }
  return out;
}

describe("fnv1a32", function () {
  it("returns the published FNV-1a 32-bit values as eight hex characters", function () {
    assert.equal(fnv1a32(""), "811c9dc5");
    assert.equal(fnv1a32("a"), "e40c292c");
    assert.equal(fnv1a32("foobar"), "bf9cf968");
    assert.equal(fnv1a32(UNICODE_SAMPLE), "79727c1a");
    assert.equal(fnv1a32("x".repeat(5000)), "616035e5");
  });

  it("exposes the unsigned 32-bit value through fnv1a32Raw", function () {
    assert.strictEqual(fnv1a32Raw(""), 0x811c9dc5);
    assert.strictEqual(fnv1a32Raw("a"), 0xe40c292c);
    assert.strictEqual(fnv1a32Raw("foobar"), 0xbf9cf968);
    assert.strictEqual(fnv1a32Raw(UNICODE_SAMPLE), 0x79727c1a);
    assert.strictEqual(fnv1a32Raw("x".repeat(5000)), 0x616035e5);
  });

  it("pads short hex values to eight characters", function () {
    // The digest worker's text hash below is seven hex digits unpadded.
    const raw = fnv1a32Raw("Full text " + UNICODE_SAMPLE);
    assert.equal(raw.toString(16), "bb5a7ae");
    assert.equal(fnv1a32("Full text " + UNICODE_SAMPLE), "0bb5a7ae");
  });

  it("matches both inline forms the call sites used, over many inputs", function () {
    for (const text of [
      "",
      "a",
      UNICODE_SAMPLE,
      "x".repeat(5000),
      ...seededStrings(500),
    ]) {
      const raw = fnv1a32Raw(text);
      assert.isAtLeast(raw, 0);
      assert.isAtMost(raw, 0xffffffff);
      assert.isTrue(Number.isInteger(raw));
      assert.strictEqual(raw, inlineFinalMask(text));
      assert.strictEqual(raw, inlinePerStepMask(text));
      assert.equal(fnv1a32(text), raw.toString(16).padStart(8, "0"));
    }
  });
});

describe("FNV-1a call sites keep their stored and compared formats", function () {
  const globals = globalThis as unknown as { Zotero?: unknown };
  let previousZotero: unknown;

  before(function () {
    previousZotero = globals.Zotero;
    globals.Zotero = {
      DataDirectory: { dir: "/tmp/zdata" },
      Profile: { dir: "/tmp/prof" },
    };
  });

  after(function () {
    globals.Zotero = previousZotero;
  });

  it("agent action and evidence digests", function () {
    assert.equal(
      buildActionCallDigest("zotero_update", { itemId: 7, tags: ["a", "b"] }),
      "fnv1a:da329c30",
    );
    assert.equal(fingerprintText(UNICODE_SAMPLE), "fnv1a32:79727c1a");
  });

  it("paper digest cache key keeps unpadded hex", function () {
    assert.equal(
      digestCacheKey({
        contextItemId: 42,
        text: "Full text " + UNICODE_SAMPLE,
        instruction: "  Summarize \n the methods ",
        question: "What?",
        model: "gpt-5",
      }),
      "digest:v2:42:bb5a7ae:40b8c96f:29829b50:gpt-5",
    );
  });

  it("profile signatures", function () {
    assert.equal(
      buildSkillProfileSignature(
        " C:\\Users\\me\\Zotero\\Profiles\\abc.default ",
      ),
      "profile-25d37d03",
    );
    assert.equal(
      buildClaudeProfileSignature("/Users/me/Zotero/Profiles/abc.default"),
      "profile-13256db4",
    );
    assert.equal(
      buildProfileSignature("/Users/me/Zotero/Profiles/abc.default"),
      "profile-13256db4",
    );
  });

  it("tool result handles", function () {
    const record = createAgentToolResultHandleRecord({
      conversationKey: 5,
      toolName: "read_paper",
      toolCallId: "call_1",
      inputDigest: "d1",
      content: { text: UNICODE_SAMPLE, n: 3 },
    });
    assert.equal(record?.handle, "trh_53fef620");
  });

  it("instruction inventory and Claude managed-block fingerprints", function () {
    assert.equal(
      buildInstructionInventory({
        fixed: ["You are helpful."],
        tools: [],
        matchedSkills: ["skill " + UNICODE_SAMPLE],
      } as unknown as Parameters<typeof buildInstructionInventory>[0])
        .promptHash,
      "fnv1a32-312760c2",
    );
    assert.equal(
      getDefaultClaudeManagedInstructionBlock().split("\n")[2],
      "<!-- LLM-FOR-ZOTERO:CLAUDE-STOCK-FINGERPRINT:fnv1a32-20847520 -->",
    );
  });

  it("quote and citation keys", function () {
    assert.equal(
      buildCitationQuoteHash("  The Quick\n brown FOX — " + UNICODE_SAMPLE),
      "1776447d",
    );
    assert.equal(buildCitationQuoteHash("   "), "");
    assert.equal(
      quoteValidationCacheKey("sig|" + UNICODE_SAMPLE),
      "24:1ns7851",
    );
    assert.equal(
      buildQuoteCitationId({
        quoteText: "A quoted passage " + UNICODE_SAMPLE,
        citationLabel: "Smith et al., 2020",
        contextItemId: 99,
      }),
      "Q_0zmm85t",
    );
    assert.equal(
      buildPinnedSelectedTextKey({
        text: "Selected " + UNICODE_SAMPLE,
        source: "pdf",
        paperContext: {
          itemId: 11.7,
          contextItemId: 12,
          title: "T",
        } as PaperContextRef,
        contextItemId: 12,
        pageIndex: 3,
      } as Parameters<typeof buildPinnedSelectedTextKey>[0]),
      "pdf\u241f-\u241f11:12\u241f12\u241f3\u241f16fsuz3",
    );
  });

  it("document, figure, secret, and web source fingerprints", function () {
    assert.equal(
      buildPdfFigureCropStableHash("figure|" + UNICODE_SAMPLE),
      "fnv1a32-a3f902f4",
    );
    assert.equal(
      buildDocumentFingerprint(
        { itemId: 1, contextItemId: 2, title: "T" } as PaperContextRef,
        {
          sourceType: "mineru",
          chunks: ["alpha", "beta " + UNICODE_SAMPLE],
          fullLength: 20,
        } as unknown as PdfContext,
      ),
      "672f2c41",
    );
    assert.equal(fingerprintSecret("sk-test-1234567890"), "9c34888c");
    assert.equal(buildWebSourceId("https://example.org/a?b=c"), "web_0sa9vst");
  });
});
