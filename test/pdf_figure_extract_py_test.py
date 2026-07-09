import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace

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

    def test_default_targets_ignore_mineru_visual_geometry(self):
        with tempfile.TemporaryDirectory() as tmp:
            mineru_dir = Path(tmp)
            (mineru_dir / "manifest.json").write_text(
                json.dumps(
                    {
                        "allFigures": [
                            {
                                "label": "Figure 1",
                                "page": 9,
                                "caption": "Figure 1. Bogus MinerU target.",
                                "pdfCropBox": [10, 10, 20, 20],
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
                            "page_idx": 8,
                            "bbox": [10, 10, 20, 20],
                            "image_path": "images/bogus.png",
                            "img_caption": ["Figure 1. Bogus MinerU target."],
                        },
                    ],
                ),
            )
            page = {
                "width": 820.0,
                "height": 1180.0,
                "texts": [
                    self.text_box(
                        82,
                        547,
                        320,
                        12,
                        "Figure 1. PDF caption should be the crop target.",
                    ),
                ],
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
                use_mineru_targets=False,
            )

            self.assertEqual(len(targets), 1)
            self.assertEqual(targets[0].source, "pdf-text")
            self.assertEqual(targets[0].page_number, 1)
            self.assertIsNone(targets[0].visual_box)

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
                        use_mineru_targets=False,
                        json_out=str(json_out),
                        pages="",
                        query="Figure 1",
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

    def test_table_query_does_not_match_every_figure(self):
        figure = {
            "label": "Figure 1",
            "pageNumber": 1,
            "captionPageNumber": 1,
            "cropPath": "/tmp/figure-1.png",
        }

        self.assertFalse(
            self.extractor.direct_entry_matches_request(
                figure,
                query="What does Table 1 show?",
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
                    use_mineru_targets=True,
                    pages="",
                    query="Figure 1",
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
