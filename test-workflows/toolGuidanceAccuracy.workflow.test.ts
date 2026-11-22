import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { toolGuidanceItems } from "../src/agent/tools/guidance";

declare const Zotero: any;

// The text the model reads about a tool must match what the tool does (#580).
describe("workflow: tool descriptions match tool behavior", function () {
  const agent = () => Zotero.LLMForZotero.api.agent;

  function guidanceText(toolName: string): string {
    const tool = agent().getToolDefinition(toolName);
    assert.isOk(tool, `${toolName} is registered`);
    return toolGuidanceItems(tool.guidance)
      .map((item) => item.instruction)
      .join("\n");
  }

  it("library_import guidance says it only creates new items and names attach_file", function () {
    const text = guidanceText("library_import");
    assert.notInclude(text, "other files are attached");
    assert.include(text, "only creates new top-level items");
    assert.include(text, "action 'attach_file'");
  });

  it("library_update guidance offers attaching a file to an existing item", function () {
    const text = guidanceText("library_update");
    assert.include(text, "attach_file");
    assert.include(text, "attach_url");
    assert.include(text, "find_pdf");
  });

  it("annotate_pdf's model description covers underlines and sticky notes", function () {
    const spec = agent()
      .listTools()
      .find((tool: { name: string }) => tool.name === "annotate_pdf");
    assert.isOk(spec, "annotate_pdf is listed for the model");
    assert.include(spec.description, "underline");
    assert.include(spec.description, "sticky note");
    assert.include(spec.description, "annotationType:'note'");
  });
});
