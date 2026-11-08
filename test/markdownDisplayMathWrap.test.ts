import { assert } from "chai";
import { renderMarkdown } from "../src/utils/markdown";

/**
 * Long display equations are split into an aligned block at top-level plus
 * and minus signs. A minus inside \left\| ... \right\| was split anyway,
 * which broke the \left/\right pair, and the error check missed KaTeX's own
 * "katex-error" label, so the broken split was shown in red.
 */
describe("markdown display math wrapping", function () {
  it("does not split inside \\left ... \\right", function () {
    const html = renderMarkdown(
      String.raw`$$(\sigma,\beta,b)_{\mathrm{fit}} = \underset{\sigma,\beta,b}{\operatorname{argmin}} \; \left\| \mathbf{c}_{\mathrm{model}}(\sigma,\beta,b) - \mathbf{c}_{\mathrm{data}} \right\|_2,$$`,
    );
    assert.notInclude(html, "katex-error");
    assert.include(html, 'class="katex-display"');
  });

  it("still splits long sums outside \\left ... \\right", function () {
    const html = renderMarkdown(
      String.raw`$$E = \left( \alpha_{1} x_{1} \right) + \left( \alpha_{2} x_{2} \right) + \left( \alpha_{3} x_{3} \right) + \left( \alpha_{4} x_{4} \right) + \left( \alpha_{5} x_{5} \right)$$`,
    );
    assert.notInclude(html, "katex-error");
    assert.include(html, "mtable");
  });
});
