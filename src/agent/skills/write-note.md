---
id: write-note
description: Write a long-form reading or literature note for a specific paper, saved as a Zotero note or Markdown file. Use ONLY when the user explicitly asks to write, draft, or edit a note.
version: 5
match: /\b(create|make|write|draft|generate)\b.*\b(note|summary note|reading note|notes?)\b.*\b(for|from|about|on)\b.*\b(paper|article|this)\b/i
match: /\b(note|notes?)\b.*\b(for|from|about|on)\b.*\b(paper|article|this|these)\b/i
match: /\b(reading notes?|study notes?|literature notes?|research notes?)\b/i
match: /\b(summarize|summarise)\b.*\b(into|as|to)\b.*\b(note|notes?)\b/i
match: /\b(save|write|append|add|put)\b.*\b(to\s+)?(note|notes?)\b/i
match: /\b(note|notes?)\b.*\b(save|write|append|add)\b/i
match: /\b(edit|update|modify|rewrite|revise|polish)\b.*\b(note|notes?)\b/i
match: /\b(create|make|new)\b.*\bnote\b/i
match: /\b(write|save|export|send)\b.*\bobsidian\b/i
match: /\bobsidian\b.*\b(note|write|save|export)\b/i
match: /\bto\s+obsidian\b/i
match: /\bobsidian\b.*\bvault\b/i
match: /\b(save|write|export)\b.*\bnote\b.*\b(to\s+)?(file|disk|local|directory|folder)\b/i
match: /\b(note|notes?)\b.*\b(to\s+)?(file|disk|local|directory|folder)\b/i
match: /\b(use|apply|with)\b.*\btemplate\b/i
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

### Where to write

Decide the destination based on what the user says:

- **File-based** (`file_io`): user mentions Obsidian, the notes directory nickname, or "save to file/directory/folder".
- **Zotero note** (`edit_current_note`): user says "create a note", "save to note", "edit my note", or anything without a file destination.

If unclear, default to Zotero note.

### Step 1 — Read content

- If `mineruCacheDir` is available: use `file_io(read, '{mineruCacheDir}/full.md')`.
- Otherwise: use `read_paper` for the overview, then optionally one `search_paper` call for key results/methods if the user wants detail beyond the abstract.
- For multi-paper notes (reviews, comparisons): use `query_library` + `read_paper`/`file_io` for each paper.
- For free-form notes: use whatever the user provides or requests.
- Keep the read phase minimal: 1 call (MinerU) or 1–2 calls (read_paper/search_paper). Do not read the entire paper section by section.

### Step 2 — Compose the note using the template below

Look up `title` (the paper's full title), `citekey`, `doi`, `journal`, `year`, and **authors** from Zotero item metadata via `read_library(sections:['metadata'])`. Cite papers using **Pandoc citation syntax** `[@citekey]` **only when `citekey` is non-empty**. If `citekey` is missing or empty (common when Better BibTeX is not installed), reference papers in prose instead (`First-Author et al. (Year)`) and rely on the full citation in the `## References` section. **Never emit `[@]`** — an empty citation is a bug.

For **Zotero notes** (`edit_current_note`): omit the YAML frontmatter block entirely. Use only the heading and section structure.

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

- For **paper notes**, `{{paperTitle}}` is **the full title of the paper itself** (e.g., `"A toolbox for representational similarity analysis"`), looked up from Zotero metadata via `read_library(sections:['metadata'])`. Use the exact same value in both the `title:` frontmatter field and the `# heading`.
- For **general notes**, `{{noteTitle}}` is the review topic or user-provided title. Use the same value in both `title:` frontmatter and `# heading`.
- **Filename and `title:` are independent fields.** The filename uses its own three-part pattern (see Step 4b) that MAY include the note subtopic and date; frontmatter `title:` never does. Never copy any part of the filename into `title:`.
- Fill in `{{created}}` with today's date in YYYY-MM-DD format. This is when the note was created, not when the paper was published (that's the `year` field).
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

**If the user asked about a specific figure, you MUST include that figure in the note.** For other notes, include figures when they genuinely aid understanding (result plots, diagrams, key tables).

