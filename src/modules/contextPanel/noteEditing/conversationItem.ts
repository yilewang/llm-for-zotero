import type { ConversationSystem } from "../../../shared/types";

type NoteConversation = {
  note: Zotero.Item;
  system: ConversationSystem;
  conversationKey: number;
};

// Each mounted surface owns its note/chat binding. Never bind a remembered
// conversation to the shared native Zotero item itself.
const noteConversations = new WeakMap<object, NoteConversation>();

export function getNoteConversation(
  item: Zotero.Item | null | undefined,
): NoteConversation | undefined {
  return item ? noteConversations.get(item) : undefined;
}

export function createNoteConversationItem(
  item: Zotero.Item,
  system: ConversationSystem,
  conversationKey: number,
): Zotero.Item {
  const note = getNoteConversation(item)?.note || item;
  const binding = { note, system, conversationKey };
  const methods = new Map<PropertyKey, unknown>();
  const view = new Proxy(note, {
    get(target, property) {
      // Like the paper/global portals, composer state belongs to the chat.
      if (property === "id") return binding.conversationKey;
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (!methods.has(property)) methods.set(property, value.bind(target));
      return methods.get(property);
    },
    set(target, property, value) {
      if (property === "id") return false;
      return Reflect.set(target, property, value, target);
    },
  });
  noteConversations.set(view, binding);
  return view;
}
