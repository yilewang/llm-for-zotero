export const previewRows = (count: number) => ({
  rows: Array.from({ length: count }, (_, index) => ({
    id: index,
    text: "x".repeat(250),
    values: [index, index + 1, index + 2, index + 3, index + 4],
  })),
});

export const previewListing = (count: number) => ({
  entity: "items",
  mode: "list",
  totalCount: count,
  items: Array.from({ length: count }, (_, index) => ({
    itemId: index,
    title: `A study of thing ${index} `.repeat(4),
    creators: ["Alpha A", "Beta B", "Gamma C", "Delta D", "Eps E"],
    tags: ["t1", "t2", "t3", "t4"],
    collections: [1, 2, 3, 4],
    year: "2020",
  })),
});