#### For Zotero notes (`edit_current_note`)

- Use `![Caption](file:///{mineruCacheDir}/images/filename.png)`. The `edit_current_note` tool auto-imports `file://` images as Zotero embedded attachments.
- Place figures inline near the relevant discussion.

#### For file-based notes (`file_io`)

**Hard rules — these embeds do NOT render inline in Obsidian or most markdown viewers. NEVER produce them:**

- NEVER use `file:///...` URLs. They are blocked inline for security.
- NEVER use absolute filesystem paths like `/Users/...`, `~/...`, or `C:\...`.
- NEVER use `|width` syntax inside `![alt](url)`. Width suffixes only work inside `![[wikilink]]` embeds, which we do NOT use here. The `|` ends up as literal text and the image is not resized.

**Algorithm — follow exactly:**

1. Create the destination directory: `run_command` with `mkdir -p "{attachmentsPath}/{sanitized-paper-title}"`. The folder is named after the **paper title only** (no subtopic, no date) so multiple notes about the same paper share the same images folder.
2. Copy image files from `{mineruCacheDir}/images/` to `{attachmentsPath}/{sanitized-paper-title}/` using `run_command`. Copy images BEFORE writing the note file.
3. Compute the **relative path from the note's directory to the image file**. Use `..` to climb to the common ancestor, then descend to the image. Count path segments deterministically — don't guess.
4. Embed with `![<caption>](<relative-path>)`. Nothing else.

**Worked example:**

```
Note path:    {vault}/Logs/paper-notes/Nili2014.md
Image path:   {vault}/Logs/imgs/Nili2014/figure-2.jpg
Note folder:  {vault}/Logs/paper-notes/
Relative:     ../imgs/Nili2014/figure-2.jpg
Write:        ![Figure 2. RSA toolbox schematic](../imgs/Nili2014/figure-2.jpg)
```

**Negative examples — never produce any of these:**

- `![Figure 2](file:///Users/.../figure-2.jpg)` — `file://` renders as a broken-image icon in Obsidian.
- `![Figure 2](/Users/.../figure-2.jpg)` — absolute path is outside the vault; viewers refuse.
- `![Figure 2|400](../imgs/foo.jpg)` — `|400` becomes literal alt text; image is not resized.
- `![[imgs/foo/figure-2.jpg]]` — wiki-link embed; we use standard markdown only.

**If the figure image cannot be found** in the MinerU cache, tell the user clearly. Do NOT fall back to `file:///`, absolute paths, or any of the negative examples above.

### Step 4a — Write to Zotero (`edit_current_note`)

**Creating notes** (mode: `create`):
- Notes are created directly without a confirmation card.
- In **paper chat** (active item exists): default to `target: 'item'` — attaches the note to the active paper.
- In **library chat** (no active item): default to `target: 'standalone'` — creates a standalone note.
- `create` always means a brand-new note. Do not use `create` when the user asks to append to an existing note.

**Appending to existing notes** (mode: `append`):
- Use mode `append` when the user says append, add to an existing note, continue a note, or save into a specific existing note.
- Pass `targetNoteId` when you know the note ID.
- If no `targetNoteId` is supplied, the tool appends to the active note; otherwise it can append to the single child note on the target item.
- If the target paper has multiple child notes, ask which note to append to before proceeding.

**Editing existing notes** (mode: `edit`):
- Edits always show a diff review card for the user to approve.
- PREFER `patches` (find-and-replace pairs) over `content` (full rewrite) — patches are faster.
- Use mode `edit` for: append to a specific position, insert, delete, rewrite sections.

**Format:**
- Pass Markdown by default. When the user explicitly requests HTML output or provides an HTML template (e.g., Better Notes templates with inline styles), write HTML with inline styles directly.

### Step 4b — Write to file (`file_io`)

**Prerequisites:**
- The user's notes directory path and default folder are provided in the system prompt under "Notes directory configuration". If missing, tell the user to configure the notes directory in the plugin preferences (Settings > Agent tab).
- The default folder is used when the user doesn't specify a folder. If the user specifies a different folder, write there instead.

