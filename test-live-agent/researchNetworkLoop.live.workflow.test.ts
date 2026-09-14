import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import {
  resolveLiveAgentCredentials,
  type LiveAgentCredentials,
} from "./liveAgentCredentials";

declare const Zotero: any;

/**
 * Flight 0: the research network loop, end to end, against a real model and
 * a real library. Three synthetic papers whose bodies contain one explicit
 * extension and one explicit contradiction; the flight asserts durable nodes,
 * a typed edge list with the contradiction surfaced, a finalized document,
 * and prints the flight report every later flight is compared against.
 *
 * Run with:
 *   LLM_FOR_ZOTERO_LIVE_MODEL=<model> LLM_FOR_ZOTERO_LIVE_PROFILE_PATH=<prefs.js> \
 *   LLM_FOR_ZOTERO_TEST_ENTRIES=test-live-agent/researchNetworkLoop.live.workflow.test.ts \
 *   npm run test:agent:live
 */
describe("research network loop, live", function () {
  this.timeout(1_500_000);

  const SUFFIX = `net${Date.now()}`;
  const created = { items: [] as number[], collections: [] as number[] };
  let creds: LiveAgentCredentials | null = null;
  let api: WorkflowTestApi;

  function libraryID(): number {
    return Zotero.Libraries.userLibraryID;
  }

  const papers = [
    {
      title: `Slow-speed prior explains overshooting in visual path integration (${SUFFIX})`,
      author: "Ravel",
      year: "2019",
      pages: [
        `Ravel and Kim (2019). Slow-speed prior explains overshooting in visual path integration. Abstract. Twelve human participants steered to a remembered target using only optic flow in a virtual firefly task. Participants consistently overshot the target by 18 percent. A dynamic Bayesian observer with a prior favouring slow self-motion reproduced the overshoot, while a leaky integrator did not. We conclude that the bias comes from a slow-speed prior combined with near-perfect integration of velocity.`,
        `Methods. Virtual reality with sparse optic flow and no landmarks; joystick control of linear and angular velocity; twelve participants; 600 trials each. Results. Overshoot grew with target distance up to 4 metres and reversed to undershoot beyond 6 metres, where position uncertainty dominates. Discussion. The slow-speed prior account predicts that any species using optic flow for path integration should overshoot at short distances. Limitation. Only visual cues were tested.`,
      ],
    },
    {
      title: `Vestibular-only navigation undershoots the remembered target (${SUFFIX})`,
      author: "Osei",
      year: "2021",
      pages: [
        `Osei, Larsen and Ravel (2021). Vestibular-only navigation undershoots the remembered target. Abstract. We extended the firefly task of Ravel and Kim (2019) to a motion platform so that participants navigated with vestibular cues alone, with optic flow alone, or with both. With optic flow we replicated the overshoot reported by Ravel and Kim (2019). With vestibular cues alone, participants undershot the target by 25 percent.`,
        `Methods. Six degree of freedom motion platform; fourteen participants; three cue conditions. Results. The Bayesian observer fit showed a prior over control dynamics that dominated the likelihood in the vestibular condition, a low prior-to-likelihood ratio. Discussion. The direction of the bias depends on which sensory channel supplies the velocity estimate, so the slow-speed prior of Ravel and Kim (2019) is one component of a larger internal model of the control dynamics. Limitation. Motion cueing was scaled down, which may itself bias vestibular estimates.`,
      ],
    },
    {
      title: `No overshoot in macaque visual path integration (${SUFFIX})`,
      author: "Dube",
      year: "2023",
      pages: [
        `Dube and Marchetti (2023). No overshoot in macaque visual path integration. Abstract. Three macaques performed the firefly task with optic flow. Unlike the humans studied by Ravel and Kim (2019), the macaques did not overshoot at short distances; they undershot at every distance tested, by 12 percent on average. A slow-speed prior cannot explain this pattern.`,
        `Methods. Three rhesus macaques, joystick steering, sparse optic flow, 2000 trials per animal. Results. Undershoot at 1, 2, 4 and 6 metres; no reversal with distance. The best fitting observer used a leaky velocity integrator rather than a slow-speed prior. Discussion. This contradicts the claim of Ravel and Kim (2019) that the overshoot is a general consequence of optic-flow path integration; the bias appears species specific or training specific. Limitation. Extensive training may have removed a prior that naive humans carry.`,
      ],
    },
  ];

  async function seedCorpus() {
    const collection = new Zotero.Collection();
    collection.libraryID = libraryID();
    collection.name = `NetworkLoop-${SUFFIX}`;
    await collection.saveTx();
    created.collections.push(collection.id);
    for (const paper of papers) {
      const fixture = await api.createPaperWithPdfFixture({
        title: paper.title,
        pdfTitle: `${paper.title}.pdf`,
        pages: paper.pages,
      });
      created.items.push(fixture.parentItemId);
      const item = Zotero.Items.get(fixture.parentItemId);
      item.setField("date", paper.year);
      item.setCreators([
        { creatorType: "author", firstName: "A.", lastName: paper.author },
      ]);
      item.setCollections([collection.id]);
      await item.saveTx();
    }
    return collection;
  }

  function baseRequest(conversationKey: number, collection: any) {
    return {
      conversationKey,
      mode: "agent",
      conversationKind: "global",
      libraryID: libraryID(),
      selectedCollectionContexts: [
        {
          collectionId: collection.id,
          name: collection.name,
          libraryID: libraryID(),
        },
      ],
      model: creds?.model,
      apiBase: creds?.apiBase,
      apiKey: creds?.apiKey,
      providerProtocol: creds?.providerProtocol,
      ...(creds?.reasoningLevel
        ? { reasoning: { provider: "deepseek", level: creds.reasoningLevel } }
        : {}),
    };
  }

  before(async function () {
    api = Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
    creds = await resolveLiveAgentCredentials();
    if (!creds) this.skip();
  });

  after(async function () {
    for (const id of created.items) {
      try {
        const item = Zotero.Items.get(id);
        if (item) await item.eraseTx();
      } catch {
        /* best effort */
      }
    }
    for (const id of created.collections) {
      try {
        const collection = Zotero.Collections.get(id);
        if (collection) await collection.eraseTx();
      } catch {
        /* best effort */
      }
    }
  });

  it("plans, reads, links, verifies, structures and writes a review with a verified contradiction", async function () {
    const agent = Zotero.LLMForZotero.api.agent;
    const collection = await seedCorpus();
    const conversationKey = Math.floor(Math.random() * 1_000_000) + 800_000;
    const planId = `plan-${conversationKey}-${Date.now()}-flight`;
    const events: string[] = [];
    let readyArtifact: any = null;
    const onEvent = (event: any) => {
      if (event?.type === "tool_call") {
        const args = event.arguments ?? event.args ?? {};
        events.push(
          `${event.name}${args.operation ? `:${args.operation}` : args.mode ? `:${args.mode}` : ""}`,
        );
      }
      if (event?.type === "plan_ready") readyArtifact = event.artifact;
      if (event?.type === "confirmation_required" && event.requestId) {
        void agent.resolveConfirmation(event.requestId, true);
      }
    };

    const planning = await agent.runTurn(
      {
        ...baseRequest(conversationKey, collection),
        userText: `Write a literature review of the papers in the collection "${collection.name}" on how the speed prior shapes path-integration bias across species and sensory cues. Read every paper in full and make the relationships between the papers explicit.`,
        planContext: {
          phase: "planning",
          planId,
          revision: 1,
          provider: "original",
        },
      },
      onEvent,
    );
    assert.notEqual(
      planning?.kind,
      "fallback",
      "planning turn must run the agent",
    );
    assert.isOk(
      readyArtifact,
      `planning must produce a reviewable plan (tools: ${events.join(" → ")})`,
    );
    assert.equal(readyArtifact.contract?.deliverable?.kind, "document");

    const approved = await api.approvePlanForExecution({
      planId: readyArtifact.planId,
      revision: readyArtifact.revision,
      expectedDigest: readyArtifact.digest,
    });
    const startedAt = Date.now();
    const execution = await agent.runTurn(
      {
        ...baseRequest(conversationKey, collection),
        userText: `Execute the approved plan ${readyArtifact.planId}. Follow the durable task ledger and verify every required step.`,
        planContext: {
          phase: "executing",
          planId: readyArtifact.planId,
          revision: readyArtifact.revision,
          executionId: approved.executionId,
          approvedDigest: approved.planDigest,
          activeTaskId: approved.activeTaskId,
          provider: approved.provider,
        },
      },
      onEvent,
    );
    const wallSeconds = Math.round((Date.now() - startedAt) / 1000);
    const { report, rendered } = await api.researchFlightReport({
      executionId: approved.executionId,
    });
    const summary = `RESEARCH_FLIGHT_REPORT\n${rendered}\nTOOLS: ${events.join(" → ")}\nWALL ${wallSeconds}s\nOUTCOME ${JSON.stringify(execution)}`;
    Zotero.debug(summary, 1);
    console.log(`\n${summary}\n`);
    // The runner captures neither console nor Zotero.debug; keep the report
    // on disk so a failed flight can still be read.
    const reportPath = String(
      (globalThis as any).Services?.env?.get?.(
        "LLM_FOR_ZOTERO_FLIGHT_REPORT_PATH",
      ) || "",
    ).trim();
    if (reportPath) {
      try {
        await (globalThis as any).IOUtils.writeUTF8(reportPath, summary);
      } catch (error) {
        Zotero.debug(`flight report write failed: ${String(error)}`, 1);
      }
    }

    assert.equal(
      execution?.kind,
      "completed",
      `execution outcome: ${JSON.stringify(execution)}`,
    );
    assert.equal(report.status, "completed");
    assert.equal(report.quality.nodes, papers.length, "every paper has a node");
    assert.isAtLeast(
      report.quality.claims,
      papers.length * 3,
      "core nodes carry claims",
    );
    assert.isAtLeast(report.quality.edges, 2, "the papers are linked");
    assert.isAtLeast(
      report.quality.contradictions,
      1,
      "the planted contradiction is surfaced",
    );
    assert.isAtLeast(
      report.quality.edgesVerified,
      1,
      "at least one edge was verified against the text",
    );
    assert.isAtLeast(report.quality.themes, 1);
    assert.equal(
      report.quality.themesWithEdges,
      report.quality.themes,
      "themes are bound to edges",
    );
    assert.isOk(report.audit, "a document was finalized");
    assert.equal(
      report.audit!.unsupported.length,
      0,
      "every cross-paper paragraph rests on an edge",
    );
    assert.equal(report.timings?.malformedArguments ?? 0, 0);
  });
});
