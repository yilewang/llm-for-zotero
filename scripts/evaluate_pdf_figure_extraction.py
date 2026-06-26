#!/usr/bin/env python3
"""Development entrypoint for the packaged source-PDF figure extractor."""

from pathlib import Path
import runpy


PACKAGED_EXTRACTOR = (
    Path(__file__).resolve().parents[1] / "addon" / "scripts" / "pdf_figure_extract.py"
)


if __name__ == "__main__":
    runpy.run_path(str(PACKAGED_EXTRACTOR), run_name="__main__")
