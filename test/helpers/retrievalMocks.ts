type TextRetrievalMock = { retrieveEvidence: (...args: never[]) => unknown };

/**
 * Adds the image-aware entry point the read tools call to a retrieval mock
 * that only stubs text evidence; it delegates and returns no images.
 */
export function withImageRetrieval<T extends TextRetrievalMock>(mock: T) {
  const retrieveEvidence = mock.retrieveEvidence as (
    params: unknown,
  ) => unknown;
  return {
    ...mock,
    retrieveEvidenceWithImages: async (params: unknown) => ({
      results: await retrieveEvidence(params),
      images: [],
    }),
  };
}
