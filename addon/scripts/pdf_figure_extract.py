#!/usr/bin/env python3
"""Extract PDF-native figure crops from one Zotero/MinerU-ready PDF.

This file is intentionally based on scripts/evaluate_pdf_figure_extraction.py.
Keep the extraction algorithm in this packaged script aligned with the
development evaluator; the plugin calls this script for production figure crops.
"""

from __future__ import annotations

import argparse
import html
import json
import math
import os
import random
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MINERU_ROOT = Path("/Users/yat-lok/Zotero/llm-for-zotero-mineru")
DEFAULT_ZOTERO_STORAGE = Path("/Users/yat-lok/Zotero/storage")
DEFAULT_OUT = REPO_ROOT / "tmp/pdfs/figure_extraction_eval"
DEFAULT_POPPLER_BIN = Path(
    "/Users/yat-lok/.cache/codex-runtimes/"
    "codex-primary-runtime/dependencies/bin"
)
MIN_ACCEPTED_CONFIDENCE = 0.40
DEFAULT_COMMAND_TIMEOUT_SECONDS = 120
DIRECT_EXTRACTOR_VERSION = "raw-pdf-evaluator-v3"

CAPTION_PATTERN = re.compile(
    r"^\s*((?:Extended\s+Data\s+)?Fig(?:ure)?\.?\s*S?\d+[A-Za-z]?|"
    r"Supplementary\s+Fig(?:ure)?\.?\s*S?\d+[A-Za-z]?|"
    r"Figure\s+S?\d+[A-Za-z]?)\s*(?:\.|:|\||$)",
    re.I,
)


@dataclass(frozen=True)
class Rect:
    left: float
    top: float
    width: float
    height: float

    @property
    def right(self) -> float:
        return self.left + self.width

    @property
    def bottom(self) -> float:
        return self.top + self.height

    @property
    def area(self) -> float:
        return max(0.0, self.width) * max(0.0, self.height)

    def to_json(self) -> dict[str, float]:
        return {
            "left": round(self.left, 3),
            "top": round(self.top, 3),
            "width": round(self.width, 3),
            "height": round(self.height, 3),
        }


@dataclass(frozen=True)
class TextBox:
    rect: Rect
    text: str


@dataclass(frozen=True)
class Target:
    label: str
    page_number: int
    caption_box: Rect | None
    caption_text: str
    source: str
    visual_box: Rect | None = None
    visual_aspect_ratio: float | None = None


@dataclass(frozen=True)
class Candidate:
    source: str
    rect: Rect
    confidence: float
    reasons: tuple[str, ...]
    warnings: tuple[str, ...]


def candidate_with_adjusted_score(
    candidate: Candidate,
    *,
    delta: float,
    reason: str,
    warning: str | None = None,
) -> Candidate:
    warnings = list(candidate.warnings)
    if warning:
        warnings.append(warning)
    return Candidate(
        candidate.source,
        candidate.rect,
        max(0.0, min(1.0, candidate.confidence + delta)),
        (*candidate.reasons, reason),
        tuple(warnings),
    )


def label_namespace(label: str) -> str:
    normalized = normalize_label(label)
    if re.match(r"(?i)^Extended Data Figure\s+\d+", normalized):
        return "extended-data"
    if re.match(r"(?i)^Supplementary Figure\s+", normalized):
        return "supplementary"
    if re.match(r"(?i)^Figure\s+S\d+", normalized):
        return "supplementary"
    return "main"


def query_requests_extended_or_supplementary(query: str) -> bool:
    return bool(
        re.search(r"\bextended\s+data\b", query or "", re.I)
        or re.search(r"\bsupp(?:lementary|lemental)?\b", query or "", re.I)
        or re.search(r"(?i)\bfig(?:ure)?\.?\s*S\d+\b", query or "")
    )


def label_allowed_for_all_query(label: str, query: str) -> bool:
    namespace = label_namespace(label)
    if namespace == "main":
        return True
    return query_requests_extended_or_supplementary(query)


@dataclass
class PdfCase:
    attachment_id: int
    attachment_key: str
    parent_item_key: str
    source_filename: str
    pdf_path: Path
    mineru_dir: Path


