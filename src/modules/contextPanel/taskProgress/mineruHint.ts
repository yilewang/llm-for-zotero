/**
 * Whether a paper has MinerU text, asked lazily for the Task progress rows
 * on screen. The answer is cached per paper for the session; a paper parsed
 * later shows MinerU once its row is rebuilt in a new drawer session.
 */
import { hasCachedMineruMd } from "../../../services/mineru/mineruCache";

const cache = new Map<string, Promise<boolean>>();
const MAX_CACHED = 5000;

type ItemLike = {
  getAttachments?: () => number[];
  isPDFAttachment?: () => boolean;
};

async function lookup(itemId: number): Promise<boolean> {
  const items = (
    globalThis as { Zotero?: { Items?: { get?: (id: number) => unknown } } }
  ).Zotero?.Items;
  const item = items?.get?.(itemId) as ItemLike | undefined;
  for (const attachmentId of item?.getAttachments?.() || []) {
    const attachment = items?.get?.(attachmentId) as ItemLike | undefined;
    if (!attachment?.isPDFAttachment?.()) continue;
    if (await hasCachedMineruMd(attachmentId)) return true;
  }
  return false;
}

export function resolveMineruHint(paper: {
  libraryID: number;
  itemId: number;
}): Promise<boolean> {
  const key = `${paper.libraryID}:${paper.itemId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  if (cache.size >= MAX_CACHED) cache.clear();
  const pending = lookup(paper.itemId).catch(() => false);
  cache.set(key, pending);
  return pending;
}
