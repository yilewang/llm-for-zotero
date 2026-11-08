import { assert } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FIGURE_VIEW_MAX_SCALE,
  attachFigurePanZoom,
  inlineSvgNaturalSize,
  clampFigurePan,
  fitFigureScale,
  zoomFigureAround,
} from "../src/modules/contextPanel/figureViewer";
import { getWheelZoomScale } from "../src/modules/contextPanel/wheelZoom";

const figure = { width: 1400, height: 1900 };
const stage = { width: 900, height: 600 };

describe("figure viewer", function () {
  it("fits the whole figure inside the stage", function () {
    const scale = fitFigureScale(figure, stage, 16);
    assert.closeTo(scale, (600 - 32) / 1900, 1e-9);
    assert.isAtMost(figure.width * scale, stage.width);
  });

  it("never enlarges a small figure past actual size when fitting", function () {
    assert.equal(fitFigureScale({ width: 200, height: 100 }, stage), 1);
  });

  it("centres a figure smaller than the stage", function () {
    const view = clampFigurePan(
      { scale: 0.25, x: -500, y: 400 },
      figure,
      stage,
    );
    assert.equal(view.x, (900 - 350) / 2);
    assert.equal(view.y, (600 - 475) / 2);
  });

  it("keeps a large figure from leaving a gap at an edge", function () {
    const view = clampFigurePan({ scale: 1, x: 50, y: -5000 }, figure, stage);
    assert.equal(view.x, 0);
    assert.equal(view.y, 600 - 1900);
  });

  it("zooms around the pointer and stays within the limits", function () {
    const start = clampFigurePan({ scale: 0.5, x: 0, y: 0 }, figure, stage);
    const point = { x: 300, y: 200 };
    const zoomed = zoomFigureAround(start, 1, point, 0.3, figure, stage);
    // The figure point under the pointer is the same before and after.
    assert.closeTo(
      (point.x - start.x) / start.scale,
      (point.x - zoomed.x) / 1,
      1e-9,
    );
    assert.closeTo(
      (point.y - start.y) / start.scale,
      (point.y - zoomed.y) / 1,
      1e-9,
    );
    assert.equal(
      zoomFigureAround(start, 100, point, 0.3, figure, stage).scale,
      FIGURE_VIEW_MAX_SCALE,
    );
    assert.equal(
      zoomFigureAround(start, 0.01, point, 0.3, figure, stage).scale,
      0.3,
    );
  });

  it("zooms by the Mermaid window's wheel speed, capped per event", function () {
    assert.closeTo(getWheelZoomScale(1, -10), Math.exp(0.02), 1e-12);
    assert.closeTo(getWheelZoomScale(1, -500), Math.exp(0.048), 1e-12);
    assert.closeTo(getWheelZoomScale(1, 500), Math.exp(-0.048), 1e-12);
  });

  it("gives every viewer button an icon", function () {
    const css = readFileSync(
      join(__dirname, "../addon/content/zoteroPane.css"),
      "utf8",
    );
    for (const name of ["zoom-out", "zoom-in", "fit", "close"]) {
      assert.match(
        css,
        new RegExp(`\\.llm-figure-viewer-${name}::before \\{\\s*mask-image:`),
        name,
      );
    }
  });

  it("labels figure buttons on hover from their accessible name", function () {
    const css = readFileSync(
      join(__dirname, "../addon/content/zoteroPane.css"),
      "utf8",
    );
    assert.match(
      css,
      /\.llm-generated-image-action::after \{[^}]*content: attr\(aria-label\)/,
    );
  });

  it("pan-zooms a non-picture element from its natural size", function () {
    const listeners: Record<string, Array<() => void>> = {};
    const stageEl = {
      clientWidth: 400,
      clientHeight: 300,
      addEventListener: (name: string, fn: () => void) =>
        (listeners[name] ||= []).push(fn),
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 400,
        height: 300,
      }),
    };
    const classes = new Set<string>();
    const root = {
      classList: {
        toggle: (name: string, on: boolean) =>
          on ? classes.add(name) : classes.delete(name),
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
    };
    const svgEl = { style: {} as Record<string, string>, contains: () => true };
    const percent = { textContent: "" };
    let size: { width: number; height: number } | null = null;
    const zoom = attachFigurePanZoom({
      stage: stageEl as never,
      image: svgEl as never,
      naturalSize: () => size,
      stateRoot: root as never,
      percent: percent as never,
    });
    assert.equal(percent.textContent, "", "waits for a size");
    size = { width: 800, height: 600 };
    zoom.relayout();
    assert.equal(svgEl.style.width, "800px");
    assert.isBelow(zoom.scale(), 1);
    assert.equal(percent.textContent, `${Math.round(zoom.scale() * 100)}%`);
    zoom.zoomTo(1);
    assert.equal(percent.textContent, "100%");
    assert.isTrue(classes.has("llm-figure-viewer-zoomed"));
    zoom.fit();
    assert.isFalse(zoom.isZoomed());
  });

  it("reads an inline SVG's natural size from viewBox, then attributes", function () {
    const withBox = { viewBox: { baseVal: { width: 320, height: 200 } } };
    assert.deepEqual(inlineSvgNaturalSize(withBox as never), {
      width: 320,
      height: 200,
    });
    const attrs: Record<string, string> = { width: "640", height: "480" };
    const withAttrs = { getAttribute: (name: string) => attrs[name] ?? null };
    assert.deepEqual(inlineSvgNaturalSize(withAttrs as never), {
      width: 640,
      height: 480,
    });
    const none = { getAttribute: () => null };
    assert.deepEqual(inlineSvgNaturalSize(none as never), {
      width: 800,
      height: 600,
    });
  });
});
