import { inferExplicitNoteIntent } from "./skills/noteIntent";

export type WriteNoteDestination = "none" | "zotero" | "file" | "both";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesConfiguredNickname(text: string, nickname?: string): boolean {
  const trimmed = (nickname || "").trim();
  if (!trimmed) return false;
  const escaped = escapeRegex(trimmed);
  const isAscii = /^[\x20-\x7E]+$/.test(trimmed);
  const pattern = isAscii
    ? new RegExp(`\\b${escaped}\\b`, "i")
    : new RegExp(escaped, "i");
  return pattern.test(text);
}

function hasPathLikeDestination(text: string): boolean {
  return /(?:^|\s)(?:~\/|\.{1,2}\/|\/[^\s]+|[A-Za-z]:[\\/]|[^\s]+\.md\b)/i.test(
    text,
  );
}

function hasFileDestinationSignal(
  text: string,
  notesDirectoryNickname?: string,
): boolean {
  if (matchesConfiguredNickname(text, notesDirectoryNickname)) return true;
  if (/\b(obsidian|vault)\b/i.test(text)) return true;
  if (/\b(?:markdown|md)\s+files?\b/i.test(text)) return true;
  // "md 文件" / "markdown ファイル" style phrasings.
  if (
    /(?:markdown|md)\s*(?:文件|文档|檔案|ファイル|파일|файл\p{L}*)/iu.test(text)
  ) {
    return true;
  }
  if (hasPathLikeDestination(text)) return true;
  // CJK save-to-file phrasings. A file noun alone is NOT a signal
  // (文件 usually names the source PDF); the destination reading needs a
  // save verb joined to the noun by a directional marker (保存为md文件,
  // ファイルに保存, 파일로 저장) or a compound write-into verb (写入文件).
  // Verb→noun and noun→verb orders are both covered.
  //
  // Folder nouns (文件夹 / 目录 / フォルダ / 폴더) are deliberately absent:
  // in a Zotero plugin a folder is a collection, not a filesystem path
  // (issue #374). `文件` therefore carries a `(?!夹)` guard so it cannot
  // match inside the compound 文件夹 and reinstate the old reading.
  if (
    /(?:保存|存|导出|導出|输出|輸出|エクスポート|書き出し?|저장|내보내\p{L}*)[^\n。]{0,10}?(?:到|至|为|為|成|として)[^\n。]{0,10}(?:文件(?!夹)|文檔|檔案)|(?:写入|寫入|存入|存进|存進)[^\n。]{0,6}(?:文件(?!夹)|文檔|檔案)|(?:文件(?!夹)|ファイル|파일)(?:に|へ|として|里|中|에|로|으로)[^\n。]{0,10}(?:保存|書き出|出力|エクスポート|导出|導出|写入|寫入|存|저장|내보내)/u.test(
      text,
    )
  ) {
    return true;
  }
  // European-language save-to-file/folder phrasings, stem-based to cover
  // conjugations (guardar/guarda, speichern/speichere, enregistrer/enregistre…).
  // `\b` is ASCII-only in JS, so word-initial accented (écri…) and Cyrillic
  // stems use a `(?<!\p{L})` lookbehind instead of `\b` (décrire must not
  // match). The noun list is non-English on purpose — pairing these verbs
  // with English nouns ("local", "disk") regressed plain-English requests —
  // and finite export forms exclude English "exported".
  if (
    /(?:\b(?:guarda\p{L}*|export(?:ar|er|e|en|ez|ieren)|salva(?!guard)\p{L}*|enregistr\p{L}*|ecri\p{L}*|speicher\p{L}*|schreib\p{L}*)\b|(?<!\p{L})écri\p{L}*|(?<!\p{L})(?:сохран|экспорт|запис|запиш)\p{L}*)[^\n]{0,60}(?:\b(?:archivo|fichier|datei)\b|(?<!\p{L})файл\p{L}*)/iu.test(
      text,
    )
  ) {
    return true;
  }
  return /\b(?:save|write|export|send|put|create|make)\b[\s\S]{0,120}\b(?:to|into|as|in|under)\s+(?:(?:an?|the|my|your)\s+)?(?:(?:local|markdown)\s+)?(?:files?|directories|directory|disk)\b/i.test(
    text,
  );
}

