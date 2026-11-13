import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image, ImageDraw


def load_extractor():
    script_path = (
        Path(__file__).resolve().parents[1]
        / "addon"
        / "scripts"
        / "pdf_figure_extract.py"
    )
    spec = importlib.util.spec_from_file_location("pdf_figure_extract", script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load extractor from {script_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["pdf_figure_extract"] = module
    spec.loader.exec_module(module)
    return module


class CaptionWindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.extractor = load_extractor()

    def text_box(self, left, top, width, height, text):
        return self.extractor.TextBox(
            self.extractor.Rect(left, top, width, height),
            text,
        )

    def test_evaluation_preserves_complete_caption_in_crop_metadata(self):
        caption = "Figure 1. " + "This source caption describes the experimental panels. " * 9 + "Final panel provenance."
        target = self.extractor.Target("Figure 1", 1, self.extractor.Rect(10, 80, 80, 10), caption, "pdf-text")
        candidate = self.extractor.Candidate("caption-region", self.extractor.Rect(10, 10, 80, 60), 0.99, (), ())
        pages = {1: {"width": 100, "height": 100, "texts": []}}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = self.extractor.PdfCase(7, "PDFKEY", "PAPERKEY", "paper.pdf", root / "paper.pdf", root / "mineru")
            with patch.object(self.extractor, "parse_pdf_xml", return_value=pages), patch.object(self.extractor, "build_case_targets", return_value=[target]), patch.object(self.extractor, "resolve_candidate_on_page", return_value=(candidate, None)), patch.object(self.extractor, "render_page", return_value=Image.new("RGB", (100, 100), "white")):
                result = self.extractor.evaluate_case(case, root / "output", root, 72)
            self.assertEqual(result["cropCount"], 1)
            self.assertEqual(result["figures"][0]["captionText"], caption)
            saved = json.loads((root / "output" / "7_PDFKEY" / "summary.json").read_text())
            self.assertEqual(saved["figures"][0]["captionText"], caption)

    def test_uuid_named_content_list_preserves_full_caption_over_manifest_excerpt(self):
        caption = "Fig. 1. " + "Panel details from the source. " * 20 + "Final caption sentence."
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "manifest.json").write_text(json.dumps({"allFigures": [{"label": "Figure 1", "page": 2, "caption": caption[:300]}]}))
            (root / "33ae8c62_content_list.json").write_text(json.dumps([{"type": "image", "page_idx": 2, "image_caption": [caption]}]))
            case = self.extractor.PdfCase(7, "PDFKEY", "PAPERKEY", "paper.pdf", root / "paper.pdf", root)
            targets = self.extractor.build_case_targets(case, {3: {"width": 100, "height": 100, "texts": []}}, use_mineru_semantics=True)
            self.assertEqual(len(targets), 1)
            self.assertEqual(targets[0].caption_text, caption)
            self.assertEqual(targets[0].page_number, 3)

    def image(self, boxes):
        image = Image.new("RGB", (820, 1180), "white")
        draw = ImageDraw.Draw(image)
        for left, top, right, bottom in boxes:
            draw.rectangle((left, top, right, bottom), fill="black")
        return image

    def two_column_text(self, left_top=584, right_top=390):
        return [
            *[
                self.text_box(
                    83,
                    left_top + index * 18,
                    351,
                    13,
                    "Left column body text that should define the left column.",
                )
                for index in range(8)
            ],
            *[
                self.text_box(
                    461,
                    right_top + index * 18,
                    351,
                    13,
                    "Right column body text that should define the right column.",
                )
                for index in range(8)
            ],
        ]

    def test_publisher_report_header_is_not_figure_evidence(self):
        page = {
            "width": 820.0, "height": 1180.0, "images": [],
            "texts": [self.text_box(146, 80, 11, 22, "ll"), self.text_box(700, 104, 71, 22, "Report"), self.text_box(142, 154, 10, 12, "A")],
        }
        target = self.extractor.Target("Figure 1", 3, self.extractor.Rect(142, 445, 630, 12), "Figure 1. Experimental design.", "pdf-text")
        image = self.image([(16, 66, 210, 113), (690, 72, 800, 126), (142, 154, 152, 166), (155, 175, 780, 430)])
        candidate = self.extractor.choose_caption_region_candidate(image, page, target, [target])
        self.assertIsNotNone(candidate)
        self.assertGreater(candidate.rect.top, 126, "The publisher header must be outside the crop")
        self.assertLessEqual(candidate.rect.top, 154, "The figure panel label must survive")
        self.assertGreater(candidate.rect.left, 125, "Header logos must not leave a wide empty margin")
        self.assertGreaterEqual(candidate.rect.right, 780)

    def test_cross_page_ink_crop_keeps_panel_and_axis_labels_without_masthead(self):
        page = {
            "width": 820.0, "height": 1180.0, "images": [],
            "texts": [self.text_box(80, 104, 71, 22, "Report"), self.text_box(749, 80, 11, 22, "ll"), self.text_box(155, 154, 10, 12, "A"), self.text_box(240, 1040, 90, 12, "Days difference")],
        }
        target = self.extractor.Target("Figure 3", 6, None, "Figure 3. Correlations.", "pdf-text")
        image = self.image([(690, 66, 819, 110), (200, 180, 760, 1030), (155, 154, 165, 166), (240, 1040, 330, 1052)])
        candidate = self.extractor.choose_ink_candidate(image, page, target)
        self.assertIsNotNone(candidate)
        self.assertGreater(candidate.rect.top, 126)
        self.assertLessEqual(candidate.rect.top, 154)
        self.assertLessEqual(candidate.rect.left, 155)
        self.assertGreaterEqual(candidate.rect.bottom, 1052)

    def test_ink_confidence_distinguishes_diagram_labels_from_body_paragraphs(self):
        target = self.extractor.Target("Figure 3", 6, None, "Figure 3.", "pdf-text")
        page = {"width": 200, "height": 200, "texts": [self.text_box(20, 20, 25, 20, "Time")]}
        rect = self.extractor.Rect(10, 10, 100, 100)
        figure = self.extractor.score_candidate("rendered-ink", rect, 2, [], page, target)
        self.assertNotIn("substantial non-caption text overlap", figure.warnings)
        page["texts"] = [self.text_box(20, 20, 90, 10, "This is a long paragraph of body text from the paper.")]
        paragraph = self.extractor.score_candidate("rendered-ink", rect, 2, [], page, target)
        self.assertIn("paragraph-like text overlap", paragraph.warnings)
        self.assertLess(paragraph.confidence, figure.confidence)

    def test_column_region_rescues_weak_full_width_candidate(self):
        page = {
            "width": 820.0,
            "height": 1180.0,
            "texts": [
                self.text_box(
                    248,
                    72,
                    399,
                    12,
                    "Two Routes to Scalable Credit Assignment without Weight Symmetry",
                ),
                *self.two_column_text(right_top=180),
            ],
        }
        target = self.extractor.Target(
            label="Figure 3",
            page_number=7,
            caption_box=self.extractor.Rect(82, 404, 49, 12),
            caption_text="Figure 3. Performance of local and non-local rules.",
            source="pdf-text",
        )

        candidate = self.extractor.choose_caption_region_candidate(
            self.image([(90, 110, 430, 380), (470, 110, 810, 280)]),
            page,
            target,
            [target],
        )

        self.assertIsNotNone(candidate)
        self.assertGreater(candidate.confidence, 0.8)
        self.assertLessEqual(candidate.rect.right, 455)

    def test_confident_full_width_region_is_not_narrowed_to_text_column(self):
        page = {
            "width": 820.0,
            "height": 1180.0,
            "texts": [
                *self.two_column_text(left_top=760, right_top=760),
            ],
        }
        target = self.extractor.Target(
            label="Figure 3",
            page_number=5,
            caption_box=self.extractor.Rect(56, 700, 360, 12),
            caption_text="Figure 3. Dynamic and selective engrams encode memory.",
            source="pdf-text",
        )

        candidate = self.extractor.choose_caption_region_candidate(
            self.image([(56, 90, 790, 680)]),
            page,
            target,
            [target],
        )

        self.assertIsNotNone(candidate)
        self.assertGreater(candidate.confidence, 0.9)
        self.assertGreater(candidate.rect.width, 700)

    def test_caption_region_ignores_vertical_page_margin_furniture(self):
        margin_text = [
            self.text_box(800, 100 + index * 24, 0, 15, "journal margin")
            for index in range(12)
        ]
        page = {
            "width": 820.0,
            "height": 1180.0,
            "texts": margin_text,
        }
        target = self.extractor.Target(
            label="Figure 1",
            page_number=3,
            caption_box=self.extractor.Rect(80, 700, 500, 12),
            caption_text="Figure 1. Full-width figure above the caption.",
            source="pdf-text",
        )
        image = self.image(
            [
                (80, 90, 700, 680),
                *[
                    (792, 100 + index * 24, 810, 115 + index * 24)
                    for index in range(12)
                ],
            ]
        )

        candidate = self.extractor.choose_caption_region_candidate(
            image,
            page,
            target,
            [target],
        )

        self.assertIsNotNone(candidate)
        self.assertLessEqual(candidate.rect.right, 710)

    def test_caption_region_keeps_axis_labels_at_page_edges(self):
        # Clark et al. 2025, Fig. 2: the last time tick ("90") starts inside
        # the right-edge margin band, next to "80"; the y-axis labels mirror it.
        tick_row = [
            self.text_box(470 + index * 30, 650, 10, 11, str(index * 10))
            for index in range(11)
        ]
        y_labels = [
            self.text_box(30, 120, 10, 11, "2π"),
            self.text_box(48, 120, 10, 11, "θ"),
        ]
        page = {
            "width": 820.0,
            "height": 1180.0,
            "texts": [*tick_row, *y_labels],
        }
        target = self.extractor.Target(
            label="Figure 2",
            page_number=4,
            caption_box=self.extractor.Rect(80, 700, 500, 12),
            caption_text="Figure 2. Full-width figure above the caption.",
            source="pdf-text",
        )
        image = self.image(
            [
                (30, 90, 785, 640),
                *[(470 + index * 30, 650, 480 + index * 30, 661) for index in range(11)],
            ]
        )

        candidate = self.extractor.choose_caption_region_candidate(
            image,
            page,
            target,
            [target],
        )

        self.assertIsNotNone(candidate)
        self.assertGreaterEqual(candidate.rect.right, 780)
        self.assertLessEqual(candidate.rect.left, 32)

    def test_crop_margin_preserves_sparse_panel_labels(self):
        self.assertEqual(self.extractor.figure_crop_margin_pixels(216), 13)
        self.assertEqual(self.extractor.figure_crop_margin_pixels(72), 4)

    def test_adjacent_same_page_figures_use_detected_columns(self):
        page = {
            "width": 820.0,
            "height": 1180.0,
            "texts": [
                *self.two_column_text(left_top=720, right_top=720),
            ],
        }
        figure4 = self.extractor.Target(
            label="Figure 4",
            page_number=8,
            caption_box=self.extractor.Rect(82, 547, 49, 12),
            caption_text="Figure 4. Weight estimation.",
            source="pdf-text",
        )
        figure5 = self.extractor.Target(
            label="Figure 5",
            page_number=8,
            caption_box=self.extractor.Rect(460, 606, 49, 12),
            caption_text="Figure 5. Symmetric Alignment is robust.",
            source="pdf-text",
        )
        image = self.image([(90, 90, 436, 520), (461, 90, 815, 590)])

        candidate4 = self.extractor.choose_caption_region_candidate(
            image,
            page,
            figure4,
            [figure4, figure5],
        )
        candidate5 = self.extractor.choose_caption_region_candidate(
            image,
            page,
            figure5,
            [figure4, figure5],
        )

        self.assertIsNotNone(candidate4)
        self.assertIsNotNone(candidate5)
        self.assertLessEqual(candidate4.rect.right, 455)
        self.assertGreaterEqual(candidate4.rect.width, 320)
        self.assertGreaterEqual(candidate5.rect.left, 445)

    def test_mineru_semantics_ignore_all_mineru_visual_geometry(self):
        with tempfile.TemporaryDirectory() as tmp:
            mineru_dir = Path(tmp)
            (mineru_dir / "manifest.json").write_text(
                json.dumps(
                    {
                        "allFigures": [
                            {
                                "label": "Figure 1",
                                "page": 0,
                                "caption": "Figure 1. Semantic caption from MinerU.",
                                "pdfCropRange": [10, 10, 800, 900],
                            },
                        ],
                    },
                ),
            )
            (mineru_dir / "content_list.json").write_text(
                json.dumps(
                    [
                        {
                            "type": "image",
                            "page_idx": 0,
                            "bbox": [20, 30, 780, 880],
                            "img_path": "images/bogus.png",
                            "image_caption": [
                                "Figure 1. Longer semantic caption from MinerU content."
                            ],
                        },
                    ],
                ),
            )
            page = {
                "width": 820.0,
                "height": 1180.0,
                "texts": [],
                "images": [],
            }
            case = self.extractor.PdfCase(
                attachment_id=1,
                attachment_key="test",
                parent_item_key="",
                source_filename="paper.pdf",
                pdf_path=mineru_dir / "paper.pdf",
                mineru_dir=mineru_dir,
            )

            targets = self.extractor.build_case_targets(
                case,
                {1: page},
                use_mineru_semantics=True,
            )

            self.assertEqual(len(targets), 1)
            self.assertIn("mineru-manifest", targets[0].source)
            self.assertIn("mineru-caption", targets[0].source)
            self.assertEqual(targets[0].page_number, 1)
            self.assertIn("Longer semantic caption", targets[0].caption_text)
            self.assertFalse(hasattr(targets[0], "visual_box"))
            self.assertFalse(hasattr(targets[0], "visual_aspect_ratio"))

    def test_direct_mode_accepts_pdf_without_mineru_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf_path = root / "paper.pdf"
            pdf_path.write_bytes(b"%PDF-1.7\n")
            json_out = root / "figures.json"
            original_evaluate_case = self.extractor.evaluate_case
            self.extractor.evaluate_case = lambda *args, **kwargs: None
            try:
                exit_code = self.extractor.run_direct_mode(
                    SimpleNamespace(
                        pdf=str(pdf_path),
                        mineru_dir=None,
                        out=str(root / "work"),
                        clean_out=True,
                        attachment_id="22",
                        attachment_key="",
                        source_filename="paper.pdf",
                        poppler_bin="/tmp/poppler",
                        dpi=216,
                        json_out=str(json_out),
                        pages="",
                        selection=json.dumps({"labels": ["Figure 1"], "kind": "figures", "includeSupplementary": False}),
                        crop_dir=str(root / "crops"),
                    )
                )
            finally:
                self.extractor.evaluate_case = original_evaluate_case

            self.assertEqual(exit_code, 0)
            payload = json.loads(json_out.read_text())
            self.assertEqual(payload["status"], "no_figures")
            self.assertIsNone(payload.get("mineruDir"))
            self.assertIn("PDF text", payload["warnings"][0])

    def test_run_uses_platform_path_separator_for_poppler_bin(self):
        original_run = self.extractor.subprocess.run
        original_pathsep = self.extractor.os.pathsep
        captured = {}

        class FakeProcess:
            stdout = "ok"

        def fake_run(*args, **kwargs):
            captured["env"] = kwargs.get("env", {})
            return FakeProcess()

        try:
            self.extractor.subprocess.run = fake_run
            self.extractor.os.pathsep = ";"

            self.extractor.run(
                ["pdfinfo", "paper.pdf"],
                poppler_bin=Path("C:/runtime/Library/bin"),
            )

            path = captured["env"]["PATH"]
            self.assertTrue(path.startswith("C:/runtime/Library/bin;"))
            self.assertFalse(path.startswith("C:/runtime/Library/bin:"))
        finally:
            self.extractor.subprocess.run = original_run
            self.extractor.os.pathsep = original_pathsep

    def test_selection_requires_explicit_scope_and_never_interprets_label_prose(self):
        for raw in ("{}", '{"labels":[]}'):
            with self.assertRaises(ValueError):
                self.extractor.decode_figure_selection(raw)
        selection = self.extractor.decode_figure_selection(json.dumps({"labels": ["all figures except Figure 1"], "kind": "figures", "includeSupplementary": False}))
        self.assertFalse(self.extractor.direct_entry_matches_request({"label": "Figure 2"}, selection=selection, pages=set()))

    def test_table_selection_does_not_match_every_figure(self):
        figure = {
            "label": "Figure 1",
            "pageNumber": 1,
            "captionPageNumber": 1,
            "cropPath": "/tmp/figure-1.png",
        }

        self.assertFalse(
            self.extractor.direct_entry_matches_request(
                figure,
                selection={"labels": ["Table 1"], "kind": "tables", "includeSupplementary": False},
                pages=set(),
            )
        )

    def test_render_page_reports_missing_pdftoppm_png(self):
        original_run = self.extractor.run

        try:
            self.extractor.run = lambda *args, **kwargs: None

            with self.assertRaisesRegex(RuntimeError, "did not produce a PNG"):
                self.extractor.render_page(
                    Path("/tmp/nonexistent.pdf"),
                    1,
                    144,
                    Path("/tmp/poppler"),
                )
        finally:
            self.extractor.run = original_run

    def test_direct_mode_writes_json_error_for_extraction_failure(self):
        original_evaluate_case = self.extractor.evaluate_case

        def fail_evaluate_case(*args, **kwargs):
            raise RuntimeError("render failed for page 99")

        try:
            self.extractor.evaluate_case = fail_evaluate_case
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                pdf_path = root / "paper.pdf"
                mineru_dir = root / "mineru"
                out_dir = root / "out"
                crop_dir = root / "crops"
                json_out = root / "figures.json"
                pdf_path.write_bytes(b"%PDF-1.7\n")
                mineru_dir.mkdir()
                crop_dir.mkdir()
                args = self.extractor.argparse.Namespace(
                    pdf=str(pdf_path),
                    mineru_dir=str(mineru_dir),
                    out=str(out_dir),
                    clean_out=False,
                    attachment_id=7,
                    attachment_key="PDFKEY",
                    source_filename="paper.pdf",
                    poppler_bin=str(root / "poppler"),
                    dpi=144,
                    pages="",
                    selection=json.dumps({"labels": ["Figure 1"], "kind": "figures", "includeSupplementary": False}),
                    crop_dir=str(crop_dir),
                    json_out=str(json_out),
                )

                with redirect_stdout(io.StringIO()):
                    exit_code = self.extractor.run_direct_mode(args)

                self.assertEqual(exit_code, 0)
                payload = json.loads(json_out.read_text())
                self.assertEqual(payload["status"], "error")
                self.assertEqual(payload["figures"], [])
                self.assertEqual(payload["expectedFigures"], [])
                self.assertEqual(payload["missingFigures"], [])
                self.assertIn("render failed for page 99", payload["warnings"][0])
        finally:
            self.extractor.evaluate_case = original_evaluate_case


if __name__ == "__main__":
    unittest.main()
