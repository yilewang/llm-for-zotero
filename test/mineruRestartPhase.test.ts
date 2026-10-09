import { assert } from "chai";
import { runMineruRestartPhase } from "../scripts/mineru-restart-phase.mjs";

describe("MinerU restart phase", function () {
  it("rejects exit zero without a completed test summary", async function () {
    let message = "";
    try {
      await runMineruRestartPhase("resume", {
        command: {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          env: process.env,
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.equal(message, "resume exited 1");
  });
});
