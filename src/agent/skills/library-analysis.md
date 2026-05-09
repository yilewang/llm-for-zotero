---
id: library-analysis
description: Analyze your whole library or collection with statistics
version: 2
match: /\b(summarize|summarise|summary|overview|statistics|stats|analyze|analyse|breakdown|survey|audit)\b.*\b(library|collection|all papers|all items|my papers|entire|whole)\b/i
match: /\b(my library|whole library|entire library|all my)\b.*\b(summarize|summarise|summary|overview|analyze|analyse|statistics|stats|topics?|themes?|trends?|breakdown)\b/i
match: /\bhow many\b.*\b(papers?|items?|articles?|books?)\b/i
match: /\b(distribution|breakdown|histogram)\b.*\b(years?|tags?|authors?|types?|collections?|journals?|venues?)\b/i
---

<!--
  SKILL: Library Analysis

  This skill activates when you ask for statistics or analysis of your
  library or collection (e.g., "how many papers do I have?", "analyze
  my library", "breakdown by year").

  You can customize:
  - Analysis dimensions: change what statistics are gathered
  - Script templates: modify the Zotero script used for aggregation
  - Output format: adjust how results are presented

  Your changes are preserved across plugin updates.
  To reset to default, delete this file — it will be recreated on next restart.
-->

## Library / Collection Analysis - use zotero_script read mode

When the user asks for a summary, overview, statistics, or analysis of their **whole library or a collection**, do NOT make multiple `query_library` calls to page through results. Each `query_library` call returns full metadata for every matching item, which quickly overflows the context window.

Instead, use a single `zotero_script({ mode:'read', description:'Analyze library or collection statistics', script:'...' })` call that iterates all items inside Zotero's runtime and aggregates the answer in one pass. The script runs locally — there is no context-size limitation because only the final `env.log()` output is returned to the conversation.

### Strategy

1. Write a `zotero_script({ mode:'read', description:'Analyze library or collection statistics', script:'...' })` script that:
   - Calls `Zotero.Items.getAll(env.libraryID, false, false, false)` to get all items.
   - Filters to `item.isRegularItem()` (skips attachments, notes, annotations).
   - Aggregates whatever the user asked for (counts by year, by type, by tag, top authors, collection sizes, etc.).
   - Calls `env.log()` with the aggregated result (compact JSON or readable text).
2. Present the aggregated output to the user with interpretation.
3. If the user needs detail on specific items after seeing the summary, use `query_library` with targeted filters for just those items.

### Example: "give me an overview of my library"

```javascript
const items = await Zotero.Items.getAll(env.libraryID, false, false, false);
const byYear = {};
const byType = {};
const byTag = {};
let total = 0;
for (const item of items) {
  if (!item.isRegularItem()) continue;
  total++;
  const year = String(item.getField("date") || "").slice(0, 4) || "unknown";
  byYear[year] = (byYear[year] || 0) + 1;
  byType[item.itemType] = (byType[item.itemType] || 0) + 1;
  for (const tag of item.getTags()) {
    byTag[tag.tag] = (byTag[tag.tag] || 0) + 1;
  }
}
env.log(JSON.stringify({ total, byYear, byType, byTag }, null, 2));
```

### Key rules

- NEVER page through `query_library` to collect all items — it will overflow the context.
- A single `zotero_script({ mode:'read', description:'Analyze library or collection statistics', script:'...' })` can process thousands of items because only the final summary is returned.
- If the user asks about a specific collection, filter by collection inside the script using `Zotero.Collections.get(collectionId).getChildItems()`.
- Keep `env.log()` output concise — aggregate, don't list every item.
- Use `query_library` only for targeted follow-up detail (e.g. "show me the 5 oldest papers").
