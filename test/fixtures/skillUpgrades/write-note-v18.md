---
id: write-note
description: Create, save, or edit a Zotero note or Markdown note, including requested figures or an existing answer. Use only when the user explicitly requests a note.
version: 18
contexts: any
activation: auto
---

<!-- LLM-FOR-ZOTERO:MANAGED-BEGIN -->

## Write or save a note

Follow the requested operation, content, destination, and preservation constraints.
User customizations take precedence over formatting defaults, within the current request and host permissions.
Resolve an ambiguous target or operation before writing.

### Choose the content

- To save an existing answer unchanged, use `note_write` with its `sourceMessageId` and destination.
  Use `context_read` with `source: "conversation"` only to recover the source identity or exact text; do not regenerate or reformat it.
- For a narrowly scoped note, such as selected figures with captions or a requested paragraph, keep that scope.
  Do not expand it into a reading-note template or add scientific interpretation that was not requested.
- For new or revised reading notes, reuse supplied evidence and read further only as needed.
  Obtain missing title, authors, year, citekey, DOI, and journal from Zotero metadata.

### Note template

For a full paper reading note, default to the paper title followed by Summary, Key Findings, Methodology, My Notes, and References.
Keep model-generated questions or critiques distinct from the user's own notes.
For a general note, use the requested title and a structure suited to its content.
These defaults do not apply to unchanged-answer saving or narrower formats.

Zotero notes omit YAML frontmatter.
Markdown files for full paper reading notes use this frontmatter; missing metadata becomes an empty string:

```yaml
---
title: "{{paperTitle}}"
citekey: "{{citekey}}"
doi: "{{doi}}"
year: "{{year}}"
journal: "{{journal}}"
created: "{{created}}"
tags: [zotero, paper-note]
---
```

General Markdown notes use only `title`, `created`, and `tags: [zotero]`.
Keep the title equal to the paper's full title or the requested general-note title; filename, subtopic, and date are separate.
Use the runtime's local date for `created` and the configured naming template; do not run a command just to get the date.
Use these fields without extras unless the user's formatting instructions override them.

For newly composed paper reading notes, use `[@citekey]` only for a nonempty citekey; otherwise use readable author-year mentions.
Include a References section using available Zotero citation metadata, never empty citations or invented fields.
End newly composed notes with `---` followed by `Written by LLM-for-Zotero.` (or its HTML equivalent).

### Figures

Follow the analyze-figures skill for obtaining crops; embed the returned crop paths as Markdown `file://` image links.
The note tool imports and verifies those images.

### Save or export

For Zotero, use the exact create, append, or edit operation and resolved note, parent paper, or collection with `note_write`.
For a file, finalize the document with `submit_document`, including host-issued figure assets and evidence references.
Pass the returned `documentId`, exact finalized `visibleMarkdown`, and resolved destination to `file_io`.
The host exports verified assets and writes relative links; preserve the finalized material for retry if saving fails.
Report persistence from the tool's verified result separately from content generation.

<!-- LLM-FOR-ZOTERO:MANAGED-END -->
