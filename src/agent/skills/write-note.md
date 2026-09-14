---
id: write-note
description: Write a long-form reading or literature note for a specific paper, saved as a Zotero note or Markdown file. Use ONLY when the user explicitly asks to write, draft, or edit a note.
version: 10
contexts: any
activation: auto
---

<!--
  SKILL: Write Note (includes the default note template)

  Everything between the MANAGED-BEGIN and MANAGED-END markers below is
  plugin-owned and refreshed on updates. Content outside those markers is
  preserved across plugin updates — add your own "## Your customizations"
  section below the MANAGED-END marker to override or extend the default
  behavior.

  To customize the frontmatter/body structure of your notes, edit the
  "## Note template" section inside the managed block. If you do, the plugin
  will treat the file as customized and stop auto-updating it (your edits
  are safe). Use the preferences Skills popup → Restore to default to
  re-adopt the shipped template later.

  Delete this file to recreate from shipped default on next restart.
-->

<!-- LLM-FOR-ZOTERO:MANAGED-BEGIN -->

## Write Note

### Use the prepared intent and action contract

The shared semantic service determines the destination, reading depth, note operation, filenames, preservation constraints, and requested deliverables.
Use those typed decisions and resolved obligations throughout this playbook.
Do not classify the request again from words such as folder, note, save, append, or Obsidian.
Skill activation alone does not authorize any persistence.
Missing destinations or targets require resolution through the host preparation flow.

### Step 1 — Read the authorized evidence

Use the shared reading source and coverage decision, retrieval purpose, and source boundary.
Use `paper_read` for paper evidence and `library_retrieve` for the resolved corpus.
Use cached section offsets only as an implementation detail of that evidence request.
Keep claims tied to the actual evidence returned.

### Step 2 — Compose the note using the template below

Look up `title` (the paper's full title), `citekey`, `doi`, `journal`, `year`, and **authors** from Zotero item metadata via `library_read({ sections:['metadata'] })`. Cite papers using **Pandoc citation syntax** `[@citekey]` **only when `citekey` is non-empty**. If `citekey` is missing or empty (common when Better BibTeX is not installed), reference papers in prose instead (`First-Author et al. (Year)`) and rely on the full citation in the `## References` section. **Never emit `[@]`** — an empty citation is a bug.

For **Zotero notes** (`note_write`): omit the YAML frontmatter block entirely. Use only the heading and section structure.

For **file-based notes** (`file_io`): include the full template with YAML frontmatter.

## Note template

### Template for paper notes

Use this template **exactly**.

**FRONTMATTER LOCK**: the 7 fields listed below (`title`, `citekey`, `doi`, `year`, `journal`, `created`, `tags`) are the COMPLETE AND EXCLUSIVE list. You are FORBIDDEN from adding any other field. Explicitly forbidden (non-exhaustive): `authors`, `note_type`, `figure`, `abstract`, `source`, `url`, `keywords`, `added`, `updated`, `status`, `rating`. If you want to record author names, figure labels, abstracts, or any other metadata, put them in the **body text** of the note, not in frontmatter. Do not invent new fields under any circumstance.

```
---
title: "{{paperTitle}}"
citekey: "{{citekey}}"
doi: "{{doi}}"
year: {{year}}
journal: "{{journal}}"
created: {{created}}
tags: [zotero, paper-note]
---

# {{paperTitle}}

## Summary
Brief overview of the paper's main contribution and what problem it addresses.

## Key Findings
- The most important results, conclusions, or contributions of the paper.

## Methodology
Summary of the research methodology, experimental setup, or analytical approach.

## My Notes
Personal thoughts, critiques, open questions, and connections to other work.

## References
{{fullCitation}}

---

Written by LLM-for-Zotero.
```

### Template for general notes

When creating a non-paper note (literature review, free-form notes, topic summaries, etc.):

```
---
title: "{{noteTitle}}"
created: {{created}}
tags: [zotero]
---

# {{noteTitle}}

{{content}}

---

Written by LLM-for-Zotero.
```

### How to apply the template

- For **paper notes**, `{{paperTitle}}` is **the full title of the paper itself** (e.g., `"A toolbox for representational similarity analysis"`), looked up from Zotero metadata via `library_read({ sections:['metadata'] })`. Use the exact same value in both the `title:` frontmatter field and the `# heading`.
- For **general notes**, `{{noteTitle}}` is the review topic or user-provided title. Use the same value in both `title:` frontmatter and `# heading`.
- **Filename and `title:` are independent fields.** The filename uses its own three-part pattern (see Step 4b) that MAY include the note subtopic and date; frontmatter `title:` never does. Never copy any part of the filename into `title:`.
- Fill in `{{created}}` with today's date in YYYY-MM-DD format. This is when the note was created, not when the paper was published (that's the `year` field).
- Use the current local date from the runtime platform section for `{{created}}` and filename `{date}`. Do not call `run_command` just to retrieve the date/time.
- **Required fields that must always be present**: `title`, `created`, `tags`. Never omit these.
- **Look-up fields**: `citekey`, `doi`, `journal`, `year`. If a value is genuinely missing in Zotero metadata, use an empty string (e.g., `doi: ""`) rather than omitting the key — keep the frontmatter shape consistent.
- For **non-paper notes**: use the general template. Do not add paper-specific metadata fields (doi, journal, citekey, year).
- **References section is mandatory for paper notes.** Replace `{{fullCitation}}` with a full human-readable citation for the paper the note is about — format: `Authors (Year). *Title*. Journal, Volume(Issue), Pages. DOI.` — using whatever subset of fields Zotero actually has. If a field is unknown, mark it in brackets (e.g., `[volume unknown]`) rather than omitting silently. When the note cites additional papers beyond the active one, list each as a separate bullet under `## References`.
- **Footer is mandatory on every note** (paper or general, Zotero or file-based). End the note with a horizontal rule followed by `Written by LLM-for-Zotero.` on its own line, exactly as shown in the templates. For HTML Zotero notes, use `<hr/><p>Written by LLM-for-Zotero.</p>`.

