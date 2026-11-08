---
id: library-analysis
description: Analyze your whole library or collection with statistics
version: 5
contexts: library-corpus
activation: auto
---

## Analyze a library or collection

Distinguish metadata statistics from questions that require reading paper evidence.
Keep the selected library, collection, or tag scope throughout the analysis.

For counts and distributions, aggregate locally with `zotero_script({ access:'library', effect:'read', ... })` and return a compact result.
For a whole library, `await Zotero.Items.getAll(env.libraryID, false, false, false)` supplies items; filter with `item.isRegularItem()` to exclude notes and attachments.
For a collection, resolve its items through `Zotero.Collections.get(collectionId).getChildItems()` and respect the requested descendant scope.
Do not page through broad `library_search` results merely to count or aggregate them.
Use targeted catalog searches for requested item details.

For topics, methods, or findings, use scoped `library_retrieve`: `enumerate` for which papers, `verify` for a specific claim, and `summarize` for synthesis.
Use relevant query variants when terminology or language affects recall.
Treat its `paperMatches` as the paper ledger and its snippets as the body evidence, and assess them with the coverage frontier before deciding on close reading.
Library results show what the request needs: `omitted` counts what a result left out, and `context_read` with its `toolResultHandle` pages the rest when the answer needs it.
A count of papers with retrieved evidence is not an exhaustive prevalence estimate when coverage is partial.
Report missing, sampled, abstract-only, or unreadable evidence explicitly.
