import { ToolInputRejection } from "../tools/execution/failure";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import { validateObject } from "../tools/shared";
import type { ResearchUpdateInput } from "./commands";
import { positiveInt, safeId, string, strings } from "./recordValidation";
import { commitResearchRecords } from "./stages";
import {
  listPaperFindings,
  listResearchEdges,
  listResearchRecallProbes,
  saveResearchRecallProbe,
  saveThemeFinding,
} from "./store";
import type {
  ResearchJob,
  ResearchCorpusItem,
  ResearchEvidenceRecord,
  ResearchRecallProbe,
  ThemeFinding,
} from "./types";

export async function recordResearchReductions(params: {
  input: ResearchUpdateInput;
  job: ResearchJob;
  corpusByKey: Map<string, ResearchCorpusItem>;
  evidenceByRef: Map<string, ResearchEvidenceRecord>;
}) {
  const { input, job, corpusByKey, evidenceByRef } = params;
  if (input.operation === "record_probes") {
    const kinds = new Set<ResearchRecallProbe["kind"]>([
      "synonym",
      "abbreviation",
      "translation",
      "semantic",
      "reformulation",
    ]);
    await commitResearchRecords(job, async () => {
      const existing = new Map(
        (await listResearchRecallProbes(job.researchJobId)).map((probe) => [
          probe.probeId,
          probe,
        ]),
      );
      for (let index = 0; index < (input.probes || []).length; index += 1) {
        const raw = input.probes![index];
        if (!validateObject<Record<string, unknown>>(raw)) {
          throw new ToolInputRejection(`probes[${index}] must be an object`);
        }
        const kind = raw.kind as ResearchRecallProbe["kind"];
        if (!kinds.has(kind)) {
          throw new ToolInputRejection(`probes[${index}].kind is invalid`);
        }
        if (!Array.isArray(raw.addedTargets)) {
          throw new ToolInputRejection(
            `probes[${index}].addedTargets must be an array`,
          );
        }
        const addedTargets = raw.addedTargets.map((target, targetIndex) => {
          if (!validateObject<Record<string, unknown>>(target)) {
            throw new ToolInputRejection(
              `probes[${index}].addedTargets[${targetIndex}] must be an object`,
            );
          }
          const libraryID = positiveInt(
            target.libraryID,
            `probes[${index}].addedTargets[${targetIndex}].libraryID`,
          );
          const itemKey = string(
            target.itemKey,
            `probes[${index}].addedTargets[${targetIndex}].itemKey`,
          );
          if (!corpusByKey.has(`${libraryID}:${itemKey}`)) {
            throw new ToolInputRejection(
              `Recall probe target ${libraryID}:${itemKey} is outside the frozen corpus`,
            );
          }
          return { libraryID, itemKey };
        });
        const probeId = `${job.researchJobId}:probe:${safeId(
          string(raw.probeId, `probes[${index}].probeId`),
        )}`;
        const probe: ResearchRecallProbe = {
          version: 1,
          probeId,
          researchJobId: job.researchJobId,
          executionId: job.executionId,
          parentTaskId: job.parentTaskId,
          kind,
          query: string(raw.query, `probes[${index}].query`),
          addedTargets,
          createdAt: existing.get(probeId)?.createdAt || Date.now(),
        };
        const prior = existing.get(probeId);
        if (prior && canonicalJson(prior) !== canonicalJson(probe)) {
          throw new ToolInputRejection(
            `Recall probe ${probeId} changed after persistence`,
          );
        }
        if (!prior) await saveResearchRecallProbe(probe);
      }
    });
  }

  if (input.operation === "record_themes") {
    await commitResearchRecords(job, async () => {
      const paperFindings = await listPaperFindings(job.researchJobId);
      const findingIds = new Set(paperFindings.map((entry) => entry.findingId));
      const findingById = new Map(
        paperFindings.map((entry) => [entry.findingId, entry]),
      );
      const findingByIdentity = new Map(
        paperFindings.map((entry) => [
          `${entry.libraryID}:${entry.itemKey}`,
          entry,
        ]),
      );
      const evidenceRefs = new Set(evidenceByRef.keys());
      const edges = (await listResearchEdges(job.researchJobId)).filter(
        (edge) => edge.status !== "merged" && edge.status !== "refuted",
      );
      const edgeById = new Map(edges.map((edge) => [edge.edgeId, edge]));
      const identityOfFinding = new Map(
        paperFindings.map((entry) => [
          entry.findingId,
          `${entry.libraryID}:${entry.itemKey}`,
        ]),
      );
      for (let index = 0; index < (input.themes || []).length; index += 1) {
        const raw = input.themes![index];
        if (!validateObject<Record<string, unknown>>(raw)) {
          throw new ToolInputRejection(`themes[${index}] must be an object`);
        }
        const paperFindingIds = [
          ...(raw.paperFindingIds === undefined
            ? []
            : strings(raw.paperFindingIds, `themes[${index}].paperFindingIds`)),
          ...(raw.paperIdentities === undefined
            ? []
            : strings(
                raw.paperIdentities,
                `themes[${index}].paperIdentities`,
              ).map((identity) => {
                const finding = findingByIdentity.get(identity);
                if (!finding) {
                  throw new ToolInputRejection(
                    `themes[${index}] references unknown paper identity ${identity}`,
                  );
                }
                return finding.findingId;
              })),
        ].filter((id, position, all) => all.indexOf(id) === position);
        if (!paperFindingIds.length) {
          throw new ToolInputRejection(
            `themes[${index}] requires paperIdentities or paperFindingIds`,
          );
        }
        const themeEvidenceRefs =
          raw.evidenceRefs === undefined
            ? [
                ...new Set(
                  paperFindingIds.flatMap(
                    (id) => findingById.get(id)?.evidenceRefs || [],
                  ),
                ),
              ]
            : strings(raw.evidenceRefs, `themes[${index}].evidenceRefs`);
        if (paperFindingIds.some((id) => !findingIds.has(id))) {
          throw new ToolInputRejection(
            `themes[${index}] references an unknown paper finding`,
          );
        }
        if (themeEvidenceRefs.some((id) => !evidenceRefs.has(id))) {
          throw new ToolInputRejection(
            `themes[${index}] references unknown evidence`,
          );
        }
        const retainedEvidence = new Set(
          paperFindingIds.flatMap(
            (id) => findingById.get(id)?.evidenceRefs || [],
          ),
        );
        if (themeEvidenceRefs.some((id) => !retainedEvidence.has(id))) {
          throw new ToolInputRejection(
            `themes[${index}] uses evidence not retained by its paper findings`,
          );
        }
        const themeIdentities = new Set(
          paperFindingIds.map((id) => identityOfFinding.get(id) || ""),
        );
        const edgeIds =
          raw.edgeIds === undefined
            ? []
            : strings(raw.edgeIds, `themes[${index}].edgeIds`);
        if (edges.length && themeIdentities.size >= 2 && !edgeIds.length) {
          throw new ToolInputRejection(
            `themes[${index}] spans ${themeIdentities.size} papers but names no edgeIds; a theme is a community in the graph, so cite the edges (from list_graph) that connect its papers`,
          );
        }
        for (const edgeId of edgeIds) {
          const edge = edgeById.get(edgeId);
          if (!edge) {
            throw new ToolInputRejection(
              `themes[${index}] names edge ${edgeId}, which is unknown, refuted, or merged`,
            );
          }
          if (
            !themeIdentities.has(edge.source) ||
            !themeIdentities.has(edge.target)
          ) {
            throw new ToolInputRejection(
              `themes[${index}] names edge ${edgeId} (${edge.source} -> ${edge.target}), but both papers must belong to the theme`,
            );
          }
        }
        const themeId = safeId(string(raw.themeId, `themes[${index}].themeId`));
        const finding: ThemeFinding = {
          version: 2,
          themeFindingId: `${job.researchJobId}:theme:${themeId}`,
          researchJobId: job.researchJobId,
          executionId: job.executionId,
          parentTaskId: job.parentTaskId,
          title: string(raw.title, `themes[${index}].title`),
          synthesis: string(raw.synthesis, `themes[${index}].synthesis`),
          paperFindingIds,
          evidenceRefs: themeEvidenceRefs,
          limitations: strings(
            raw.limitations || [],
            `themes[${index}].limitations`,
          ),
          ...(edgeIds.length ? { edgeIds } : {}),
          ...(typeof raw.communityId === "string" && raw.communityId.trim()
            ? { communityId: raw.communityId.trim() }
            : {}),
          scopeLineageDigest: job.scopeLineageDigest,
          status: "valid",
          createdAt: Date.now(),
        };
        await saveThemeFinding(finding);
      }
    });
  }
}
