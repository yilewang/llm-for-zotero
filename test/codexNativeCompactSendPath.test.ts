import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";

const here = dirname(fileURLToPath(import.meta.url));

describe("Codex native compact send path", function () {
  it("intercepts /compact before persistence or native turns", function () {
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/chat.ts"),
      "utf8",
    );
    const sendQuestion = source.indexOf("export async function sendQuestion");
    const compactBranch = source.indexOf(
      "if (isCodexNativeCompactCommand)",
      sendQuestion,
    );
    const userPersistCall = source.indexOf(
      "void persistConversationMessage(",
      compactBranch,
    );
    const userPersist = source.indexOf('role: "user",', userPersistCall);
    const nativeTurn = source.indexOf(
      "await runCodexNativePanelTurn(",
      compactBranch,
    );
    const nativeCompact = source.indexOf(
      "await compactCodexAppServerConversation",
      compactBranch,
    );
    const attachmentNormalization = source.indexOf(
      "const requestFileAttachments",
      compactBranch,
    );

    assert.isAtLeast(sendQuestion, 0);
    assert.isAtLeast(compactBranch, 0);
    assert.isAtLeast(userPersistCall, compactBranch);
    assert.isAtLeast(nativeCompact, compactBranch);
    assert.isBelow(compactBranch, userPersist);
    assert.isBelow(compactBranch, attachmentNormalization);
    assert.isBelow(nativeCompact, nativeTurn);
  });
});
