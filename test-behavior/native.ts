import { check, assertExact } from "./core";

declare const Zotero: any;
export type NativeState = Record<string, Record<string, any>>;
export type NativeChange = {
  key: string;
  before?: Record<string, any>;
  after?: Record<string, any>;
};

export function normalizeNative(value: any, field = ""): any {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => normalizeNative(entry));
    return ["tags", "collections"].includes(field) || field.includes(":")
      ? entries.sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        )
      : entries;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => !["dateModified", "version"].includes(key))
        .map((key) => [key, normalizeNative(value[key], key)]),
    );
  return value;
}

export async function snapshot(): Promise<NativeState> {
  const entries: [string, Record<string, any>][] = [];
  for (const library of Zotero.Libraries.getAll()) {
    const items = await Zotero.Items.getAll(library.libraryID, false, true);
    for (const item of items) {
      await item.reload(undefined, true);
      entries.push([
        `item:${library.libraryID}:${item.key}`,
        normalizeNative({
          ...item.toJSON(),
          id: item.id,
          libraryID: item.libraryID,
          deleted: Boolean(item.deleted),
        }),
      ]);
    }
    for (const collection of Zotero.Collections.getByLibrary(
      library.libraryID,
      true,
    )) {
      await collection.reload(undefined, true);
      entries.push([
        `collection:${library.libraryID}:${collection.key}`,
        normalizeNative({
          ...collection.toJSON(),
          id: collection.id,
          libraryID: collection.libraryID,
          deleted: Boolean(collection.deleted),
        }),
      ]);
    }
  }
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

export function diff(before: NativeState, after: NativeState): NativeChange[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({ key, before: before[key], after: after[key] }));
}

export function onlyChanges(
  before: NativeState,
  after: NativeState,
  permit: (change: NativeChange) => boolean,
) {
  const unexpected = diff(before, after).filter((change) => !permit(change));
  check(
    !unexpected.length,
    `Unexpected native changes: ${unexpected.map((row) => row.key).join(", ")}`,
  );
}

export function itemKey(item: any) {
  return `item:${item.libraryID}:${item.key}`;
}
export function collectionKey(collection: any) {
  return `collection:${collection.libraryID}:${collection.key}`;
}
export function exactFieldChange(
  before: NativeState,
  after: NativeState,
  item: any,
  field: string,
  value: unknown,
) {
  const key = itemKey(item);
  const expected = normalizeNative({ ...before[key], [field]: value });
  assertExact(after[key], expected, `${item.key}.${field}`);
  onlyChanges(before, after, (change) => change.key === key);
}

export async function createFixtures(marker: string, harness: any) {
  const libraryID = Zotero.Libraries.userLibraryID;
  const collections: Record<string, any> = {};
  const collection = async (name: string, parent?: any) => {
    const result = new Zotero.Collection();
    result.libraryID = libraryID;
    result.name = `${name} ${marker}`;
    if (parent) result.parentID = parent.id;
    await result.saveTx();
    collections[name] = result;
    return result;
  };
  const root = await collection("Behavior Laboratory");
  for (const name of [
    "geometry",
    "memory",
    "unrelated",
    "destination",
    "notes",
    "imports",
    "mini-review",
  ])
    await collection(name, root);
  const items: Record<string, any> = {};
  const paper = async (key: string, title: string, folders: string[]) => {
    const result = new Zotero.Item("journalArticle");
    result.libraryID = libraryID;
    result.setField("title", `${title} ${marker}`);
    result.setField("date", "2024");
    result.setField(
      "abstractNote",
      "Synthetic behavior-test fixture. Population coding with stable readout despite neural representational drift. Not a published research result.",
    );
    result.setCreators([
      { creatorType: "author", firstName: "Test", lastName: "Fixture" },
    ]);
    result.setCollections(folders.map((name) => collections[name].id));
    await result.saveTx();
    items[key] = result;
    return result;
  };
  await paper("geometry", "Geometry of population coding", [
    "geometry",
    "unrelated",
  ]);
  await paper("memory", "Memory and representational drift", ["memory"]);
  await paper("shared", "Geometry and memory shared paper", [
    "geometry",
    "memory",
  ]);
  await paper("sentinel", "Unrelated turbine sentinel", ["unrelated"]);
  await paper("metadata", "Metadata-only population code", ["unrelated"]);
  const primary = await harness.createPaperWithPdfFixture({
    title: `Synthetic population coding paper ${marker}`,
    pdfTitle: `Behavior fixture ${marker}`,
    pages: [
      "SYNTHETIC TEST PAPER. Hypothesis: stable readout can coexist with representational drift. We call this the amber-readout hypothesis.",
      "Methods: longitudinal recordings across ten sessions. Fit a linear decoder on session one and test remaining sessions. Control: shuffle cell identities. This is the cobalt-control method.",
      "Figure description (text only): Figure 1 compares shuffled and intact decoding. The intact trajectory stays at 0.80 accuracy; shuffled accuracy is 0.52. The figure is called the violet-trajectory. No actual image is provided in this synthetic PDF.",
      "Results: intact decoding accuracy is 0.80, shuffled accuracy is 0.52. Neurons drift while population information remains readable. This is the silver-result.",
      "Limitations: a synthetic dataset, ten sessions, and one linear decoder cannot establish a biological causal mechanism. This is the copper-limitation.",
      "Implications: compare readout stability with changes in single-neuron tuning. Stable behavior need not imply fixed representations. This is the jade-implication. All numbers and labels are synthetic test content.",
    ],
  });
  items.primary = Zotero.Items.get(primary.parentItemId);
  // Realistic citation metadata, explicitly fictional. The source remains a
  // synthetic test paper; a missing-author fixture is not an author-year test.
  items.primary.setCreators([
    { creatorType: "author", firstName: "Test", lastName: "Fixture" },
  ]);
  items.primary.setField("date", "2024");
  items.primary.setCollections([root.id]);
  await items.primary.saveTx();
  return { marker, libraryID, root, collections, items, primary };
}

export type Fixtures = Awaited<ReturnType<typeof createFixtures>>;
