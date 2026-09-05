/**
 * Multilingual note-taking intent detection, shared by every skill router.
 *
 * Note-taking must trigger the write-note skill regardless of the user's
 * language or phrasing: user customizations live in that skill, so a missed
 * trigger silently ignores them. These deterministic patterns back up the
 * LLM intent classifier (built-in mode) and drive the deterministic route
 * (codex native mode), so the guarantee holds even when the classifier is
 * unavailable or wrong.
 *
 * Regex boundary rules used below (JS `\b` is ASCII-only — it never matches
 * at the edge of a non-ASCII letter):
 * - Latin words with ASCII initial/final letters use `\b`.
 * - Word-initial accented (écri…), Cyrillic, and Arabic stems use a
 *   `(?<!\p{L})` lookbehind instead, so they cannot match inside a longer
 *   word (décrire, بدون, перезаписать).
 * - CJK nouns carry negative lookaheads for compound words that are not
 *   notes: 笔记本电脑 / ノートパソコン / 노트북 (laptop), メモリ / 메모리 (memory).
 */
import type { AgentRuntimeRequest } from "../types";

export const WRITE_NOTE_SKILL_ID = "write-note";

export const NOTE_OBJECT_PATTERN =
  /\bnotes?\b|\bnota(?:s)?\b|\bnotiz(?:en)?\b|\bapuntes\b|笔记(?!本电脑)|便签|札记|读书笔记|ノート(?!パソコン|PC|ブック)|メモ(?!リ)|노트(?!북)|메모(?!리)|필기|заметк\p{L}*|ملاحظة/iu;
export const NOTE_ACTION_PATTERN =
  /\bsave\b|\bwrite\b|\bcreate\b|\bmake\b|\bedit\b|\bupdate\b|\brevise\b|\bpolish\b|\bappend\b|\binsert\b|\badd\b|\bguardar\b|\bescribir\b|\bredactar\b|\bcrear\b|\beditar\b|\bactualizar\b|\bmodificar\b|\bañadir\b|\bajouter\b|\benregistr\p{L}*|(?<!\p{L})écri\p{L}*|\becrire\b|\brédig\p{L}*\b|\brediger\b|\bcréer\b|\bcreer\b|\bmodifier\b|\bspeichern\b|\bschreiben\b|\berstellen\b|\bbearbeiten\b|\baktualisieren\b|\bhinzuf\p{L}*\b|\bsalvar\b|\bescrever\b|\bcriar\b|\batualizar\b|\bsalva\p{L}*\b|\bscrivere\b|\bcreare\b|\bmodificare\b|\baggiornare\b|(?<!\p{L})(?:напис|напиш|созда|сохран|запис|запиш|обнов|отредактир|редактир|добав)\p{L}*|(?<!\p{L})(?:اكتب|أنشئ|احفظ|دوّن|دون|أضف|حرر)|保存|写|撰写|创建|新建|编辑|修改|更新|润色|加入|添加|追加|書|作成|編集|저장|작성|생성|편집|수정|업데이트|추가/iu;
export const NOTE_EXPLICIT_PATTERN =
  /\bsave\s+(?:it|this|that|them)?\s*(?:as|to)?\s*(?:my\s+)?notes?\b|\b(?:write|create|make|edit|update|append)\s+(?:a\s+|my\s+)?notes?\b|保存.*笔记(?!本电脑)|笔记(?!本电脑).*保存|ノート(?!パソコン|PC|ブック).*保存|メモ(?!リ).*保存|노트(?!북).*저장|메모(?!리).*저장/iu;

/**
 * Shared text normalizer for intent matching AND the codex classifier cache
 * signature (nativeSkills imports this — the two must never diverge).
 * The raw input is pre-sliced before NFKC/regex work so pasted multi-page
 * blobs stay cheap; 4000 chars comfortably survives whitespace collapsing
 * to fill the 2000-char output cap.
 */
export function normalizeIntentText(value: string): string {
  return value
    .slice(0, 4000)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 2000);
}

/**
 * Text-only note intent: an explicit save-as-note phrasing, or a note noun
 * combined with a note action verb. This is the signal strong enough to
 * FORCE the write-note skill with no supporting context — mirroring the
 * shipped English `match:` fallbacks, in every language.
 */
export function inferExplicitNoteIntent(userText: string | undefined): boolean {
  const text = normalizeIntentText(userText || "");
  if (!text) return false;
  if (NOTE_EXPLICIT_PATTERN.test(text)) return true;
  return NOTE_OBJECT_PATTERN.test(text) && NOTE_ACTION_PATTERN.test(text);
}

/**
 * Full note-intent check: text signals as in inferExplicitNoteIntent, plus
 * weaker phrasings accepted when a note is open or note text is selected.
 * The weak branches fire on a bare action verb, so consumers that force
 * skills without a classifier veto should prefer inferExplicitNoteIntent;
 * the codex-native deterministic route keeps these branches deliberately
 * (no classifier runs there, and an open note makes note intent likely).
 */
export function inferNoteIntent(
  request: Pick<
    AgentRuntimeRequest,
    "userText" | "activeNoteContext" | "selectedTextSources" | "selectedTexts"
  >,
): boolean {
  const text = normalizeIntentText(request.userText || "");
  if (!text) return false;
  if (inferExplicitNoteIntent(text)) return true;

  const hasNoteContext = Boolean(request.activeNoteContext);
  const hasNoteSelection = Boolean(
    request.selectedTextSources?.some(
      (source) => source === "note" || source === "note-edit",
    ),
  );
  if (!hasNoteContext && !hasNoteSelection) return false;

  if (NOTE_ACTION_PATTERN.test(text)) return true;
  if (NOTE_OBJECT_PATTERN.test(text) && text.length <= 240) return true;
  return Boolean(request.selectedTexts?.length && text.length <= 160);
}
