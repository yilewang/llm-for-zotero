// scripts/check-retired-tool-names.cjs
// Fails when a retired tool name appears in src (code, prompt prose, or skill
// .md files) outside the effect-operation vocabulary files, or anywhere in the
// live workflow suite (test-workflows/**/*.ts), which drives the real tools by
// name. Names that remain internal identifiers (IDENTIFIER_NAMES) are allowed
// only as exact double-quoted string literals or object keys.
//
// test/ is deliberately NOT scanned: its shared fixtures can carry historical
// traces and stored tool history, which legitimately use retired names.
/* global __dirname -- CommonJS script; eslint config only declares console/process */
const fs = require("fs");
const path = require("path");
// Retired tool names that live on as internal identifiers: each is the
// spec.name of a facade delegate (journaling, presentation) and most are also
// effect-operation names. As an exact double-quoted literal ("apply_tags") or an
// object key (apply_tags: ...) they are that identifier; anywhere else -- in
// prose, a comment, or a skill file -- they read as a tool the model cannot
// call, and are hits.
const IDENTIFIER_NAMES = [
  "apply_tags",
  "set_item_tags",
  "tag_update",
  "move_to_collection",
  "update_metadata",
  "reparent_items",
  "relate_items",
  "import_identifiers",
  "import_local_files",
  "create_items",
  "trash_items",
  "restore_from_trash",
  "merge_items",
  "collection_update",
  "attachment_update",
  "saved_search_update",
];
const RETIRED_TOOL_NAMES = [
  // grown by each retirement task
  "read_paper",
  "search_paper",
  "view_pdf_pages",
  "query_library",
  "read_library",
  "search_literature_online",
  "edit_current_note",
  "write_notes_batch",
  "manage_collections",
  "manage_attachments",
  "undo_last_action",
  "revert_changes",
  "tool_result_read",
  "conversation_read",
  // plan mode and its research engine (retired with it)
  "update_plan",
  "amend_plan",
  "prepare_plan_execution",
  "submit_plan_document",
  "research_update",
  "approve_research_expansion",
  "approve_research_mutation",
  ...IDENTIFIER_NAMES,
];
// Repo-relative, forward-slash prefixes matched with startsWith.
const ALLOWLIST = [
  "src/agent/services/libraryMutation/", // operation handlers
  "src/modules/contextPanel/agentTrace/actionCardModel.ts",
  "src/agent/context/toolNames.ts", // RETIRED_TOOL_HINTS: retired name -> facade
  "src/agent/finalization/finalAnswerController.ts", // accepts search_literature_online from stored tool history
  "src/modules/contextPanel/taskProgress/codexPlan.ts", // Codex's own update_plan checklist, not ours
  "src/modules/contextPanel/agentTrace/noteReviewCard.ts", // accepts edit_current_note from stored review cards
];
const REPO_ROOT = path.resolve(__dirname, "..");
// Each root with the files it scans: src skips its co-located *.test.ts files;
// every workflow file is a *.workflow.test.ts, so that root scans all .ts.
const SCAN_ROOTS = [
  { dir: path.join(REPO_ROOT, "src"), isScanned: isSrcScanned },
  {
    dir: path.join(REPO_ROOT, "test-workflows"),
    isScanned: (file) => file.endsWith(".ts"),
  },
];
function toRepoPath(absolute) {
  // Forward slashes on every platform so ALLOWLIST prefixes match on Windows.
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}
function isSrcScanned(file) {
  return (
    (file.endsWith(".ts") && !file.endsWith(".test.ts")) || file.endsWith(".md")
  );
}
function walk(dir, isScanned, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, isScanned, out);
    else if (isScanned(p)) out.push(p);
  }
  return out;
}
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const patterns = RETIRED_TOOL_NAMES.map((name) => ({
  name,
  re: new RegExp("\\b" + escapeRegExp(name) + "\\b", "g"),
  // An exact double-quoted literal, or a bare object key (line start, "{" or
  // ","). Prettier writes every code string double-quoted, so a single-quoted
  // or backtick form can only be prose or a comment, and stays a hit.
  identifier: IDENTIFIER_NAMES.includes(name)
    ? new RegExp(
        '"' +
          escapeRegExp(name) +
          '"|(^|[{,])[ \\t]*' +
          escapeRegExp(name) +
          "[ \\t]*:",
        "gm",
      )
    : null,
}));
const hits = [];
const files = SCAN_ROOTS.flatMap(({ dir, isScanned }) => walk(dir, isScanned));
for (const absolute of files) {
  const file = toRepoPath(absolute);
  if (ALLOWLIST.some((a) => file.startsWith(a))) continue;
  const text = fs.readFileSync(absolute, "utf8");
  for (const { name, re, identifier } of patterns) {
    const scanned =
      identifier && !file.endsWith(".md") ? text.replace(identifier, "") : text;
    const m = scanned.match(re);
    if (m) hits.push(`${file}: ${name} x${m.length}`);
  }
}
if (hits.length) {
  console.error("Retired tool names still referenced:\n" + hits.join("\n"));
  process.exit(1);
}
console.log(
  `OK: no retired tool names in src or test-workflows (${RETIRED_TOOL_NAMES.length} names checked, ${files.length} files)`,
);
