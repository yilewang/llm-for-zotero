#!/usr/bin/env python3
"""Zip the annotation-tool source files for review.

Collects the tool registry index, the Zotero API gateway, the four
annotation tools (create / delete / find / update), and their direct
type/helper dependencies so the archive is self-contained for review.
"""

from __future__ import annotations

import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # repo root (adjust if needed)

# ── Files to include ──────────────────────────────────────────────────────────

FILES: list[tuple[str, str]] = [
    # (archive_path, filesystem_path)
    #
    # ── Agent instruction files: skills + persona ─────────────────────────
    # Skills tell the agent what tools to use for which task and how.
    ("agent_instructions/analyze-figures.md",       "src/agent/skills/analyze-figures.md"),
    ("agent_instructions/compare-papers.md",        "src/agent/skills/compare-papers.md"),
    ("agent_instructions/evidence-based-qa.md",     "src/agent/skills/evidence-based-qa.md"),
    ("agent_instructions/import-cited-reference.md","src/agent/skills/import-cited-reference.md"),
    ("agent_instructions/library-analysis.md",      "src/agent/skills/library-analysis.md"),
    ("agent_instructions/literature-review.md",     "src/agent/skills/literature-review.md"),
    ("agent_instructions/simple-paper-qa.md",       "src/agent/skills/simple-paper-qa.md"),
    ("agent_instructions/write-note.md",            "src/agent/skills/write-note.md"),
    # Skill infra (keep the core; userSkills + agentPersona are large and not
    # needed for reviewing how annotation tools are instructed)
    ("agent_instructions/skills/index.ts",          "src/agent/skills/index.ts"),
    ("agent_instructions/skills/routing.ts",        "src/agent/skills/routing.ts"),
    ("agent_instructions/skills/skillLoader.ts",     "src/agent/skills/skillLoader.ts"),
    ("agent_instructions/skills/nativeSkillPaths.ts","src/agent/skills/nativeSkillPaths.ts"),
    ("agent_instructions/skills/frontmatterPatcher.ts","src/agent/skills/frontmatterPatcher.ts"),
    ("agent_instructions/skills/contextEligibility.ts","src/agent/skills/contextEligibility.ts"),
    ("agent_instructions/skills/managedBlock.ts",   "src/agent/skills/managedBlock.ts"),
    # Skill classification
    ("agent_instructions/skillClassifier.ts",        "src/agent/model/skillClassifier.ts"),
    ("agent_instructions/skillIds.ts",               "src/shared/skillIds.ts"),
    #
    # ── Core annotation tools (the new additions) ─────────────────────────
    ("annotation_tools/annotationFind.ts",       "src/agent/tools/read/annotationFind.ts"),
    ("annotation_tools/annotationUpdate.ts",     "src/agent/tools/write/annotationUpdate.ts"),
    #
    # Existing annotation tools (for complete picture)
    ("annotation_tools/createAnnotation.ts",     "src/agent/tools/write/createAnnotation.ts"),
    ("annotation_tools/deleteAnnotations.ts",    "src/agent/tools/write/deleteAnnotations.ts"),
    #
    # Tool registry (how tools are wired together)
    ("annotation_tools/index.ts",                "src/agent/tools/index.ts"),
    #
    # Zotero API gateway (the data layer — get/update/delete annotations)
    ("annotation_tools/zoteroGateway.ts",        "src/agent/services/zoteroGateway.ts"),
    #
    # Direct dependencies — types, helpers, undo store
    ("annotation_tools/deps/types.ts",           "src/agent/types.ts"),
    ("annotation_tools/deps/shared.ts",          "src/agent/tools/shared.ts"),
    ("annotation_tools/deps/undoStore.ts",       "src/agent/store/undoStore.ts"),
    ("annotation_tools/deps/sharedTypes.ts",     "src/shared/types.ts"),
    ("annotation_tools/deps/facade.ts",          "src/agent/tools/facade.ts"),
    ("annotation_tools/deps/registry.ts",        "src/agent/tools/registry.ts"),
]

OUTPUT = ROOT / "annotation_tools_review.zip"


def build_archive() -> None:
    missing: list[str] = []

    with zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for arcname, fspath in FILES:
            src = ROOT / fspath
            if not src.is_file():
                missing.append(fspath)
                continue
            zf.write(src, arcname)

    if missing:
        print("⚠  Missing files (skipped):")
        for m in missing:
            print(f"   - {m}")
        print()

    print(f"✅ Archive written to: {OUTPUT}")
    print(f"   {len(FILES) - len(missing)} / {len(FILES)} files included")


if __name__ == "__main__":
    build_archive()
