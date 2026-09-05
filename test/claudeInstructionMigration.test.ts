import { assert } from "chai";
import {
  getDefaultClaudeManagedInstructionBlock,
  upgradeManagedInstructionBlockForTests,
} from "../src/claudeCode/bootstrap";
import { PAPER_CITATION_CONTRACT } from "../src/shared/instructionContracts";

describe("Claude managed instruction migration", function () {
  let previousZotero: unknown;

  beforeEach(function () {
    previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
    (globalThis as { Zotero?: unknown }).Zotero = {
      DataDirectory: { dir: "/tmp/llm-for-zotero-claude-data" },
      Profile: { dir: "/tmp/llm-for-zotero-claude-profile" },
    };
  });

  afterEach(function () {
    (globalThis as { Zotero?: unknown }).Zotero = previousZotero;
  });

  it("keeps the stock managed block configuration-only and versioned", function () {
    const managed = getDefaultClaudeManagedInstructionBlock();

    assert.include(managed, "CLAUDE-CONTRACT-VERSION:2");
    assert.include(managed, "CLAUDE-STOCK-FINGERPRINT:fnv1a32-");
    assert.include(managed, "stable profile configuration only");
    assert.include(managed, "supplied by the bridge on each turn");
    assert.notInclude(managed, PAPER_CITATION_CONTRACT);
    assert.notInclude(managed, "## Shared Zotero behavior");
  });

  it("refreshes versioned stock blocks without duplicating behavior", function () {
    const managed = getDefaultClaudeManagedInstructionBlock();
    const upgraded = upgradeManagedInstructionBlockForTests(managed);

    assert.equal(upgraded, managed);
    assert.equal(upgraded.split("CLAUDE-CONTRACT-VERSION:2").length - 1, 1);
  });

  it("preserves customized managed behavior while adding missing config", function () {
    const custom = [
      "# My Claude instructions",
      "",
      "Always use my laboratory terminology.",
    ].join("\n");
    const upgraded = upgradeManagedInstructionBlockForTests(custom);

    assert.include(upgraded, "Always use my laboratory terminology.");
    assert.include(upgraded, "## Config model");
    assert.notInclude(upgraded, "CLAUDE-CONTRACT-VERSION:2");
  });

  it("preserves edits to a versioned stock block instead of trusting its marker", function () {
    const customized = getDefaultClaudeManagedInstructionBlock().replace(
      "stable profile configuration only",
      "stable profile configuration plus my laboratory convention",
    );
    const upgraded = upgradeManagedInstructionBlockForTests(customized);

    assert.equal(upgraded, customized);
    assert.include(upgraded, "my laboratory convention");
  });

  it("does not replace customized blocks that already contain profile config", function () {
    const custom = [
      "# My Claude instructions",
      "Always use my laboratory terminology.",
      "",
      "## Config model",
      "- Shared Zotero profile runtime root: `/custom/runtime`.",
    ].join("\n");

    assert.equal(upgradeManagedInstructionBlockForTests(custom), custom);
  });
});