**Filename pattern (default):** `{papertitle}-{notetitle}-{date}.md`

Three components, joined by single hyphens:

- **`{papertitle}`** — sanitized paper title from Zotero metadata (paper notes only). For general/non-paper notes, **omit this component entirely** along with the hyphen that would follow it.
- **`{notetitle}`** — the specific aspect or subtopic the note covers. Derive it from the user's request:
  - "notes on figure 1" / "summarize figure 3" → `figure-1` / `figure-3`
  - "methodology summary" / "methods notes" → `methodology`
  - "discussion notes" / "notes on the discussion" → `discussion`
  - "key findings" / "summarize the findings" → `key-findings`
  - "summarize this paper" / "reading notes for this paper" (no specific aspect) → **omit `{notetitle}` entirely**, along with the hyphen that would precede it.
- **`{date}`** — today's date in `YYYY-MM-DD`. This is the same value you write into frontmatter `created:` — reuse it, don't look up a different date.

**Sanitizer for each component** — lowercase, replace any run of non-alphanumeric characters with a single hyphen, strip leading/trailing hyphens, collapse consecutive hyphens to one, trim each component to ~80 characters.

**Never double up hyphens** when a component is omitted. `{papertitle}--{date}.md` is wrong; the correct form is `{papertitle}-{date}.md`.

**Worked examples:**

| User request | Filename |
|---|---|
| "summary notes about figure 1 to my obsidian note" | `stable-and-dynamic-coding-for-working-memory-figure-1-2026-04-16.md` |
| "create a reading note for this paper" | `stable-and-dynamic-coding-for-working-memory-2026-04-16.md` |
| "methodology summary" | `stable-and-dynamic-coding-for-working-memory-methodology-2026-04-16.md` |
| "literature review on working memory" (non-paper note) | `literature-review-on-working-memory-2026-04-16.md` |

**Writing steps:**

1. Construct the file path: `{notesDirectoryPath}/{folder}/<filename>.md`, using the native path separator from the runtime platform section.
2. Call `file_io(write, filePath, noteContent)`.
3. If writing fails, report the error clearly with the attempted path.

**Filename is independent of frontmatter.** The frontmatter `title:` stays the paper's full title (paper notes) or the user's note title (general notes) per the template. Do NOT put the subtopic or the date into `title:`.

#### Customize the filename pattern

Users can override the default pattern by adding a `## Your customizations` section **AFTER** the `LLM-FOR-ZOTERO:MANAGED-END` marker at the bottom of this skill file. The agent will follow the custom pattern instead of the default above (see Key rules).

Example customizations:

```
## Your customizations

Filename pattern: `{citekey}-{notetitle}.md`
Example: Buschman2020-figure-1.md
```

```
## Your customizations

Filename pattern: `{year}-{firstauthor}-{notetitle}.md`
Example: 2020-Buschman-figure-1.md
```

Any placeholder the user writes (`{citekey}`, `{firstauthor}`, `{year}`, `{doi}`, etc.) should be resolved from the same Zotero metadata the frontmatter fields use.

### Key rules

- **Never** output the full note text in chat. Always use `edit_current_note` or `file_io`.
- Use the note template above — frontmatter is locked to the 7 fields shown; do not add or remove fields.
- Use `[@citekey]` Pandoc syntax inline **only when `citekey` is non-empty**. When `citekey` is missing/empty, reference in prose (`First-Author et al. (Year)`) and rely on the full citation in `## References`. **Never emit `[@]`.** Adapt citation syntax to the target format (e.g., `[cite:@citekey]` for Org-mode) when citekey exists.
- **Every note ends with the footer** `---\n\nWritten by LLM-for-Zotero.` — no exceptions, no omissions, regardless of destination or format.
- Use the native path separator provided in the runtime platform section. Never mix separators.
- If the user has replaced this skill's managed block with their own customization (either by editing the block directly or by writing their own template outside the MANAGED markers), follow their customization instead of the defaults above.

### Budget
Total tool calls: 2–5 (read content, optionally look up citekeys, optionally copy images, write note).

<!-- LLM-FOR-ZOTERO:MANAGED-END -->
