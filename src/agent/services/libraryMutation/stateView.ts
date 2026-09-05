import type { LibraryMutationState } from "./contracts";

type CollectionState = NonNullable<LibraryMutationState["collections"]>[number];
type ItemState = NonNullable<LibraryMutationState["items"]>[number];
type SavedSearchState = NonNullable<
  LibraryMutationState["savedSearches"]
>[number];

/** One immutable, indexed view over a captured mutation state. */
export class MutationStateView {
  readonly raw: LibraryMutationState;
  readonly items: LibraryMutationState["items"];
  readonly collections: LibraryMutationState["collections"];
  readonly savedSearches: LibraryMutationState["savedSearches"];
  readonly libraryTags: LibraryMutationState["libraryTags"];
  readonly relations: LibraryMutationState["relations"];

  readonly #itemsById = new Map<number, ItemState>();
  readonly #collectionsById = new Map<number, CollectionState>();
  readonly #savedSearchesById = new Map<number, SavedSearchState>();

  constructor(state: LibraryMutationState) {
    this.raw = state;
    this.items = state.items;
    this.collections = state.collections;
    this.savedSearches = state.savedSearches;
    this.libraryTags = state.libraryTags;
    this.relations = state.relations;
    for (const item of state.items || []) {
      if (!this.#itemsById.has(item.itemId)) {
        this.#itemsById.set(item.itemId, item);
      }
    }
    for (const collection of state.collections || []) {
      if (!this.#collectionsById.has(collection.collectionId)) {
        this.#collectionsById.set(collection.collectionId, collection);
      }
    }
    for (const savedSearch of state.savedSearches || []) {
      if (!this.#savedSearchesById.has(savedSearch.savedSearchId)) {
        this.#savedSearchesById.set(savedSearch.savedSearchId, savedSearch);
      }
    }
  }

  item(itemId: number): ItemState | undefined {
    return this.#itemsById.get(itemId);
  }

  collection(collectionId: number): CollectionState | undefined {
    return this.#collectionsById.get(collectionId);
  }

  savedSearch(savedSearchId: number): SavedSearchState | undefined {
    return this.#savedSearchesById.get(savedSearchId);
  }
}

export function asMutationStateView(
  state: LibraryMutationState | MutationStateView,
): MutationStateView {
  return state instanceof MutationStateView
    ? state
    : new MutationStateView(state);
}
