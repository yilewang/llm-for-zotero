import { assert } from "chai";
import { noteDestinationForRequest } from "../src/agent/writeNoteDestination";
import { classifiedFixture, semanticFixture } from "./helpers/semanticIntent";

describe("semantic note destinations", function () {
  it("does not infer a destination from absent interpretation", function () {
    assert.equal(noteDestinationForRequest({}), "none");
  });
  for (const noteDestination of ["none", "zotero", "file", "both"] as const) {
    it(`preserves the shared ${noteDestination} decision`, function () {
      assert.equal(
        noteDestinationForRequest({
          classifiedIntent: classifiedFixture({
            semantic: semanticFixture({ noteDestination }),
          }),
        }),
        noteDestination,
      );
    });
  }
});