def run(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    poppler_bin: Path,
    timeout: int = DEFAULT_COMMAND_TIMEOUT_SECONDS,
) -> str:
    env = os.environ.copy()
    env["PATH"] = f"{poppler_bin}{os.pathsep}{env.get('PATH', '')}"
    proc = subprocess.run(
        cmd,
        cwd=str(cwd or REPO_ROOT),
        env=env,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    return proc.stdout


def pdf_page_count(pdf_path: Path, poppler_bin: Path) -> int | None:
    try:
        output = run(["pdfinfo", str(pdf_path)], poppler_bin=poppler_bin, timeout=30)
    except Exception:
        return None
    match = re.search(r"^Pages:\s+(\d+)\s*$", output, re.M)
    return int(match.group(1)) if match else None


def rect_union(rects: list[Rect]) -> Rect:
    left = min(rect.left for rect in rects)
    top = min(rect.top for rect in rects)
    right = max(rect.right for rect in rects)
    bottom = max(rect.bottom for rect in rects)
    return Rect(left, top, right - left, bottom - top)


def intersect_area(left: Rect, right: Rect) -> float:
    x1 = max(left.left, right.left)
    y1 = max(left.top, right.top)
    x2 = min(left.right, right.right)
    y2 = min(left.bottom, right.bottom)
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def horizontal_overlap_ratio(left: Rect, right: Rect) -> float:
    overlap = min(left.right, right.right) - max(left.left, right.left)
    return max(0.0, overlap) / max(1.0, min(left.width, right.width))


def vertical_gap(left: Rect, right: Rect) -> float:
    if left.bottom < right.top:
        return right.top - left.bottom
    if right.bottom < left.top:
        return left.top - right.bottom
    return 0.0


def normalize_label(raw: str) -> str:
    text = re.sub(r"\s+", " ", raw.strip())
    text = re.sub(r"(?i)\bfig(?:ure)?\.?\s*", "Figure ", text)
    text = re.sub(r"(?i)^extended data figure", "Extended Data Figure", text)
    text = re.sub(r"(?i)^supplementary figure", "Supplementary Figure", text)
    match = re.match(
        r"(?i)^(Extended Data |Supplementary )?Figure\s+(S?\d+)[A-Za-z]?",
        text,
    )
    if not match:
        return text
    prefix = match.group(1) or ""
    return f"{prefix}Figure {match.group(2).upper()}".strip()


def caption_label(text: str) -> str:
    match = CAPTION_PATTERN.match(text)
    return normalize_label(match.group(1)) if match else ""


def normalize_manifest_label(raw: str) -> str:
    text = re.sub(r"\s+", " ", raw.strip())
    match = re.match(r"(?i)^fig(?:ure)?[-_\s]*(S?\d+)[A-Za-z]?$", text)
    if match:
        return f"Figure {match.group(1).upper()}"
    return normalize_label(text)


def strip_namespace(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_attrs(raw: str) -> dict[str, str]:
    return dict(re.findall(r'([A-Za-z_:][\w:.-]*)="([^"]*)"', raw))


def parse_pdf_xml_loose(xml_text: str) -> dict[int, dict[str, Any]]:
    pages: dict[int, dict[str, Any]] = {}
    page_pattern = re.compile(r"<page\b([^>]*)>(.*?)</page>", re.S)
    text_pattern = re.compile(r"<text\b([^>]*)>(.*?)</text>", re.S)
    image_pattern = re.compile(r"<image\b([^>]*)/>", re.S)
    for page_match in page_pattern.finditer(xml_text):
        page_attrs = parse_attrs(page_match.group(1))
        try:
            number = int(page_attrs["number"])
            page = {
                "number": number,
                "width": float(page_attrs["width"]),
                "height": float(page_attrs["height"]),
                "texts": [],
                "images": [],
            }
        except (KeyError, ValueError):
            continue
        body = page_match.group(2)
        for text_match in text_pattern.finditer(body):
            attrs = parse_attrs(text_match.group(1))
            raw_text = re.sub(r"<[^>]+>", "", text_match.group(2))
            text = html.unescape(raw_text)
            text = re.sub(r"\s+", " ", text).strip()
            if not text:
                continue
            try:
                page["texts"].append(
                    TextBox(
                        Rect(
                            float(attrs.get("left", 0)),
                            float(attrs.get("top", 0)),
                            float(attrs.get("width", 0)),
                            float(attrs.get("height", 0)),
                        ),
                        text,
                    ),
                )
            except ValueError:
                continue
        for image_match in image_pattern.finditer(body):
            attrs = parse_attrs(image_match.group(1))
            try:
                page["images"].append(
                    Rect(
                        float(attrs.get("left", 0)),
                        float(attrs.get("top", 0)),
                        float(attrs.get("width", 0)),
                        float(attrs.get("height", 0)),
                    ),
                )
            except ValueError:
                continue
        pages[number] = page
    return pages


def parse_pdf_xml(pdf_path: Path, poppler_bin: Path) -> dict[int, dict[str, Any]]:
    with tempfile.TemporaryDirectory(prefix="figure-geometry-xml-") as tmp_name:
        tmp = Path(tmp_name)
        run(
            ["pdftohtml", "-xml", "-hidden", str(pdf_path), "out"],
            cwd=tmp,
            poppler_bin=poppler_bin,
        )
        xml_path = tmp / "out.xml"
        xml_text = xml_path.read_text(errors="replace")
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError:
            return parse_pdf_xml_loose(xml_text)
        pages: dict[int, dict[str, Any]] = {}
        for page_el in root:
            if strip_namespace(page_el.tag) != "page":
                continue
            number = int(page_el.attrib["number"])
            page = {
                "number": number,
                "width": float(page_el.attrib["width"]),
                "height": float(page_el.attrib["height"]),
                "texts": [],
                "images": [],
            }
            for child in page_el:
                tag = strip_namespace(child.tag)
                attrs = child.attrib
                if tag == "text":
                    text = html.unescape("".join(child.itertext()))
                    text = re.sub(r"\s+", " ", text).strip()
                    if not text:
                        continue
                    page["texts"].append(
                        TextBox(
                            Rect(
                                float(attrs.get("left", 0)),
                                float(attrs.get("top", 0)),
                                float(attrs.get("width", 0)),
                                float(attrs.get("height", 0)),
                            ),
                            text,
                        ),
                    )
                elif tag == "image":
                    page["images"].append(
                        Rect(
                            float(attrs.get("left", 0)),
                            float(attrs.get("top", 0)),
                            float(attrs.get("width", 0)),
                            float(attrs.get("height", 0)),
                        ),
                    )
            pages[number] = page
        return pages


def load_cases(
    mineru_root: Path,
    zotero_storage: Path,
) -> list[PdfCase]:
    cases: list[PdfCase] = []
    for source_path in sorted(mineru_root.glob("*/_llm_source.json")):
        try:
            data = json.loads(source_path.read_text())
        except Exception:
            continue
        key = str(data.get("attachmentKey") or "").strip()
        filename = str(data.get("sourceFilename") or "").strip()
        attachment_id = int(data.get("attachmentId") or source_path.parent.name)
        if not key or not filename:
            continue
        pdf_path = zotero_storage / key / filename
        if not pdf_path.exists():
            continue
        cases.append(
            PdfCase(
                attachment_id=attachment_id,
                attachment_key=key,
                parent_item_key=str(data.get("parentItemKey") or ""),
                source_filename=filename,
                pdf_path=pdf_path,
                mineru_dir=source_path.parent,
            ),
        )
    return cases


def load_storage_pdf_cases(
    zotero_storage: Path,
    existing_cases: list[PdfCase],
    mineru_root: Path,
) -> list[PdfCase]:
    existing_paths = {case.pdf_path.resolve() for case in existing_cases}
    cases: list[PdfCase] = []
    for pdf_path in sorted(zotero_storage.glob("*/*.pdf")):
        resolved = pdf_path.resolve()
        if resolved in existing_paths:
            continue
        attachment_key = pdf_path.parent.name
        stable_id = 900000 + zlib.crc32(str(resolved).encode("utf-8")) % 100000
        cases.append(
            PdfCase(
                attachment_id=stable_id,
                attachment_key=attachment_key,
                parent_item_key="",
                source_filename=pdf_path.name,
                pdf_path=pdf_path,
                mineru_dir=mineru_root / f"storage-only-{attachment_key}",
            ),
        )
    return cases


def targets_from_pdf_text(pages: dict[int, dict[str, Any]]) -> list[Target]:
    targets: list[Target] = []
    seen: set[tuple[str, int]] = set()
    for page_number, page in pages.items():
        for text_box in page["texts"]:
            caption_text = merged_caption_line(text_box, page)
            label = caption_label(caption_text)
            if not label:
                continue
            key = (label, page_number)
            if key in seen:
                continue
            seen.add(key)
            targets.append(
                Target(
                    label=label,
                    page_number=page_number,
                    caption_box=text_box.rect,
                    caption_text=caption_text,
                    source="pdf-text",
                ),
            )
    return targets


def merged_caption_line(text_box: TextBox, page: dict[str, Any]) -> str:
    label = caption_label(text_box.text)
    if not label:
        return text_box.text
    center_y = text_box.rect.top + text_box.rect.height / 2
    same_line: list[TextBox] = []
    for other in page["texts"]:
        if other is text_box or other.rect.left < text_box.rect.right - 2:
            continue
        other_center_y = other.rect.top + other.rect.height / 2
        if abs(other_center_y - center_y) > max(6.0, text_box.rect.height * 0.75):
            continue
        if other.rect.left - text_box.rect.right > page["width"] * 0.08:
            continue
        same_line.append(other)
    if not same_line:
        return text_box.text
    parts = [text_box.text]
    current_right = text_box.rect.right
    for other in sorted(same_line, key=lambda box: box.rect.left):
        if other.rect.left - current_right > page["width"] * 0.08:
            break
        parts.append(other.text)
        current_right = max(current_right, other.rect.right)
        if len(" ".join(parts)) >= 800:
            break
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


def mineru_entry_captions(entry: dict[str, Any]) -> list[str]:
    captions: list[str] = []
    if isinstance(entry.get("image_caption"), list):
        captions.extend(str(caption) for caption in entry["image_caption"])
    if isinstance(entry.get("table_caption"), list):
        captions.extend(str(caption) for caption in entry["table_caption"])
    return captions


def mineru_entry_rect(entry: dict[str, Any]) -> Rect | None:
    bbox = entry.get("bbox")
    if (
        not isinstance(bbox, list)
        or len(bbox) != 4
        or not all(isinstance(value, (int, float)) for value in bbox)
    ):
        return None
    left, top, right, bottom = [float(value) for value in bbox]
    if right <= left or bottom <= top:
        return None
    return Rect(left, top, right - left, bottom - top)


def mineru_image_aspect_ratio(case: PdfCase, entry: dict[str, Any]) -> float | None:
    img_path = entry.get("img_path")
    if not isinstance(img_path, str) or not img_path:
        return None
    try:
        with Image.open(case.mineru_dir / img_path) as image:
            width, height = image.size
        if width > 0 and height > 0:
            return width / height
    except Exception:
        return None
    return None


def manifest_crop_rect(entry: dict[str, Any]) -> Rect | None:
    raw = entry.get("pdfCropRange")
    if (
        not isinstance(raw, list)
        or len(raw) != 4
        or not all(isinstance(value, (int, float)) for value in raw)
    ):
        return None
    left, top, right, bottom = [float(value) for value in raw]
    if right <= left or bottom <= top:
        return None
    return Rect(left, top, right - left, bottom - top)


def manifest_page_number(entry: dict[str, Any]) -> int | None:
    for key in ("pdfCropPage", "page"):
        value = entry.get(key)
        if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0:
            return int(value) + 1
    return None


def manifest_figure_label(entry: dict[str, Any]) -> str:
    caption = entry.get("caption")
    if isinstance(caption, str):
        label = caption_label(caption)
        if label:
            return label
    for key in ("label", "baseLabel"):
        value = entry.get(key)
        if not isinstance(value, str) or not value.strip():
            continue
        label = normalize_manifest_label(value)
        if re.match(r"(?i)^(?:Extended Data |Supplementary )?Figure\s+S?\d+", label):
            return label
    return ""


def manifest_figure_entries(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for section in manifest.get("sections") or []:
        if not isinstance(section, dict):
            continue
        for figure in section.get("figures") or []:
            if isinstance(figure, dict):
                entries.append(figure)
    for figure in manifest.get("allFigures") or []:
        if isinstance(figure, dict):
            entries.append(figure)
    return entries


def targets_from_manifest(case: PdfCase) -> list[Target]:
    manifest_path = case.mineru_dir / "manifest.json"
    if not manifest_path.exists():
        return []
    try:
        manifest = json.loads(manifest_path.read_text())
    except Exception:
        return []
    if not isinstance(manifest, dict):
        return []
    targets: list[Target] = []
    seen: set[tuple[str, int, tuple[float, float, float, float] | None]] = set()
    for entry in manifest_figure_entries(manifest):
        label = manifest_figure_label(entry)
        page_number = manifest_page_number(entry)
        if not label or not page_number:
            continue
        visual_box = manifest_crop_rect(entry)
        caption = entry.get("caption")
        caption_text = str(caption) if isinstance(caption, str) else label
        rect_key = (
            (
                round(visual_box.left, 3),
                round(visual_box.top, 3),
                round(visual_box.right, 3),
                round(visual_box.bottom, 3),
            )
            if visual_box
            else None
        )
        key = (label, page_number, rect_key)
        if key in seen:
            continue
        seen.add(key)
        targets.append(
            Target(
                label=label,
                page_number=page_number,
                caption_box=None,
                caption_text=caption_text,
                source="mineru-manifest",
                visual_box=visual_box,
                visual_aspect_ratio=(
                    visual_box.width / visual_box.height
                    if visual_box and visual_box.height > 0
                    else None
                ),
            ),
        )
    return targets


def horizontal_gap(left: Rect, right: Rect) -> float:
    if left.right < right.left:
        return right.left - left.right
    if right.right < left.left:
        return left.left - right.right
    return 0.0


def expand_mineru_compound_visual_box(
    seed: Rect,
    page_idx: int,
    label: str,
    visual_entries: list[dict[str, Any]],
) -> tuple[Rect, int]:
    group = [seed]
    changed = True
    while changed:
        changed = False
        group_box = rect_union(group)
        for item in visual_entries:
            rect = item["rect"]
            if item["page_idx"] != page_idx or rect in group:
                continue
            labels = item["labels"]
            if labels and any(item_label != label for item_label in labels):
                continue
            overlap = min(group_box.bottom, rect.bottom) - max(group_box.top, rect.top)
            vertical_overlap = max(0.0, overlap) / max(
                1.0,
                min(group_box.height, rect.height),
            )
            vgap = vertical_gap(group_box, rect)
            hgap = horizontal_gap(group_box, rect)
            close_vertically = (
                vertical_overlap >= 0.22
                or vgap <= max(18.0, min(group_box.height, rect.height) * 0.35)
            )
            close_horizontally = hgap <= max(
                90.0,
                min(group_box.width, rect.width) * 0.65,
            )
            if close_vertically and close_horizontally:
                group.append(rect)
                changed = True
    return rect_union(group), len(group)


def targets_from_mineru(case: PdfCase) -> list[Target]:
    content_path = case.mineru_dir / "content_list.json"
    if not content_path.exists():
        return []
    try:
        content = json.loads(content_path.read_text())
    except Exception:
        return []
    visual_entries: list[dict[str, Any]] = []
    for entry in content:
        if entry.get("type") not in {"image", "table"}:
            continue
        page_idx = entry.get("page_idx")
        rect = mineru_entry_rect(entry)
        if page_idx is None or rect is None:
            continue
        labels = {
            label
            for label in (caption_label(caption) for caption in mineru_entry_captions(entry))
            if label
        }
        visual_entries.append(
            {
                "page_idx": int(page_idx),
                "rect": rect,
                "labels": labels,
            },
        )
    targets: list[Target] = []
    seen: set[tuple[str, int]] = set()
    for entry in content:
        captions = mineru_entry_captions(entry)
        visual_box = mineru_entry_rect(entry)
        visual_aspect_ratio = mineru_image_aspect_ratio(case, entry)
        for caption in captions:
            label = caption_label(str(caption))
            page_idx = entry.get("page_idx")
            if not label or page_idx is None:
                continue
            page_number = int(page_idx) + 1
            compound_count = 1
            if visual_box:
                visual_box, compound_count = expand_mineru_compound_visual_box(
                    visual_box,
                    int(page_idx),
                    label,
                    visual_entries,
                )
                if compound_count > 1:
                    visual_aspect_ratio = visual_box.width / max(1.0, visual_box.height)
            key = (label, page_number)
            if key in seen:
                continue
            seen.add(key)
            targets.append(
                Target(
                    label=label,
                    page_number=page_number,
                    caption_box=None,
                    caption_text=str(caption),
                    source="mineru-caption",
                    visual_box=visual_box,
                    visual_aspect_ratio=visual_aspect_ratio,
                ),
            )
    return targets


def merge_targets(
    pdf_targets: list[Target],
    mineru_targets: list[Target],
    pages: dict[int, dict[str, Any]],
) -> list[Target]:
    by_label: dict[str, Target] = {}
    for target in pdf_targets + mineru_targets:
        existing = by_label.get(target.label)
        if not existing:
            by_label[target.label] = target
            continue
        page_number = existing.page_number
        if target.visual_box and not existing.visual_box:
            page_number = target.page_number
        elif (
            target.source == "mineru-manifest"
            and existing.source != "mineru-manifest"
        ):
            page_number = target.page_number
        caption_text = existing.caption_text
        if len(target.caption_text) > len(caption_text):
            caption_text = target.caption_text
        sources = []
        for source in (existing.source, target.source):
            for part in source.split("+"):
                if part not in sources:
                    sources.append(part)
        caption_box = (
            existing.caption_box if existing.page_number == page_number else None
        )
        if not caption_box and target.caption_box and target.page_number == page_number:
            caption_box = target.caption_box
        by_label[target.label] = Target(
            label=existing.label,
            page_number=page_number,
            caption_box=caption_box,
            caption_text=caption_text,
            source="+".join(sources),
            visual_box=existing.visual_box or target.visual_box,
            visual_aspect_ratio=(
                existing.visual_aspect_ratio or target.visual_aspect_ratio
            ),
        )
    targets = list(by_label.values())
    targets.sort(key=lambda item: (item.page_number, item.label))
    resolved: list[Target] = []
    for target in targets:
        if target.caption_box or target.page_number not in pages:
            resolved.append(target)
            continue
        label_pattern = re.compile(re.escape(target.label).replace(r"\ ", r"\s+"), re.I)
        caption_box = None
        for box in pages[target.page_number]["texts"]:
            if label_pattern.search(normalize_label(box.text)):
                caption_box = box.rect
                break
        resolved.append(
            Target(
                label=target.label,
                page_number=target.page_number,
                caption_box=caption_box,
                caption_text=target.caption_text,
                source=target.source,
                visual_box=target.visual_box,
                visual_aspect_ratio=target.visual_aspect_ratio,
            ),
        )
    return resolved


def is_page_furniture(rect: Rect, page: dict[str, Any]) -> bool:
    width_ratio = rect.width / max(1.0, page["width"])
    height_ratio = rect.height / max(1.0, page["height"])
    area_ratio = rect.area / max(1.0, page["width"] * page["height"])
    return (
        (width_ratio < 0.08 and height_ratio > 0.45)
        or area_ratio < 0.0015
        or rect.width < 18
        or rect.height < 18
    )


def is_caption_text_box(box: TextBox, target: Target) -> bool:
    if target.caption_box and intersect_area(box.rect, target.caption_box) > 0:
        return True
    return target.label.lower() in normalize_label(box.text).lower()


def text_overlap_ratio(rect: Rect, page: dict[str, Any], target: Target) -> float:
    overlap = 0.0
    for box in page["texts"]:
        if is_caption_text_box(box, target):
            continue
        overlap += intersect_area(rect, box.rect)
    return overlap / max(1.0, rect.area)


def paragraph_text_overlap_ratio(
    rect: Rect,
    page: dict[str, Any],
    target: Target,
) -> float:
    overlap = 0.0
    for box in page["texts"]:
        if is_caption_text_box(box, target):
            continue
        text = box.text.strip()
        looks_like_paragraph = (
            len(text) >= 38
            or box.rect.width >= min(240.0, rect.width * 0.34)
        )
        if not looks_like_paragraph or box.rect.height > 32:
            continue
        box_overlap = intersect_area(rect, box.rect)
        if box_overlap / max(1.0, box.rect.area) < 0.65:
            continue
        overlap += box_overlap
    return overlap / max(1.0, rect.area)


def candidate_is_near_caption(rect: Rect, page: dict[str, Any], target: Target) -> bool:
    if not target.caption_box:
        return True
    gap_ratio = vertical_gap(rect, target.caption_box) / max(1.0, page["height"])
    horizontal = horizontal_overlap_ratio(rect, target.caption_box)
    return gap_ratio <= 0.34 and horizontal >= 0.18


def score_candidate(
    source: str,
    rect: Rect,
    box_count: int,
    reasons: list[str],
    page: dict[str, Any],
    target: Target,
) -> Candidate:
    if source == "pdf-image-object":
        confidence = 0.64
    elif source == "mineru-layout-region":
        confidence = 0.84
    else:
        confidence = 0.48
    area_ratio = rect.area / max(1.0, page["width"] * page["height"])
    confidence += min(0.08, area_ratio * 0.55)
    if target.caption_box:
        gap_ratio = vertical_gap(rect, target.caption_box) / max(1.0, page["height"])
        horizontal = horizontal_overlap_ratio(rect, target.caption_box)
        if gap_ratio <= 0.04:
            confidence += 0.18
            reasons.append("touches caption band")
        elif gap_ratio <= 0.18:
            confidence += 0.12
            reasons.append("near caption")
        elif gap_ratio <= 0.32:
            confidence += 0.07
            reasons.append("same page as caption")
        if horizontal >= 0.65:
            confidence += 0.10
            reasons.append("same column as caption")
        elif horizontal >= 0.25:
            confidence += 0.05
            reasons.append("partial caption-column overlap")
    if box_count > 1:
        confidence += 0.04
    warnings: list[str] = []
    overlap = text_overlap_ratio(rect, page, target)
    overlap_limit = 0.18 if source == "mineru-layout-region" else 0.03
    if overlap > overlap_limit:
        confidence -= min(0.50, overlap * 2.4)
        warnings.append("substantial non-caption text overlap")
    paragraph_overlap = paragraph_text_overlap_ratio(rect, page, target)
    if paragraph_overlap > 0.04:
        confidence -= min(0.55, paragraph_overlap * 4.0)
        warnings.append("paragraph-like text overlap")
    confidence = max(0.0, min(1.0, confidence))
    return Candidate(source, rect, confidence, tuple(reasons), tuple(warnings))


def choose_image_candidate(page: dict[str, Any], target: Target) -> Candidate | None:
    boxes = [box for box in page["images"] if not is_page_furniture(box, page)]
    candidates: list[Candidate] = []
    for box in boxes:
        candidates.append(
            score_candidate(
                "pdf-image-object",
                box,
                1,
                ["pdf image object"],
                page,
                target,
            ),
        )
    near = [box for box in boxes if candidate_is_near_caption(box, page, target)]
    if len(near) > 1:
        candidates.append(
            score_candidate(
                "pdf-image-object",
                rect_union(near),
                len(near),
                ["compound pdf image object group"],
                page,
                target,
            ),
        )
    if not candidates:
        return None
    return max(candidates, key=lambda item: item.confidence)


def should_caption_region_override(
    candidate: Candidate | None,
    region_candidate: Candidate,
    page: dict[str, Any],
) -> bool:
    if not candidate:
        return True
    if candidate.source == "pdf-image-object" and candidate.confidence >= 0.84:
        overlap = intersect_area(candidate.rect, region_candidate.rect)
        overlap_ratio = overlap / max(
            1.0,
            min(candidate.rect.area, region_candidate.rect.area),
        )
        if overlap_ratio < 0.20:
            return False
    return (
        region_candidate.confidence >= candidate.confidence + 0.02
        or (
            region_candidate.confidence >= 0.50
            and region_candidate.rect.area >= candidate.rect.area * 1.25
        )
        or (
            candidate.confidence <= 0.86
            and region_candidate.confidence >= candidate.confidence - 0.06
        )
    )


def choose_mineru_layout_candidate(
    page: dict[str, Any],
    target: Target,
) -> Candidate | None:
    if not target.visual_box:
        return None
    rect = repair_mineru_visual_rect(target.visual_box, page, target)
    if is_page_furniture(rect, page):
        return None
    page_area = max(1.0, page["width"] * page["height"])
    if rect.area / page_area > 0.72:
        return None
    candidate = score_candidate(
        "mineru-layout-region",
        rect,
        1,
        [
            (
                "MinerU manifest PDF crop range"
                if "mineru-manifest" in target.source
                else "MinerU visual block"
            ),
        ],
        page,
        target,
    )
    return candidate


def repair_mineru_visual_rect(
    box: Rect,
    page: dict[str, Any],
    target: Target,
) -> Rect:
    aspect = target.visual_aspect_ratio
    if not aspect or not math.isfinite(aspect) or aspect <= 0:
        return box
    if box.width <= 0 or box.height <= 0:
        return box

    current_aspect = box.width / box.height
    tolerance = 0.08
    max_grow = 2.5
    width = box.width
    height = box.height

    if current_aspect > aspect * (1 + tolerance):
        desired_height = min(width / aspect, height * max_grow)
        if desired_height > height:
            max_bottom = page["height"]
            if (
                target.caption_box
                and target.caption_box.top >= box.bottom
                and horizontal_overlap_ratio(box, target.caption_box) >= 0.15
            ):
                max_bottom = min(max_bottom, target.caption_box.top - 4)
            height = min(desired_height, max(height, max_bottom - box.top))
    elif current_aspect < aspect * (1 - tolerance):
        desired_width = min(height * aspect, width * max_grow)
        if desired_width > width:
            max_right = page["width"]
            if (
                target.caption_box
                and target.caption_box.left >= box.right
                and vertical_gap(box, target.caption_box) <= page["height"] * 0.08
            ):
                max_right = min(max_right, target.caption_box.left - 4)
            width = min(desired_width, max(width, max_right - box.left))

    return Rect(box.left, box.top, width, height)


def should_mask_text_for_mineru_refinement(
    box: TextBox,
    search_rect: Rect,
    seed_rect: Rect,
    page: dict[str, Any],
    target: Target,
) -> bool:
    if intersect_area(box.rect, search_rect) <= 0:
        return False
    if target.caption_box:
        caption_column = (
            box.rect.left >= target.caption_box.left - 8
            and box.rect.top >= target.caption_box.top - 8
            and box.rect.top <= search_rect.bottom + 8
        )
        if caption_column:
            return True
    header_overlap = (
        box.rect.top < page["height"] * 0.11
        and box.rect.top < seed_rect.top
    )
    if header_overlap:
        return True
    text = box.text.strip()
    paragraph_like = len(text) >= 38 or box.rect.width >= min(240.0, seed_rect.width * 0.34)
    above_seed = box.rect.top < seed_rect.top + page["height"] * 0.012
    return paragraph_like and above_seed


def refine_mineru_candidate_with_rendered_ink(
    image: Image.Image,
    page: dict[str, Any],
    target: Target,
    candidate: Candidate,
) -> Candidate:
    if candidate.source != "mineru-layout-region":
        return candidate

    rect = candidate.rect
    sx = image.width / page["width"]
    sy = image.height / page["height"]
    arr = np.asarray(image)
    mask = np.any(arr < 245, axis=2)
    mask = mask.copy()

    pad_x = max(8.0, rect.width * 0.05)
    pad_y_top = max(8.0, rect.height * 0.08)
    pad_y_bottom = max(18.0, rect.height * 0.35)
    left = max(0.0, rect.left - pad_x)
    top = max(0.0, rect.top - pad_y_top)
    right = min(page["width"], rect.right + pad_x)
    bottom = min(page["height"], rect.bottom + pad_y_bottom)
    if (
        target.caption_box
        and target.caption_box.top > rect.bottom
        and target.caption_box.top - rect.bottom <= page["height"] * 0.35
    ):
        bottom = min(page["height"], max(bottom, target.caption_box.top - 2))
    search_rect = Rect(left, top, right - left, bottom - top)

    for box in page["texts"]:
        if not should_mask_text_for_mineru_refinement(
            box,
            search_rect,
            rect,
            page,
            target,
        ):
            continue
        x0, y0, x1, y1 = scale_rect(box.rect, sx, sy)
        pad = 4
        mask[
            max(0, y0 - pad) : min(mask.shape[0], y1 + pad),
            max(0, x0 - pad) : min(mask.shape[1], x1 + pad),
        ] = False

    x0, y0, x1, y1 = scale_rect(search_rect, sx, sy)
    window = mask[y0:y1, x0:x1]
    if window.size == 0:
        return candidate
    ys, xs = np.where(window)
    if len(xs) < 40:
        return candidate

    ink_rect = rect_from_pixels(
        (
            x0 + int(xs.min()),
            y0 + int(ys.min()),
            x0 + int(xs.max()) + 1,
            y0 + int(ys.max()) + 1,
        ),
        sx,
        sy,
    )
    snap_pad = 4.0
    refined_left = max(0.0, float(ink_rect.left) - snap_pad)
    refined_top = max(rect.top, float(ink_rect.top) - snap_pad)
    refined_right = min(page["width"], float(ink_rect.right) + snap_pad)
    refined_bottom = min(page["height"], float(ink_rect.bottom) + snap_pad)
    refined = Rect(
        refined_left,
        refined_top,
        refined_right - refined_left,
        refined_bottom - refined_top,
    )
    top_trim = refined.top
    for box in page["texts"]:
        text = box.text.strip()
        paragraph_like = (
            len(text) >= 38
            or box.rect.width >= min(240.0, refined.width * 0.34)
        )
        if (
            paragraph_like
            and box.rect.top <= refined.top + page["height"] * 0.02
            and intersect_area(box.rect, refined) > 0
        ):
            top_trim = max(top_trim, box.rect.bottom + 2)
    if top_trim > refined.top and refined.bottom - top_trim >= page["height"] * 0.03:
        refined = Rect(refined.left, top_trim, refined.width, refined.bottom - top_trim)

    if refined.area < rect.area * 0.30:
        return candidate
    if refined.width < page["width"] * 0.08 or refined.height < page["height"] * 0.03:
        return candidate

    refined_candidate = score_candidate(
        candidate.source,
        refined,
        1,
        [*candidate.reasons, "snapped to rendered figure ink"],
        page,
        target,
    )
    if refined_candidate.confidence < MIN_ACCEPTED_CONFIDENCE:
        return candidate
    return refined_candidate


def render_page(pdf_path: Path, page_number: int, dpi: int, poppler_bin: Path) -> Image.Image:
    with tempfile.TemporaryDirectory(prefix="figure-render-") as tmp_name:
        prefix = Path(tmp_name) / "page"
        run(
            [
                "pdftoppm",
                "-png",
                "-r",
                str(dpi),
                "-f",
                str(page_number),
                "-l",
                str(page_number),
                str(pdf_path),
                str(prefix),
            ],
            poppler_bin=poppler_bin,
        )
        path = sorted(Path(tmp_name).glob("page-*.png"))[0]
        return Image.open(path).convert("RGB")


def scale_rect(rect: Rect, sx: float, sy: float) -> tuple[int, int, int, int]:
    return (
        int(math.floor(rect.left * sx)),
        int(math.floor(rect.top * sy)),
        int(math.ceil(rect.right * sx)),
        int(math.ceil(rect.bottom * sy)),
    )


def rect_from_pixels(
    bbox: tuple[int, int, int, int],
    sx: float,
    sy: float,
) -> Rect:
    left, top, right, bottom = bbox
    return Rect(left / sx, top / sy, (right - left) / sx, (bottom - top) / sy)


def boolean_intervals(active: np.ndarray) -> list[tuple[int, int]]:
    intervals: list[tuple[int, int]] = []
    start: int | None = None
    for index, value in enumerate(active.tolist()):
        if value and start is None:
            start = index
        elif not value and start is not None:
            intervals.append((start, index))
            start = None
    if start is not None:
        intervals.append((start, len(active)))
    return intervals


def merge_intervals(
    intervals: list[tuple[int, int]],
    max_gap: int,
) -> list[tuple[int, int]]:
    if not intervals:
        return []
    merged = [intervals[0]]
    for start, end in intervals[1:]:
        prev_start, prev_end = merged[-1]
        if start - prev_end <= max_gap:
            merged[-1] = (prev_start, end)
        else:
            merged.append((start, end))
    return merged


def rendered_content_x_bounds(
    mask: np.ndarray,
    page: dict[str, Any],
    sx: float,
) -> tuple[float, float]:
    col_counts = mask.sum(axis=0)
    active = col_counts >= max(8, int(mask.shape[0] * 0.0015))
    intervals = boolean_intervals(active)
    if not intervals:
        return page["width"] * 0.05, page["width"] * 0.95
    left = min(start for start, _ in intervals) / sx
    right = max(end for _, end in intervals) / sx
    left = max(page["width"] * 0.02, left)
    right = min(page["width"] * 0.98, right)
    if right - left < page["width"] * 0.25:
        return page["width"] * 0.05, page["width"] * 0.95
    return left, right


def detect_two_column_text_windows(
    page: dict[str, Any],
    content_left: float,
    content_right: float,
) -> list[tuple[float, float]]:
    content_width = max(1.0, content_right - content_left)
    midpoint = (content_left + content_right) / 2
    boxes: list[Rect] = []
    for box in page["texts"]:
        rect = box.rect
        if rect.top < page["height"] * 0.09:
            continue
        if rect.height > 32:
            continue
        if rect.left < content_left - 20 or rect.right > content_right + 20:
            continue
        if rect.width < max(140.0, content_width * 0.20):
            continue
        if rect.width > content_width * 0.60:
            continue
        boxes.append(rect)
    left_boxes = [box for box in boxes if (box.left + box.right) / 2 < midpoint]
    right_boxes = [box for box in boxes if (box.left + box.right) / 2 >= midpoint]
    if len(left_boxes) < 4 or len(right_boxes) < 4:
        return []
    raw_left = (
        min(box.left for box in left_boxes),
        max(box.right for box in left_boxes),
    )
    raw_right = (
        min(box.left for box in right_boxes),
        max(box.right for box in right_boxes),
    )
    gutter = raw_right[0] - raw_left[1]
    if gutter < max(12.0, page["width"] * 0.015):
        return []
    left = (
        max(content_left, raw_left[0] - 10.0),
        min(content_right, raw_left[1] + min(10.0, gutter * 0.35)),
    )
    right = (
        max(content_left, raw_right[0] - min(10.0, gutter * 0.35)),
        min(content_right, raw_right[1] + 10.0),
    )
    min_width = content_width * 0.20
    max_width = content_width * 0.70
    if not (min_width <= left[1] - left[0] <= max_width):
        return []
    if not (min_width <= right[1] - right[0] <= max_width):
        return []
    return [left, right]


def caption_line_rect(page: dict[str, Any], target: Target) -> Rect | None:
    caption = target.caption_box
    if not caption:
        return None
    caption_center_y = (caption.top + caption.bottom) / 2
    same_line: list[Rect] = [caption]
    for box in page["texts"]:
        rect = box.rect
        center_y = (rect.top + rect.bottom) / 2
        if abs(center_y - caption_center_y) > max(4.0, caption.height):
            continue
        if rect.left < caption.left - 4.0:
            continue
        same_line.append(rect)
    same_line.sort(key=lambda rect: rect.left)
    connected: list[Rect] = []
    right = caption.right
    for rect in same_line:
        if rect.right < caption.left - 4.0:
            continue
        if rect.left > right + max(12.0, caption.height * 1.2):
            break
        connected.append(rect)
        right = max(right, rect.right)
    return rect_union(connected or [caption])


def caption_column_window(
    page: dict[str, Any],
    target: Target,
    content_left: float,
    content_right: float,
) -> tuple[float, float] | None:
    caption = target.caption_box
    if not caption:
        return None
    columns = detect_two_column_text_windows(page, content_left, content_right)
    if len(columns) != 2:
        return None
    caption_center = (caption.left + caption.right) / 2
    column = None
    for candidate in columns:
        if candidate[0] - 8.0 <= caption_center <= candidate[1] + 8.0:
            column = candidate
            break
    if column is None:
        column = min(
            columns,
            key=lambda candidate: min(
                abs(caption_center - candidate[0]),
                abs(caption_center - candidate[1]),
            ),
        )
    line = caption_line_rect(page, target)
    if line:
        column_width = max(1.0, column[1] - column[0])
        crosses_column = line.right > column[1] + 12.0 or line.left < column[0] - 12.0
        if crosses_column and line.width > column_width * 1.18:
            return None
    return column


def caption_x_window(
    page: dict[str, Any],
    target: Target,
    page_targets: list[Target],
    content_left: float,
    content_right: float,
) -> tuple[float, float]:
    caption = target.caption_box
    if not caption:
        return content_left, content_right
    content_width = max(1.0, content_right - content_left)
    center = (caption.left + caption.right) / 2
    if caption.width >= content_width * 0.62:
        return content_left, content_right

    centers = sorted(
        (item.caption_box.left + item.caption_box.right) / 2
        for item in page_targets
        if item.caption_box
        and item is not target
        and abs(
            ((item.caption_box.left + item.caption_box.right) / 2) - center
        )
        > content_width * 0.12
    )
    left_neighbors = [value for value in centers if value < center]
    right_neighbors = [value for value in centers if value > center]
    left = content_left
    right = content_right
    if left_neighbors:
        left = (max(left_neighbors) + center) / 2
    elif center > content_left + content_width * 0.58:
        left = content_left + content_width * 0.50
    if right_neighbors:
        right = (min(right_neighbors) + center) / 2
    elif left_neighbors or center >= content_left + content_width * 0.42:
        pass
    else:
        return content_left, content_right

    if not right_neighbors and center < content_left + content_width * 0.42:
        right = content_left + content_width * 0.50

    pad = 10.0
    left = max(content_left, min(caption.left - pad, left - pad))
    right = min(content_right, max(caption.right + pad, right + pad))
    if right - left < max(page["width"] * 0.18, caption.width * 1.05):
        extra = max(20.0, caption.width * 0.15)
        left = max(content_left, caption.left - extra)
        right = min(content_right, caption.right + extra)
    return left, right


def caption_y_window(
    page: dict[str, Any],
    target: Target,
    page_targets: list[Target],
    x_window: tuple[float, float],
) -> tuple[float, float]:
    caption = target.caption_box
    if not caption:
        return page["height"] * 0.05, page["height"] * 0.95
    left, right = x_window
    window_rect = Rect(left, 0, right - left, page["height"])
    top = 0.0
    for item in page_targets:
        other = item.caption_box
        if not other or item is target or other.bottom >= caption.top:
            continue
        same_window = (
            intersect_area(window_rect, other) / max(1.0, other.area) >= 0.25
            or left <= (other.left + other.right) / 2 <= right
        )
        if same_window:
            top = max(top, other.bottom + 12.0)
    if caption.top > page["height"] * 0.28:
        top = max(top, page["height"] * 0.055)
    bottom = max(top + 12.0, caption.top - 4.0)
    return top, bottom


def trim_leading_header_rows(
    row_counts: np.ndarray,
    start: int,
    end: int,
    window_width: int,
    sy: float,
) -> int:
    if end - start < max(24, int(18 * sy)):
        return start
    segment = row_counts[start:end]
    window = max(4, int(8 * sy))
    if len(segment) <= window:
        return start
    rolling = np.convolve(segment, np.ones(window, dtype=np.int32), mode="valid")
    dense_threshold = max(
        window * max(5, int(window_width * 0.006)),
        int(window_width * window * 0.010),
    )
    dense_indexes = np.where(rolling >= dense_threshold)[0]
    if dense_indexes.size == 0:
        return start
    trimmed = start + int(dense_indexes[0]) - int(10 * sy)
    return max(start, trimmed)


def looks_like_page_header_text(text: str) -> bool:
    normalized = re.sub(r"\s+", " ", text.strip()).lower()
    if not normalized:
        return True
    header_terms = (
        "article",
        "research article",
        "open access",
        "cellpress",
        "cell press",
        "neuron",
        "nature",
        "science",
        "downloaded from",
        "https://",
        "doi.org",
    )
    return any(term in normalized for term in header_terms)


def has_top_figure_evidence(
    rect: Rect,
    header_floor: float,
    page: dict[str, Any],
    target: Target,
) -> bool:
    top_band_height = header_floor - rect.top
    if top_band_height <= 0:
        return False
    top_band = Rect(rect.left, rect.top, rect.width, top_band_height)
    text_boxes = [
        box
        for box in page["texts"]
        if not is_caption_text_box(box, target)
        and not looks_like_page_header_text(box.text)
        and intersect_area(box.rect, top_band) / max(1.0, box.rect.area) >= 0.35
    ]
    if len(text_boxes) >= 5:
        return True
    text_area = sum(intersect_area(box.rect, top_band) for box in text_boxes)
    if text_area / max(1.0, top_band.area) >= 0.012:
        return True
    image_area = sum(
        intersect_area(image_box, top_band)
        for image_box in page["images"]
        if not is_page_furniture(image_box, page)
    )
    return image_area / max(1.0, top_band.area) >= 0.012


def is_paragraph_like_box(box: TextBox, rect: Rect) -> bool:
    text = box.text.strip()
    return len(text) >= 38 or box.rect.width >= min(240.0, rect.width * 0.34)


def trim_leading_paragraph_text(rect: Rect, page: dict[str, Any], target: Target) -> Rect:
    paragraph_boxes = [
        box
        for box in page["texts"]
        if not is_caption_text_box(box, target)
        and is_paragraph_like_box(box, rect)
        and box.rect.top < rect.top + rect.height * 0.35
        and intersect_area(box.rect, rect) / max(1.0, box.rect.area) >= 0.65
    ]
    if len(paragraph_boxes) < 4:
        return rect
    top = max(box.rect.bottom for box in paragraph_boxes) + 6
    if rect.bottom - top < max(48.0, page["height"] * 0.12):
        return rect
    return Rect(rect.left, top, rect.width, rect.bottom - top)


def choose_caption_region_candidate(
    image: Image.Image,
    page: dict[str, Any],
    target: Target,
    page_targets: list[Target],
) -> Candidate | None:
    if not target.caption_box:
        return None
    sx = image.width / page["width"]
    sy = image.height / page["height"]
    arr = np.asarray(image)
    visual = np.any(arr < 250, axis=2)
    content_left, content_right = rendered_content_x_bounds(visual, page, sx)

    def build_candidate(
        x_window: tuple[float, float],
        reason: str | None = None,
    ) -> Candidate | None:
        x_left, x_right = x_window
        y_top, y_bottom = caption_y_window(
            page,
            target,
            page_targets,
            (x_left, x_right),
        )
        x0 = max(0, int(math.floor(x_left * sx)))
        x1 = min(image.width, int(math.ceil(x_right * sx)))
        y0 = max(0, int(math.floor(y_top * sy)))
        y1 = min(image.height, int(math.ceil(y_bottom * sy)))
        if x1 - x0 < 24 or y1 - y0 < 24:
            return None

        window = visual[y0:y1, x0:x1]
        row_counts = window.sum(axis=1)
        row_threshold = max(5, int(window.shape[1] * 0.003))
        intervals = boolean_intervals(row_counts >= row_threshold)
        intervals = merge_intervals(intervals, max(2, int(6 * sy)))
        intervals = [
            (start, end)
            for start, end in intervals
            if end - start >= max(4, int(3 * sy))
            and int(row_counts[start:end].sum()) >= (end - start) * row_threshold
        ]
        if not intervals:
            return None

        start, end = intervals[-1]
        max_cluster_gap = max(8, int(36 * sy))
        for prev_start, prev_end in reversed(intervals[:-1]):
            if start - prev_end > max_cluster_gap:
                break
            start = prev_start
        start = trim_leading_header_rows(row_counts, start, end, window.shape[1], sy)
        pad_y = max(2, int(3 * sy))
        start = max(0, start - pad_y)
        end = min(window.shape[0], end + pad_y)
        if end - start < max(10, int(8 * sy)):
            return None

        band = window[start:end, :]
        col_counts = band.sum(axis=0)
        col_threshold = max(4, int(band.shape[0] * 0.004))
        col_intervals = boolean_intervals(col_counts >= col_threshold)
        col_intervals = merge_intervals(col_intervals, max(2, int(8 * sx)))
        col_intervals = [
            (start_col, end_col)
            for start_col, end_col in col_intervals
            if end_col - start_col >= max(6, int(6 * sx))
        ]
        if not col_intervals:
            return None
        col_start = min(start_col for start_col, _ in col_intervals)
        col_end = max(end_col for _, end_col in col_intervals)
        pad_x = max(2, int(4 * sx))
        bbox = (
            max(0, x0 + col_start - pad_x),
            max(0, y0 + start),
            min(image.width, x0 + col_end + pad_x),
            min(image.height, y0 + end),
        )
        rect = rect_from_pixels(bbox, sx, sy)
        warnings: list[str] = []
        header_floor = page["height"] * 0.11
        header_probe = Rect(rect.left, 0, rect.width, header_floor + 8)
        has_header_text = any(
            box.rect.top < page["height"] * 0.12
            and not is_caption_text_box(box, target)
            and intersect_area(box.rect, header_probe) > 0
            for box in page["texts"]
        )
        if (
            has_header_text
            and rect.top <= page["height"] * 0.055 + 1
            and rect.top < header_floor
            and target.caption_box.top > page["height"] * 0.30
            and rect.bottom - header_floor >= page["height"] * 0.08
            and not has_top_figure_evidence(rect, header_floor, page, target)
        ):
            rect = Rect(rect.left, header_floor, rect.width, rect.bottom - header_floor)
            warnings.append("trimmed page header band")
        trimmed_rect = trim_leading_paragraph_text(rect, page, target)
        if trimmed_rect != rect:
            rect = trimmed_rect
            warnings.append("trimmed leading paragraph text")
        page_area = max(1.0, page["width"] * page["height"])
        if rect.width < page["width"] * 0.12 or rect.height < page["height"] * 0.035:
            return None
        if rect.area / page_area > 0.72:
            return None

        reasons = ["rendered pixels bounded by caption"]
        if reason:
            reasons.append(reason)
        confidence = 0.76
        gap_ratio = vertical_gap(rect, target.caption_box) / max(1.0, page["height"])
        if gap_ratio <= 0.035:
            confidence += 0.11
            reasons.append("touches caption band")
        elif gap_ratio <= 0.12:
            confidence += 0.07
            reasons.append("near caption")
        if horizontal_overlap_ratio(rect, target.caption_box) >= 0.60:
            confidence += 0.06
            reasons.append("caption-aligned region")
        area_ratio = rect.area / page_area
        confidence += min(0.04, area_ratio * 0.20)
        overlap = text_overlap_ratio(rect, page, target)
        if overlap > 0.12:
            confidence -= min(0.35, overlap * 1.4)
            warnings.append("substantial non-caption text overlap")
        paragraph_overlap = paragraph_text_overlap_ratio(rect, page, target)
        if paragraph_overlap > 0.04:
            confidence -= min(0.60, paragraph_overlap * 4.4)
            warnings.append("paragraph-like text overlap")
        if paragraph_overlap > 0.12:
            confidence = min(confidence, 0.36)
        if rect.top <= page["height"] * 0.055 + 1 and target.caption_box.top > page["height"] * 0.35:
            confidence -= 0.04
            warnings.append("touches page header band")
        confidence = max(0.0, min(1.0, confidence))
        return Candidate(
            "caption-bounded-region",
            rect,
            confidence,
            tuple(reasons),
            tuple(warnings),
        )

    default_window = caption_x_window(
        page,
        target,
        page_targets,
        content_left,
        content_right,
    )
    default_candidate = build_candidate(default_window)
    column_window = caption_column_window(page, target, content_left, content_right)
    column_candidate = None
    if column_window and (
        abs(column_window[0] - default_window[0]) > 4
        or abs(column_window[1] - default_window[1]) > 4
    ):
        column_candidate = build_candidate(column_window, "detected text column")
    if not default_candidate:
        return column_candidate
    if not column_candidate:
        return default_candidate
    if (
        default_candidate.confidence < MIN_ACCEPTED_CONFIDENCE
        and column_candidate.confidence >= default_candidate.confidence + 0.05
    ):
        return column_candidate
    if (
        len(page_targets) > 1
        and column_candidate.confidence >= default_candidate.confidence - 0.08
        and (
            column_candidate.rect.area >= default_candidate.rect.area * 1.12
            or column_candidate.rect.area <= default_candidate.rect.area * 0.92
            or column_candidate.confidence >= default_candidate.confidence
        )
    ):
        return column_candidate
    if column_candidate.confidence > default_candidate.confidence + 0.03:
        return column_candidate
    if (
        column_candidate.confidence >= default_candidate.confidence - 0.02
        and column_candidate.rect.area >= default_candidate.rect.area * 1.25
    ):
        return column_candidate
    return default_candidate


def choose_ink_candidate(
    image: Image.Image,
    page: dict[str, Any],
    target: Target,
) -> Candidate | None:
    sx = image.width / page["width"]
    sy = image.height / page["height"]
    arr = np.asarray(image)
    ink = np.any(arr < 245, axis=2)
    for box in page["texts"]:
        left, top, right, bottom = scale_rect(box.rect, sx, sy)
        pad = 3
        ink[
            max(0, top - pad) : min(ink.shape[0], bottom + pad),
            max(0, left - pad) : min(ink.shape[1], right + pad),
        ] = False
    labeled, count = ndimage.label(ink)
    slices = ndimage.find_objects(labeled)
    boxes: list[Rect] = []
    for index in range(count):
        slc = slices[index]
        if slc is None:
            continue
        ys, xs = slc
        width = xs.stop - xs.start
        height = ys.stop - ys.start
        area = int((labeled[slc] == index + 1).sum())
        if width < 8 or height < 8 or area < 45:
            continue
        rect = rect_from_pixels((xs.start, ys.start, xs.stop, ys.stop), sx, sy)
        if is_page_furniture(rect, page):
            continue
        if not candidate_is_near_caption(rect, page, target):
            continue
        if target.caption_box:
            caption = target.caption_box
            same_column = horizontal_overlap_ratio(rect, caption) >= 0.08
            above = rect.bottom <= caption.top and caption.top - rect.bottom <= page["height"] * 0.62
            below = rect.top >= caption.bottom and rect.top - caption.bottom <= page["height"] * 0.40
            if not same_column or not (above or below):
                continue
        boxes.append(rect)
    if not boxes:
        return None
    union = rect_union(boxes)
    return score_candidate(
        "rendered-ink",
        union,
        len(boxes),
        ["compound rendered ink component group"],
        page,
        target,
    )


def target_for_candidate_page(target: Target, page_number: int) -> Target:
    same_page = page_number == target.page_number
    return Target(
        label=target.label,
        page_number=page_number,
        caption_box=target.caption_box if same_page else None,
        caption_text=target.caption_text,
        source=target.source,
        visual_box=target.visual_box if same_page else None,
        visual_aspect_ratio=target.visual_aspect_ratio if same_page else None,
    )


def candidate_page_numbers(target: Target, pages: dict[int, dict[str, Any]]) -> list[int]:
    numbers: list[int] = []
    for page_number in (
        target.page_number,
        target.page_number - 1,
        target.page_number + 1,
    ):
        if page_number in pages and page_number not in numbers:
            numbers.append(page_number)
    return numbers


def caption_near_page_boundary(target: Target, pages: dict[int, dict[str, Any]]) -> bool:
    if not target.caption_box:
        return False
    page = pages.get(target.page_number)
    if not page:
        return False
    height = max(1.0, page["height"])
    return (
        target.caption_box.top <= height * 0.16
        or target.caption_box.bottom >= height * 0.84
    )


def caption_boundary_direction(
    target: Target,
    pages: dict[int, dict[str, Any]],
) -> str | None:
    if not target.caption_box:
        return None
    page = pages.get(target.page_number)
    if not page:
        return None
    height = max(1.0, page["height"])
    if target.caption_box.bottom >= height * 0.84:
        return "next"
    if target.caption_box.top <= height * 0.16:
        return "previous"
    return None


def caption_requests_next_page(target: Target) -> bool:
    return bool(re.search(r"\bsee\s+next\s+page\b", target.caption_text, re.I))


def page_has_other_caption_target(
    *,
    page_number: int,
    target: Target,
    all_targets: list[Target],
) -> bool:
    return any(
        other.page_number == page_number
        and other.label != target.label
        and other.caption_box is not None
        for other in all_targets
    )


def candidate_is_near_other_caption(
    *,
    candidate: Candidate,
    page: dict[str, Any],
    page_number: int,
    target: Target,
    all_targets: list[Target],
) -> bool:
    for other in all_targets:
        if (
            other.page_number != page_number
            or other.label == target.label
            or not other.caption_box
        ):
            continue
        gap_ratio = vertical_gap(candidate.rect, other.caption_box) / max(
            1.0,
            page["height"],
        )
        horizontal = horizontal_overlap_ratio(candidate.rect, other.caption_box)
        caption_below_candidate = other.caption_box.top >= candidate.rect.bottom - 4
        if gap_ratio <= 0.12 and (horizontal >= 0.10 or caption_below_candidate):
            return True
    return False


def adjust_cross_page_candidate(
    candidate: Candidate,
    *,
    target: Target,
    candidate_page_number: int,
    caption_page_candidate: Candidate | None,
    pages: dict[int, dict[str, Any]],
    all_targets: list[Target],
) -> Candidate:
    if candidate_page_number == target.page_number:
        return candidate_with_adjusted_score(
            candidate,
            delta=0.0,
            reason="candidate on caption page",
        )

    previous_page = candidate_page_number < target.page_number
    weak_caption_page = (
        caption_page_candidate is None
        or caption_page_candidate.confidence < MIN_ACCEPTED_CONFIDENCE
    )
    delta = -0.04
    reasons = ["previous page visual candidate" if previous_page else "next page visual candidate"]
    if weak_caption_page:
        delta += 0.16
        reasons.append("caption page has no strong visual candidate")
    if caption_near_page_boundary(target, pages):
        delta += 0.06
        reasons.append("caption near page boundary")
    boundary_direction = caption_boundary_direction(target, pages)
    if boundary_direction == "next":
        if previous_page:
            delta -= 0.10
            reasons.append("caption is at bottom of page")
        else:
            delta += 0.10
            reasons.append("caption bottom suggests next page visual")
    elif boundary_direction == "previous":
        if previous_page:
            delta += 0.10
            reasons.append("caption top suggests previous page visual")
        else:
            delta -= 0.10
            reasons.append("caption is at top of page")
    if page_has_other_caption_target(
        page_number=candidate_page_number,
        target=target,
        all_targets=all_targets,
    ):
        delta -= 0.16
        reasons.append("adjacent page has a different figure caption")
        page = pages.get(candidate_page_number)
        if page and candidate_is_near_other_caption(
            candidate=candidate,
            page=page,
            page_number=candidate_page_number,
            target=target,
            all_targets=all_targets,
        ):
            delta -= 0.50
            reasons.append("candidate is aligned to that different caption")
    if caption_requests_next_page(target) and not previous_page:
        delta += 0.16
        reasons.append("caption says see next page")
    return candidate_with_adjusted_score(
        candidate,
        delta=delta,
        reason="; ".join(reasons),
        warning=f"caption detected on page {target.page_number}",
    )


def resolve_candidate_on_page(
    *,
    case: PdfCase,
    pages: dict[int, dict[str, Any]],
    render_cache: dict[int, Image.Image],
    target: Target,
    all_targets: list[Target],
    page_number: int,
    dpi: int,
    poppler_bin: Path,
) -> tuple[Candidate | None, Image.Image | None]:
    page = pages.get(page_number)
    if not page:
        return None, None
    page_target = target_for_candidate_page(target, page_number)
    page_targets = [
        item
        for item in all_targets
        if item.page_number == page_number and item.caption_box
    ]
    image: Image.Image | None = None
    candidate = choose_image_candidate(page, page_target)
    mineru_candidate = choose_mineru_layout_candidate(page, page_target)
    if mineru_candidate:
        manifest_candidate = "mineru-manifest" in page_target.source
        if not candidate:
            candidate = mineru_candidate
        elif manifest_candidate:
            if (
                candidate.confidence < 0.74
                and mineru_candidate.confidence >= candidate.confidence + 0.04
            ) or (
                candidate.confidence < 0.82
                and mineru_candidate.rect.area >= candidate.rect.area * 1.7
            ):
                candidate = mineru_candidate
        elif (
            mineru_candidate.confidence >= candidate.confidence - 0.04
            or mineru_candidate.rect.area >= candidate.rect.area * 1.25
        ):
            candidate = mineru_candidate
    if (
        candidate
        and candidate.source == "mineru-layout-region"
        and "mineru-manifest" not in page_target.source
    ):
        image = render_cache.get(page_number)
        if image is None:
            image = render_page(case.pdf_path, page_number, dpi, poppler_bin)
            render_cache[page_number] = image
        candidate = refine_mineru_candidate_with_rendered_ink(
            image,
            page,
            page_target,
            candidate,
        )
    region_candidate: Candidate | None = None
    if page_target.caption_box:
        image = render_cache.get(page_number)
        if image is None:
            image = render_page(case.pdf_path, page_number, dpi, poppler_bin)
            render_cache[page_number] = image
        region_candidate = choose_caption_region_candidate(
            image,
            page,
            page_target,
            page_targets,
        )
        if region_candidate and should_caption_region_override(
            candidate,
            region_candidate,
            page,
        ):
            candidate = region_candidate
    page_area = max(1.0, page["width"] * page["height"])
    should_try_ink = (
        not candidate
        or candidate.confidence < 0.72
        or (
            candidate.source == "pdf-image-object"
            and candidate.rect.area / page_area < 0.12
        )
    )
    if should_try_ink:
        image = render_cache.get(page_number)
        if image is None:
            image = render_page(case.pdf_path, page_number, dpi, poppler_bin)
            render_cache[page_number] = image
        ink_candidate = choose_ink_candidate(image, page, page_target)
        if (
            ink_candidate
            and (
                not candidate
                or ink_candidate.confidence >= candidate.confidence - 0.04
                or (
                    candidate.source != "caption-bounded-region"
                    and ink_candidate.confidence >= 0.45
                    and ink_candidate.rect.area >= candidate.rect.area * 1.8
                )
            )
        ):
            candidate = ink_candidate
    return candidate, image


def crop_image(
    image: Image.Image,
    rect: Rect,
    page: dict[str, Any],
    margin_px: int,
) -> tuple[Image.Image, tuple[int, int, int, int]]:
    sx = image.width / page["width"]
    sy = image.height / page["height"]
    left, top, right, bottom = scale_rect(rect, sx, sy)
    bbox = (
        max(0, left - margin_px),
        max(0, top - margin_px),
        min(image.width, right + margin_px),
        min(image.height, bottom + margin_px),
    )
    return image.crop(bbox), bbox


def draw_overlay(
    image: Image.Image,
    bbox: tuple[int, int, int, int],
    label: str,
) -> Image.Image:
    overlay = image.copy()
    draw = ImageDraw.Draw(overlay)
    draw.rectangle(bbox, outline=(220, 0, 0), width=max(4, image.width // 300))
    draw.text((bbox[0] + 6, max(0, bbox[1] - 18)), label, fill=(220, 0, 0))
    overlay.thumbnail((900, 1200))
    return overlay


def safe_stem(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_").lower()
    return value[:90] or "figure"


def query_requests_all_figures(query: str) -> bool:
    text = re.sub(r"\s+", " ", query or "").strip().lower()
    if not text:
        return True
    return bool(
        re.search(r"\b(all|every|each)\s+(?:of\s+the\s+)?fig(?:ure)?s?\b", text)
        or re.search(r"\bfig(?:ure)?s?\s+(?:all|overview|summary)\b", text)
    )


def query_requests_table(query: str) -> bool:
    return bool(re.search(r"(?i)\btables?\s+(?:[S]?\d+|[IVX]+)\b", query or ""))


def query_panel_hints(query: str) -> dict[str, str]:
    hints: dict[str, str] = {}
    for match in re.finditer(r"(?i)\bpanel\s+(\d+)\s*([a-z])\b", query or ""):
        hints[f"Figure {match.group(1)}"] = match.group(2).lower()
    for match in re.finditer(r"(?i)\bfig(?:ure)?\.?\s*(\d+)\s*([a-z])\b", query or ""):
        hints[f"Figure {match.group(1)}"] = match.group(2).lower()
    return hints


def expand_requested_figure_labels(query: str) -> set[str]:
    text = query or ""
    labels: set[str] = set()
    extended_numbers: set[str] = set()
    supplementary_numbers: set[str] = set()
    for match in re.finditer(
        r"(?i)\bExtended\s+Data\s+Fig(?:ure)?\.?\s*(\d+)\b",
        text,
    ):
        number = match.group(1)
        extended_numbers.add(number)
        labels.add(f"Extended Data Figure {number}")
    for match in re.finditer(
        r"(?i)\bSupplementary\s+Fig(?:ure)?\.?\s*(S?\d+)\b",
        text,
    ):
        number = match.group(1).upper()
        supplementary_numbers.add(number)
        labels.add(f"Supplementary Figure {number}")
    for match in re.finditer(
        r"(?i)\b(?:fig(?:ure)?s?\.?|figs?\.?)\s+([S\dA-Za-z,\s&\-–—toand]+)",
        text,
    ):
        segment = match.group(1)
        segment = re.split(r"(?i)\b(?:on|in|from|with|about|and\s+save|write)\b", segment)[0]
        numbers = re.findall(r"(?i)\bS?\d+\b", segment)
        if not numbers:
            continue
        if len(numbers) == 2 and re.search(r"[-–—]|\bto\b", segment, re.I):
            start_raw, end_raw = numbers
            if start_raw.upper().startswith("S") or end_raw.upper().startswith("S"):
                for number in numbers:
                    labels.add(f"Figure {number.upper()}")
            else:
                start = int(start_raw)
                end = int(end_raw)
                if start <= end and end - start <= 80:
                    for number in range(start, end + 1):
                        labels.add(f"Figure {number}")
                else:
                    for number in numbers:
                        labels.add(f"Figure {number}")
        else:
            for number in numbers:
                labels.add(f"Figure {number.upper()}")
    for label in query_panel_hints(text):
        labels.add(label)
    for number in extended_numbers:
        labels.discard(f"Figure {number}")
    for number in supplementary_numbers:
        labels.discard(f"Figure {number}")
    return labels


def direct_entry_matches_request(
    figure: dict[str, Any],
    *,
    query: str,
    pages: set[int],
) -> bool:
    requested_labels = expand_requested_figure_labels(query)
    table_requested = query_requests_table(query)
    all_requested = query_requests_all_figures(query) or (
        not requested_labels and not table_requested
    )
    label = normalize_label(str(figure.get("label") or ""))
    page_number = int(figure.get("pageNumber") or 0)
    caption_page_number = int(figure.get("captionPageNumber") or page_number or 0)
    if pages and page_number not in pages and caption_page_number not in pages:
        return False
    if all_requested:
        return label_allowed_for_all_query(label, query)
    return label in requested_labels


def filter_direct_figures(
    figures: list[dict[str, Any]],
    query: str,
    pages: set[int],
) -> list[dict[str, Any]]:
    filtered: list[dict[str, Any]] = []
    for figure in figures:
        crop_path = figure.get("cropPath")
        if not crop_path:
            continue
        if direct_entry_matches_request(figure, query=query, pages=pages):
            filtered.append(figure)
    return filtered


def direct_expected_figures(
    result: dict[str, Any],
    *,
    query: str,
    pages: set[int],
) -> list[dict[str, Any]]:
    expected: list[dict[str, Any]] = []
    seen: set[str] = set()
    for figure in result.get("figures", []):
        if not isinstance(figure, dict):
            continue
        if not direct_entry_matches_request(figure, query=query, pages=pages):
            continue
        label = normalize_label(str(figure.get("label") or ""))
        page_number = int(figure.get("pageNumber") or 0)
        caption_page_number = int(figure.get("captionPageNumber") or page_number or 0)
        key = f"{label}|{caption_page_number}"
        if not label or key in seen:
            continue
        seen.add(key)
        expected.append(
            {
                "label": label,
                "baseLabel": label,
                "pageNumber": page_number or caption_page_number,
                "captionPageNumber": caption_page_number or page_number,
                "status": "ok" if figure.get("cropPath") else figure.get("status", "missing"),
                "cropPath": str(figure.get("cropPath") or ""),
                "source": str(figure.get("source") or ""),
                "confidence": float(figure.get("confidence") or 0),
            }
        )
    return expected


def stable_figure_id(label: str, page_number: int, index: int) -> str:
    stem = safe_stem(normalize_label(label)).replace("_", "-")
    page = f"p{max(1, int(page_number or 1))}"
    if index <= 1:
        return f"{stem}-{page}"
    return f"{stem}-{page}-{index}"


def direct_output_figures(
    result: dict[str, Any],
    *,
    query: str,
    pages: set[int],
    crop_dir: Path,
) -> list[dict[str, Any]]:
    crop_dir.mkdir(parents=True, exist_ok=True)
    panel_hints = query_panel_hints(query)
    selected = filter_direct_figures(result.get("figures", []), query, pages)
    id_counts: dict[str, int] = {}
    outputs: list[dict[str, Any]] = []
    for figure in selected:
        label = normalize_label(str(figure.get("label") or "Figure"))
        page_number = int(figure.get("pageNumber") or 1)
        base_id = stable_figure_id(label, page_number, 1)
        id_counts[base_id] = id_counts.get(base_id, 0) + 1
        figure_id = stable_figure_id(label, page_number, id_counts[base_id])
        source_crop = Path(str(figure.get("cropPath")))
        final_crop = crop_dir / f"{figure_id}.png"
        if source_crop.resolve() != final_crop.resolve():
            shutil.copyfile(source_crop, final_crop)
        warnings = list(figure.get("warnings") or [])
        reasons = list(figure.get("reasons") or [])
        if reasons:
            warnings.append("reasons: " + "; ".join(str(reason) for reason in reasons[:4]))
        outputs.append(
            {
                "id": figure_id,
                "label": label,
                "baseLabel": label,
                "pageNumber": page_number,
                "captionPageNumber": int(
                    figure.get("captionPageNumber") or page_number
                ),
                "cropPath": str(final_crop),
                "captionText": str(figure.get("captionText") or ""),
                "panelHint": panel_hints.get(label),
                "rect": figure.get("rect") or {},
                "confidence": float(figure.get("confidence") or 0),
                "source": str(figure.get("source") or "raw-pdf-evaluator"),
                "warnings": warnings,
                "mineruImagePaths": [],
            }
        )
    return outputs


def parse_page_set(raw: str | None) -> set[int]:
    pages: set[int] = set()
    if not raw:
        return pages
    for part in re.split(r"[,;\s]+", raw):
        if not part:
            continue
        if "-" in part:
            left, right = part.split("-", 1)
            try:
                start = int(left)
                end = int(right)
            except ValueError:
                continue
            if start <= end and end - start <= 200:
                pages.update(range(start, end + 1))
            continue
        try:
            pages.add(int(part))
        except ValueError:
            continue
    return {page for page in pages if page > 0}


def run_direct_mode(args: argparse.Namespace) -> int:
    pdf_path = Path(args.pdf).expanduser()
    mineru_dir = Path(args.mineru_dir).expanduser()
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")
    if not mineru_dir.exists():
        raise FileNotFoundError(f"MinerU cache directory not found: {mineru_dir}")
    work_dir = Path(args.out).expanduser()
    if args.clean_out and work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    source_data: dict[str, Any] = {}
    source_path = mineru_dir / "_llm_source.json"
    if source_path.exists():
        try:
            source_data = json.loads(source_path.read_text())
        except Exception:
            source_data = {}
    case = PdfCase(
        attachment_id=int(args.attachment_id or source_data.get("attachmentId") or 0),
        attachment_key=str(args.attachment_key or source_data.get("attachmentKey") or "source"),
        parent_item_key=str(source_data.get("parentItemKey") or ""),
        source_filename=str(args.source_filename or source_data.get("sourceFilename") or pdf_path.name),
        pdf_path=pdf_path,
        mineru_dir=mineru_dir,
    )
    result = evaluate_case(
        case,
        work_dir,
        Path(args.poppler_bin),
        int(args.dpi),
        use_mineru_targets=bool(args.use_mineru_targets),
    )
    if not result:
        target_source = "PDF text or MinerU cache" if args.use_mineru_targets else "PDF text"
        payload = {
            "status": "no_figures",
            "algorithmVersion": DIRECT_EXTRACTOR_VERSION,
            "pdfPath": str(pdf_path),
            "mineruDir": str(mineru_dir),
            "figures": [],
            "warnings": [f"No figure targets were resolved from {target_source}."],
        }
    else:
        pages = parse_page_set(args.pages)
        figures = direct_output_figures(
            result,
            query=str(args.query or ""),
            pages=pages,
            crop_dir=Path(args.crop_dir).expanduser(),
        )
        expected_figures = direct_expected_figures(
            result,
            query=str(args.query or ""),
            pages=pages,
        )
        missing_figures = [
            entry
            for entry in expected_figures
            if not entry.get("cropPath")
        ]
        warnings = []
        if missing_figures:
            warnings.append(
                "Missing requested figure crops: "
                + ", ".join(str(entry["label"]) for entry in missing_figures)
            )
        if not figures and not missing_figures:
            warnings.append("No requested figure crops matched the query/page constraint.")
        payload = {
            "status": "ok" if figures else "no_figures",
            "algorithmVersion": DIRECT_EXTRACTOR_VERSION,
            "pdfPath": str(pdf_path),
            "mineruDir": str(mineru_dir),
            "contactSheet": result.get("contactSheet"),
            "overlaySheet": result.get("overlaySheet"),
            "targetCount": result.get("targetCount", 0),
            "cropCount": len(figures),
            "expectedFigures": expected_figures,
            "missingFigures": missing_figures,
            "figures": figures,
            "warnings": warnings,
        }
    encoded = json.dumps(payload, indent=2)
    if args.json_out:
        Path(args.json_out).expanduser().write_text(encoded)
    print(encoded)
    return 0


def make_contact_sheet(
    items: list[tuple[str, Path]],
    out_path: Path,
    thumb_w: int = 360,
    thumb_h: int = 280,
    cols: int = 4,
) -> None:
    if not items:
        return
    tiles: list[Image.Image] = []
    for label, path in items:
        image = Image.open(path).convert("RGB")
        image.thumbnail((thumb_w, thumb_h), Image.Resampling.LANCZOS)
        tile = Image.new("RGB", (thumb_w, thumb_h + 42), "white")
        tile.paste(image, ((thumb_w - image.width) // 2, 34 + (thumb_h - image.height) // 2))
        draw = ImageDraw.Draw(tile)
        draw.text((8, 8), label[:70], fill=(0, 0, 0))
        tiles.append(tile)
    gap = 16
    rows = math.ceil(len(tiles) / cols)
    width = cols * thumb_w + (cols + 1) * gap
    height = rows * (thumb_h + 42) + (rows + 1) * gap
    canvas = Image.new("RGB", (width, height), (242, 242, 242))
    for index, tile in enumerate(tiles):
        row, col = divmod(index, cols)
        canvas.paste(tile, (gap + col * (thumb_w + gap), gap + row * (thumb_h + 42 + gap)))
    canvas.save(out_path, quality=92)


def build_case_targets(
    case: PdfCase,
    pages: dict[int, dict[str, Any]],
    *,
    use_mineru_targets: bool = False,
) -> list[Target]:
    pdf_targets = targets_from_pdf_text(pages)
    if not use_mineru_targets:
        return merge_targets(pdf_targets, [], pages)
    return merge_targets(
        targets_from_manifest(case) + pdf_targets,
        targets_from_mineru(case),
        pages,
    )


def evaluate_case(
    case: PdfCase,
    out_dir: Path,
    poppler_bin: Path,
    dpi: int,
    *,
    use_mineru_targets: bool = False,
) -> dict[str, Any] | None:
    pages = parse_pdf_xml(case.pdf_path, poppler_bin)
    targets = build_case_targets(case, pages, use_mineru_targets=use_mineru_targets)
    if not targets:
        return None
    case_dir = out_dir / f"{case.attachment_id}_{case.attachment_key}"
    case_dir.mkdir(parents=True, exist_ok=True)
    render_cache: dict[int, Image.Image] = {}
    outputs: list[dict[str, Any]] = []
    contact_items: list[tuple[str, Path]] = []
    overlay_items: list[tuple[str, Path]] = []
    for index, target in enumerate(targets, start=1):
        caption_page_candidate, _ = resolve_candidate_on_page(
            case=case,
            pages=pages,
            render_cache=render_cache,
            target=target,
            all_targets=targets,
            page_number=target.page_number,
            dpi=dpi,
            poppler_bin=poppler_bin,
        )
        page_candidates: list[tuple[int, Candidate]] = []
        for page_number in candidate_page_numbers(target, pages):
            if page_number == target.page_number:
                candidate = caption_page_candidate
            else:
                candidate, _ = resolve_candidate_on_page(
                    case=case,
                    pages=pages,
                    render_cache=render_cache,
                    target=target,
                    all_targets=targets,
                    page_number=page_number,
                    dpi=dpi,
                    poppler_bin=poppler_bin,
                )
            if not candidate:
                continue
            page_candidates.append(
                (
                    page_number,
                    adjust_cross_page_candidate(
                        candidate,
                        target=target,
                        candidate_page_number=page_number,
                        caption_page_candidate=caption_page_candidate,
                        pages=pages,
                        all_targets=targets,
                    ),
                )
            )
        if page_candidates:
            selected_page_number, candidate = max(
                page_candidates,
                key=lambda item: (
                    item[1].confidence,
                    1 if item[0] == target.page_number else 0,
                ),
            )
        else:
            selected_page_number = target.page_number
            candidate = None
        page = pages.get(selected_page_number)
        if not page:
            continue
        if not candidate or candidate.confidence < MIN_ACCEPTED_CONFIDENCE:
            outputs.append(
                {
                    "label": target.label,
                    "pageNumber": target.page_number,
                    "captionPageNumber": target.page_number,
                    "status": "no_confident_candidate",
                    "candidateConfidence": (
                        round(
                            max(
                                (item[1].confidence for item in page_candidates),
                                default=0.0,
                            ),
                            3,
                        )
                        if page_candidates
                        else None
                    ),
                }
            )
            continue
        image = render_cache.get(selected_page_number)
        if image is None:
            image = render_page(case.pdf_path, selected_page_number, dpi, poppler_bin)
            render_cache[selected_page_number] = image
        crop, bbox = crop_image(image, candidate.rect, page, margin_px=0)
        stem = f"{index:02d}_{safe_stem(target.label)}"
        crop_path = case_dir / f"{stem}.png"
        overlay_path = case_dir / f"{stem}_overlay.png"
        crop.save(crop_path)
        draw_overlay(image, bbox, f"{target.label} {candidate.source}").save(overlay_path)
        contact_items.append((f"{target.label} p{selected_page_number}", crop_path))
        overlay_items.append((f"{target.label} p{selected_page_number}", overlay_path))
        relation = (
            "same-page"
            if selected_page_number == target.page_number
            else "previous-page"
            if selected_page_number < target.page_number
            else "next-page"
        )
        outputs.append(
            {
                "label": target.label,
                "pageNumber": selected_page_number,
                "captionPageNumber": target.page_number,
                "pageRelation": relation,
                "captionSource": target.source,
                "captionText": target.caption_text[:240],
                "source": candidate.source,
                "confidence": round(candidate.confidence, 3),
                "rect": candidate.rect.to_json(),
                "cropPath": str(crop_path),
                "overlayPath": str(overlay_path),
                "reasons": list(candidate.reasons),
                "warnings": list(candidate.warnings),
            }
        )
    make_contact_sheet(contact_items, case_dir / "contact_sheet.jpg")
    make_contact_sheet(overlay_items, case_dir / "overlay_sheet.jpg", thumb_h=430, cols=3)
    result = {
        "attachmentId": case.attachment_id,
        "attachmentKey": case.attachment_key,
        "parentItemKey": case.parent_item_key,
        "sourceFilename": case.source_filename,
        "pdfPath": str(case.pdf_path),
        "mineruDir": str(case.mineru_dir),
        "targetCount": len(targets),
        "cropCount": len([entry for entry in outputs if entry.get("cropPath")]),
        "contactSheet": str(case_dir / "contact_sheet.jpg"),
        "overlaySheet": str(case_dir / "overlay_sheet.jpg"),
        "figures": outputs,
    }
    (case_dir / "summary.json").write_text(json.dumps(result, indent=2))
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", type=Path)
    parser.add_argument("--mineru-dir", type=Path)
    parser.add_argument("--query", type=str, default="")
    parser.add_argument(
        "--pages",
        type=str,
        default="",
        help="1-based page numbers or ranges, for example 2,4-6.",
    )
    parser.add_argument("--crop-dir", type=Path)
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--attachment-id", type=int, default=0)
    parser.add_argument("--attachment-key", type=str, default="")
    parser.add_argument("--source-filename", type=str, default="")
    parser.add_argument(
        "--clean-out",
        action="store_true",
        help="Remove --out before direct extraction.",
    )
    parser.add_argument(
        "--use-mineru-targets",
        action="store_true",
        help="Opt into MinerU manifest/content-list figure targets for diagnostics.",
    )
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--seed", type=int, default=20260624)
    parser.add_argument("--dpi", type=int, default=220)
    parser.add_argument(
        "--max-pages",
        type=int,
        default=80,
        help="Skip PDFs with more pages than this. Use 0 to disable.",
    )
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--mineru-root", type=Path, default=DEFAULT_MINERU_ROOT)
    parser.add_argument("--zotero-storage", type=Path, default=DEFAULT_ZOTERO_STORAGE)
    parser.add_argument("--poppler-bin", type=Path, default=DEFAULT_POPPLER_BIN)
    parser.add_argument(
        "--include-storage-pdfs",
        action="store_true",
        help="Add Zotero storage PDFs even when they do not have a MinerU cache.",
    )
    parser.add_argument(
        "--case-id",
        action="append",
        type=int,
        default=[],
        help="Evaluate one attachment id. Repeat for multiple ids.",
    )
    args = parser.parse_args()

    if args.pdf or args.mineru_dir:
        if not args.pdf or not args.mineru_dir:
            parser.error("--pdf and --mineru-dir must be provided together")
        if not args.crop_dir:
            parser.error("--crop-dir is required in direct extraction mode")
        raise SystemExit(run_direct_mode(args))

    out_dir: Path = args.out
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    cases = load_cases(args.mineru_root, args.zotero_storage)
    if args.include_storage_pdfs:
        cases.extend(
            load_storage_pdf_cases(args.zotero_storage, cases, args.mineru_root),
        )
    if args.case_id:
        wanted = set(args.case_id)
        cases = [case for case in cases if case.attachment_id in wanted]
        cases.sort(key=lambda case: args.case_id.index(case.attachment_id))
        args.limit = len(cases)
    else:
        rng = random.Random(args.seed)
        rng.shuffle(cases)
    results: list[dict[str, Any]] = []
    for case in cases:
        if len(results) >= args.limit:
            break
        if args.max_pages > 0:
            page_count = pdf_page_count(case.pdf_path, args.poppler_bin)
            if page_count and page_count > args.max_pages:
                print(
                    f"[skip] {case.attachment_id} pages={page_count} "
                    f"{case.source_filename}",
                    flush=True,
                )
                continue
        try:
            result = evaluate_case(
                case,
                out_dir,
                args.poppler_bin,
                args.dpi,
                use_mineru_targets=bool(args.use_mineru_targets),
            )
        except Exception as error:
            result = {
                "attachmentId": case.attachment_id,
                "attachmentKey": case.attachment_key,
                "sourceFilename": case.source_filename,
                "pdfPath": str(case.pdf_path),
                "mineruDir": str(case.mineru_dir),
                "error": str(error),
            }
        if result and result.get("cropCount", 0) > 0:
            results.append(result)
            print(
                f"[{len(results):02d}/{args.limit}] "
                f"{case.attachment_id} {case.source_filename} "
                f"figures={result.get('cropCount')}",
                flush=True,
            )

    all_items: list[tuple[str, Path]] = []
    all_overlay_items: list[tuple[str, Path]] = []
    for result in results:
        for figure in result.get("figures", []):
            path = figure.get("cropPath")
            if path:
                all_items.append(
                    (
                        f"{result['attachmentId']} {figure['label']} p{figure['pageNumber']}",
                        Path(path),
                    )
                )
            overlay_path = figure.get("overlayPath")
            if overlay_path:
                all_overlay_items.append(
                    (
                        f"{result['attachmentId']} {figure['label']} p{figure['pageNumber']}",
                        Path(overlay_path),
                    )
                )
    make_contact_sheet(all_items, out_dir / "all_crops_contact_sheet.jpg", cols=5)
    make_contact_sheet(
        all_overlay_items,
        out_dir / "all_overlays_contact_sheet.jpg",
        thumb_h=430,
        cols=4,
    )
    (out_dir / "summary.json").write_text(json.dumps(results, indent=2))
    print(json.dumps(
        {
            "pdfCount": len(results),
            "figureCount": len(all_items),
            "summary": str(out_dir / "summary.json"),
            "contactSheet": str(out_dir / "all_crops_contact_sheet.jpg"),
            "overlaySheet": str(out_dir / "all_overlays_contact_sheet.jpg"),
        },
        indent=2,
    ))


if __name__ == "__main__":
    main()