/**
 * The narrow case Zotero-first was meant to catch: the user names Zotero as
 * the destination *in contrast to* a file destination. This requires a
 * directional phrase ("in Zotero", "into Zotero", "as a Zotero note"), not a
 * bare mention, so "this Zotero paper" does not qualify.
 */
function hasExplicitZoteroOverFileSignal(text: string): boolean {
  return /\b(?:in|into|to|inside|within)\s+zotero\b|\bzotero\s+(?:note|collection|library)\b|\bnot\s+(?:in\s+)?(?:obsidian|a\s+file|to\s+a\s+file)\b/i.test(
    text,
  );
}

function hasZoteroDestinationSignal(text: string): boolean {
  return /\b(?:zotero(?:\s+library|\s+note)?|standalone\s+notes?|item\s+notes?|child\s+notes?|current\s+(?:zotero\s+)?notes?|active\s+(?:zotero\s+)?notes?|open\s+(?:zotero\s+)?notes?)\b/i.test(
    text,
  );
}

function hasGenericNoteWriteSignal(text: string): boolean {
  return (
    /\b(?:create|make|write|draft|generate|save|append|add|put|edit|update|modify|rewrite|revise|polish)\b[\s\S]{0,120}\b(?:notes?|summary\s+notes?|reading\s+notes?|study\s+notes?|literature\s+notes?|research\s+notes?)\b/i.test(
      text,
    ) ||
    /\b(?:notes?|summary\s+notes?|reading\s+notes?|study\s+notes?|literature\s+notes?|research\s+notes?)\b[\s\S]{0,120}\b(?:save|write|append|add|create|make|edit|update|modify|rewrite|revise|polish)\b/i.test(
      text,
    ) ||
    /\b(?:reading\s+notes?|study\s+notes?|literature\s+notes?|research\s+notes?)\b/i.test(
      text,
    ) ||
    /\b(?:summari[sz]e)\b[\s\S]{0,120}\b(?:into|as|to)\b[\s\S]{0,120}\bnotes?\b/i.test(
      text,
    )
  );
}

export function classifyWriteNoteDestination(
  userText: string | undefined,
  notesDirectoryNickname?: string,
): WriteNoteDestination {
  const text = (userText || "").trim();
  if (!text) return "none";
  const fileDestination = hasFileDestinationSignal(
    text,
    notesDirectoryNickname,
  );
  if (
    fileDestination &&
    hasZoteroDestinationSignal(text) &&
    /\b(?:and|also|then|plus)\b/i.test(text)
  ) {
    return "both";
  }
  // File first, deliberately.
  //
  // Reordering these looked attractive — "put this in Zotero, not Obsidian"
  // should pick Zotero — but `hasZoteroDestinationSignal` leads with a bare
  // \bzotero\b, which is a MENTION test, not a destination test. In a Zotero
  // plugin users say "this Zotero paper" constantly, so Zotero-first sent
  // explicit file requests ("save to ~/vaults/papers/x.md", "write to my
  // Obsidian vault for this Zotero paper") to a Zotero note, and with them
  // the whole file_io enforcement path in the runtime.
  //
  // An explicit filesystem cue — a path, an extension, a configured nickname,
  // Obsidian/vault — is a far stronger signal of intent than the product
  // name appearing somewhere in the sentence. The narrow contrast case is
  // handled below instead.
  if (hasExplicitZoteroOverFileSignal(text)) return "zotero";
  if (fileDestination) return "file";
  if (hasZoteroDestinationSignal(text)) return "zotero";
  if (hasGenericNoteWriteSignal(text)) return "zotero";
  // `hasGenericNoteWriteSignal` is English-only. The multilingual note-intent
  // patterns already exist and are shared by every skill router, so a
  // non-English note request lands on the Zotero route instead of falling
  // through to "none" and leaving the destination unspecified.
  if (inferExplicitNoteIntent(text)) return "zotero";
  return "none";
}
