import { assert } from "chai";
import { resolveRecordBatchCap } from "../src/agent/research/readingBudget";
import {
  listResearchEvidence,
  listPaperFindings,
  loadResearchJobForExecution,
} from "../src/agent/research/store";
import {
  installResearchHarness,
  nodeFinding,
  paperFixtures,
  type ResearchHarness,
} from "./helpers/researchHarness";

describe("research evidence upgrades and record batches", function () {
  const originalZotero = (globalThis as any).Zotero;
  let harness: ResearchHarness | undefined;
  afterEach(function () {
    harness?.close();
    harness = undefined;
    (globalThis as any).Zotero = originalZotero;
  });

  it("upgrades a metadata-level node to body evidence on a later record", async function () {
    harness = installResearchHarness({ papers: paperFixtures(2) });
    const ledger = await harness.approve();
    await harness.run({ operation: "inventory_scope" });
    const [first] = harness.papers;
    await harness.verifiedRead([first.key], "metadata");
    const metadataClaims = (
      nodeFinding().claims as Record<string, unknown>[]
    ).map((claim) => ({ ...claim, evidence: { sourceKind: "metadata" } }));
    await harness.run({
      operation: "record_papers",
      papers: [
        {
          libraryID: 1,
          itemKey: first.key,
          finding: nodeFinding({ claims: metadataClaims }),
        },
      ],
    });
    await harness.verifiedRead([first.key], "body");
    await harness.run({
      operation: "record_papers",
      papers: [{ libraryID: 1, itemKey: first.key, finding: nodeFinding() }],
    });
    const job = await loadResearchJobForExecution(ledger.executionId);
    const evidence = await listResearchEvidence(job!.researchJobId);
    const kinds = evidence
      .filter((entry) => entry.itemKey === first.key)
      .map((entry) => entry.sourceKind)
      .sort();
    assert.deepEqual(kinds, ["body", "metadata"]);
    const findings = await listPaperFindings(job!.researchJobId);
    const finding = findings.find((entry) => entry.itemKey === first.key)!;
    assert.lengthOf(finding.evidenceRefs, 1);
    assert.match(finding.evidenceRefs[0], /host_verified_read-body$/);
  });

  it("derives the record batch cap from the output reserve", function () {
    assert.equal(
      resolveRecordBatchCap({
        outputReserveTokens: 8192,
        projectedPaperTokens: 900,
      }),
      4,
    );
    assert.equal(
      resolveRecordBatchCap({
        outputReserveTokens: 64_000,
        projectedPaperTokens: 900,
      }),
      8,
      "a large reserve is clamped so one malformed payload stays cheap",
    );
    assert.equal(
      resolveRecordBatchCap({
        outputReserveTokens: 500,
        projectedPaperTokens: 900,
      }),
      1,
    );
  });

  it("announces the cap in the manifest and rejects a larger record batch", async function () {
    harness = installResearchHarness({ papers: paperFixtures(6) });
    await harness.approve();
    const inventory = await harness.run({ operation: "inventory_scope" });
    assert.equal(inventory.maxPapersPerRecord, 4);
    await harness.verifiedRead(
      harness.papers.map((paper) => paper.key),
      "body",
    );
    let error = "";
    try {
      await harness.run({
        operation: "record_papers",
        papers: harness.papers.slice(0, 5).map((paper) => ({
          libraryID: 1,
          itemKey: paper.key,
          finding: nodeFinding(),
        })),
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    assert.match(error, /at most 4 papers/);
    const job = await loadResearchJobForExecution(
      (await harness.ledger()).executionId,
    );
    assert.lengthOf(await listPaperFindings(job!.researchJobId), 0);
  });
});
