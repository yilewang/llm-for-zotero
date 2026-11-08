import { assert } from "chai";
import { describe, it } from "mocha";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HEADER_FIT_METRICS,
  chooseHeaderFit,
  headerFitRequiredWidth,
  nextRuntimeCompression,
  type HeaderFit,
  type HeaderFitInput,
} from "../src/modules/contextPanel/setupHandlers/controllers/headerSpacing";

// Three runtime buttons can give up 26px in all.
const AVAILABLE = 26;

describe("nextRuntimeCompression", function () {
  it("keeps full spacing when the header fits", function () {
    assert.equal(nextRuntimeCompression(0, -10, AVAILABLE), 0);
  });

  it("grows to the smallest step that covers the shortage", function () {
    assert.closeTo(nextRuntimeCompression(0, 2.6, AVAILABLE), 0.1, 1e-9);
    assert.closeTo(nextRuntimeCompression(0, 2.7, AVAILABLE), 0.15, 1e-9);
  });

  it("caps at full compression", function () {
    assert.equal(nextRuntimeCompression(0, 100, AVAILABLE), 1);
  });

  it("returns to full spacing once there is room to spare", function () {
    assert.equal(nextRuntimeCompression(0.4, -10, AVAILABLE), 0);
  });

  it("settles when the shortage wobbles across a step line", function () {
    for (const center of [0, 2.6]) {
      let current = 0;
      const written: number[] = [];
      for (let frame = 0; frame < 20; frame++) {
        const shortage = center + (frame % 2 ? 0.1 : -0.1);
        const next = nextRuntimeCompression(current, shortage, AVAILABLE);
        if (next !== current && frame >= 4) written.push(next);
        current = next;
      }
      assert.deepEqual(
        written,
        [],
        `a shortage of ${center} ± 0.1px must settle, not flip every frame`,
      );
    }
  });
});