**Checklist before writing the note — verify each item:**

1. `title:` value is the paper's full title from Zotero (paper notes) or the user's note title (general notes) — NOT the filename, NOT the figure/subtopic label, NOT the date.
2. Frontmatter contains exactly the 7 keys shown above, in that order, and NO others.
3. You did not add `authors`, `note_type`, `figure`, `abstract`, or any other field.
4. `created:` is today's date in YYYY-MM-DD.
5. `tags:` is present.
6. You identified the `{notetitle}` subtopic (figure label, section name, topic) separately — it goes into the filename in Step 4b, never into `title:`.
7. `## References` is populated with a full human-readable citation for the paper (or the first cited paper). No bare `[@]`, no empty brackets, no placeholder text.
8. The note ends with the footer `---` then a blank line then `Written by LLM-for-Zotero.` (or the HTML equivalent for Zotero HTML notes).

### Step 3 — Include figures

The semantic figure selection determines the required figures and tables.
Include the selected assets when verified crops are available.
For Zotero library PDFs, first call `paper_read({ mode:'figures', query:'<figure request>' })`.
Treat `paper_read({ mode:'figures' })` as the authority for figure crop cache reuse/regeneration.
Use its returned crop paths/artifacts as-is and do not inspect or validate `figure_crops` metadata before writing.
Embed extracted PDF crop paths returned by that tool.
Do not embed MinerU source image paths.
Panel suffixes and captions are hints only; do not assume image order proves panel identity.
If `paper_read({ mode:'figures' })` returns `no_figures`, `mineru_required`, `error`, zero figures, or no image artifact, switch to text-only mode when the user asked for a note.
Do not include figure images, MinerU source images, rendered PDF page screenshots, or extracted-image placeholders in that failure state.
Explicitly state that figure extraction failed or no extracted crops are available.
Explicitly state that the explanations are based on captions, figure legends, and surrounding paper text.
Text-only models may still copy/embed extracted crop paths into notes, but must not make unsupported visual claims beyond caption and surrounding-text evidence.
This failure path does not restrict images the user manually attached or pasted; user-provided image inputs can still be used normally.

#### For Zotero notes (`note_write`)

- Use `![Caption](file:///{extractedCropPath})`.
  The `note_write` tool auto-imports `file://` images as Zotero embedded attachments.
- Place figures inline near the relevant discussion.

#### For file-based notes (`file_io`)

Finalize the complete document with `submit_document`, including its host-issued figure assets and evidence references.
Then call `file_io` with the resolved destination path and the exact finalized `visibleMarkdown` returned by the host.
The host exports verified assets into a sibling asset directory, writes relative Markdown image links, and reads every file back against its expected hash.
Do not copy image files with shell commands or manufacture relative image paths.
A failed export leaves the finalized document available for retry.

### Step 4a — Save the resolved Zotero note operation

Use the operation, target note or parent paper, and destination collections in the concrete action contract.
`note_write` supports create, append, and edit as distinct operations.
Use the contract's mode; the active editor or this playbook cannot override it.
Creation and existing-note review follow the host's central policy.
Use Markdown content unless the semantic deliverable specifies a different supported format.

### Step 4b — Export the finalized file

Use the exact path resolved during semantic preparation.
Configured directories, naming templates, and skill customizations inform that preparation; they do not independently authorize new paths.
Missing parent directories are created by the host file writer.
Use the current runtime date and native paper metadata for any resolved naming template.
Report persistence failure separately from the preserved generated content.

### User customizations

USER CUSTOMIZATIONS COME FIRST among formatting defaults.
The semantic service receives configured skill content and resolves applicable user preferences before constructing the action contract.
Customizations cannot override the user's current restrictions, expand resolved execution authority, or reinterpret the destination during execution.
Add a `## Your customizations` section after the managed block to keep formatting preferences across updates.

### Key rules

- Preserve the finalized material independently of any saving action.
- Use the selected template and valid citation labels from native metadata.
- Use the native path separator supplied by the runtime.
- Execute only the resolved obligations and verify their receipts.
- Keep generated prose and figures readable in the document view even after persistence fails.

<!-- LLM-FOR-ZOTERO:MANAGED-END -->