describe("chooseHeaderFit (the Stacked header's fit stage)", function () {
  // New chat and history on the left; Task progress and Open in window stay;
  // Settings, Export and Delete fold. The row pads 2px each side.
  const base: HeaderFitInput = {
    available: 1000,
    padding: 4,
    capsule: 100,
    leftButtons: 2,
    pinnedRightButtons: 2,
    foldableRightButtons: 3,
  };
  const need = (stage: HeaderFit, input = base) =>
    headerFitRequiredWidth(stage, input);

  it("counts each stage from button counts, boxes, gaps and the capsule", function () {
    // padding 4 + left 58 + capsule 100 + right 148 + 2 x 10
    assert.equal(need("full"), 330);
    // right is Task, Open in window and More: 3 x 28 + 2 x 2
    assert.equal(need("menu"), 270);
    // 24px boxes: left 50 + right 76, and 2 x 8 between blocks
    assert.equal(need("compact"), 246);
    // Tight folds Task progress and Open in window too: right is More alone.
    // padding 4 + left 50 + capsule 100 + right 24 + 2 x 8
    assert.equal(need("tight"), 194);
  });

  it("matches the real capsule (148px with both runtime toggles)", function () {
    const real = { ...base, padding: 6, capsule: 148 };
    assert.equal(need("tight", real), 244);
    assert.equal(need("compact", real), 296);
  });

  it("shows every action when the row is wide", function () {
    assert.equal(chooseHeaderFit({ ...base, available: 400 }, null), "full");
    assert.equal(chooseHeaderFit({ ...base, available: 330 }, null), "full");
  });

  it("never chooses full when allowFull is false (a web chat's Exit is not a box)", function () {
    const wide = { ...base, available: 1000, allowFull: false };
    assert.equal(chooseHeaderFit(wide, null), "menu");
    assert.equal(chooseHeaderFit(wide, "full"), "menu");
    assert.equal(chooseHeaderFit(wide, "menu"), "menu");
    assert.equal(chooseHeaderFit({ ...wide, available: 269 }, null), "compact");
    assert.equal(chooseHeaderFit({ ...wide, available: 100 }, "full"), "tight");
    assert.equal(
      chooseHeaderFit({ ...wide, available: 300 }, "compact"),
      "menu",
    );
  });

  it("folds Settings, Export and Delete when full does not fit", function () {
    assert.equal(chooseHeaderFit({ ...base, available: 329 }, null), "menu");
    assert.equal(chooseHeaderFit({ ...base, available: 270 }, null), "menu");
  });

  it("shrinks the boxes when even the menu stage does not fit", function () {
    assert.equal(chooseHeaderFit({ ...base, available: 269 }, null), "compact");
    assert.equal(chooseHeaderFit({ ...base, available: 246 }, null), "compact");
  });

  it("folds Task progress and Open in window when compact does not fit", function () {
    assert.equal(chooseHeaderFit({ ...base, available: 245 }, null), "tight");
    assert.equal(chooseHeaderFit({ ...base, available: 194 }, null), "tight");
  });

  it("makes tight the floor: nothing fits, tight", function () {
    assert.equal(chooseHeaderFit({ ...base, available: 193 }, null), "tight");
    assert.equal(chooseHeaderFit({ ...base, available: 100 }, null), "tight");
    assert.equal(chooseHeaderFit({ ...base, available: 100 }, "full"), "tight");
    assert.equal(
      chooseHeaderFit({ ...base, available: 100 }, "tight"),
      "tight",
    );
  });

  it("leaves a tighter stage at once and a roomier one only with 1px to spare", function () {
    // full -> menu the moment full needs one pixel more than there is.
    assert.equal(
      chooseHeaderFit({ ...base, available: 329.5 }, "full"),
      "menu",
    );
    // menu -> full needs 330 + 1.
    assert.equal(chooseHeaderFit({ ...base, available: 330 }, "menu"), "menu");
    assert.equal(
      chooseHeaderFit({ ...base, available: 330.9 }, "menu"),
      "menu",
    );
    assert.equal(chooseHeaderFit({ ...base, available: 331 }, "menu"), "full");
    // compact -> menu needs 270 + 1.
    assert.equal(
      chooseHeaderFit({ ...base, available: 270 }, "compact"),
      "compact",
    );
    assert.equal(
      chooseHeaderFit({ ...base, available: 271 }, "compact"),
      "menu",
    );
    // tight -> compact needs 246 + 1; compact -> tight the moment it is short.
    assert.equal(
      chooseHeaderFit({ ...base, available: 246 }, "tight"),
      "tight",
    );
    assert.equal(
      chooseHeaderFit({ ...base, available: 246.9 }, "tight"),
      "tight",
    );
    assert.equal(
      chooseHeaderFit({ ...base, available: 247 }, "tight"),
      "compact",
    );
    assert.equal(
      chooseHeaderFit({ ...base, available: 245.5 }, "compact"),
      "tight",
    );
  });

  it("jumps over a stage when the row changes by more than one", function () {
    assert.equal(chooseHeaderFit({ ...base, available: 200 }, "full"), "tight");
    assert.equal(
      chooseHeaderFit({ ...base, available: 250 }, "full"),
      "compact",
    );
    assert.equal(
      chooseHeaderFit({ ...base, available: 500 }, "compact"),
      "full",
    );
    assert.equal(chooseHeaderFit({ ...base, available: 500 }, "tight"), "full");
  });

  it("settles when the width wobbles across a stage line", function () {
    for (const line of [330, 270, 246]) {
      let current = chooseHeaderFit({ ...base, available: line }, null);
      const changes: HeaderFit[] = [];
      for (let frame = 0; frame < 20; frame++) {
        const available = line + (frame % 2 ? 0.4 : -0.4);
        const next = chooseHeaderFit({ ...base, available }, current);
        if (next !== current && frame >= 4) changes.push(next);
        current = next;
      }
      assert.deepEqual(
        changes,
        [],
        `a width of ${line} +/- 0.4px must settle, not flip every frame`,
      );
    }
  });

  it("folds earlier when the capsule is wider", function () {
    const available = 330;
    assert.equal(chooseHeaderFit({ ...base, available }, null), "full");
    // A longer chip label (Library chat, Note chat) or a larger font.
    assert.equal(
      chooseHeaderFit({ ...base, available, capsule: 124 }, null),
      "menu",
    );
    assert.equal(
      chooseHeaderFit({ ...base, available, capsule: 190 }, null),
      "tight",
    );
  });

  it("drops a button from its block when code hides it", function () {
    // Without Task progress the full stage is 30px narrower.
    const noTask = { ...base, pinnedRightButtons: 1 };
    assert.equal(need("full", noTask), 300);
    assert.equal(chooseHeaderFit({ ...noTask, available: 300 }, null), "full");
  });

  it("keeps More in tight for Task progress and Open in window alone", function () {
    const none = { ...base, foldableRightButtons: 0 };
    // Tight folds the two pinned buttons into More: one box, not two.
    assert.equal(need("tight", none), need("tight"));
    const bare = { ...none, pinnedRightButtons: 0 };
    assert.equal(need("tight", bare), need("tight") - 24);
  });

  it("needs no More button when nothing folds", function () {
    const none = { ...base, foldableRightButtons: 0 };
    assert.equal(need("menu", none), need("full", none));
  });

  it("uses the sizes the stylesheet gives each stage", function () {
    const css = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../addon/content/zoteroPane.css",
      ),
      "utf8",
    );
    const stacked =
      ':root[data-llm-sidebar-layout="stacked"] .llm-header-nav-row';
    const flat = css.replace(/\s+/g, " ");
    const rule = (selector: string) =>
      flat.match(
        new RegExp(
          `(?:^|[}/] )${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`,
        ),
      )?.[1] || "";
    const full = rule(stacked);
    const compact = rule(`${stacked}[data-fit="compact"]`);
    assert.include(full, `--llm-header-box: ${HEADER_FIT_METRICS.full.box}px`);
    assert.include(
      full,
      `--llm-header-gap-min: ${HEADER_FIT_METRICS.full.minGap}px`,
    );
    assert.include(
      compact,
      `--llm-header-box: ${HEADER_FIT_METRICS.compact.box}px`,
    );
    assert.include(
      compact,
      `--llm-header-gap-min: ${HEADER_FIT_METRICS.compact.minGap}px`,
    );
    const tight = rule(`${stacked}[data-fit="tight"]`);
    assert.include(
      tight,
      `--llm-header-box: ${HEADER_FIT_METRICS.tight.box}px`,
    );
    assert.include(
      tight,
      `--llm-header-gap-min: ${HEADER_FIT_METRICS.tight.minGap}px`,
    );
    assert.deepEqual(HEADER_FIT_METRICS.menu, {
      ...HEADER_FIT_METRICS.full,
      folded: true,
    });
    assert.deepEqual(HEADER_FIT_METRICS.tight, {
      ...HEADER_FIT_METRICS.compact,
      foldedPinned: true,
    });
  });
});
