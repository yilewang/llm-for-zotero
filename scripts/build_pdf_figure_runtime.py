#!/usr/bin/env python3
"""Build a managed PDF figure extraction runtime ZIP.

The plugin installs these ZIPs under the user's Zotero data directory and
validates them with src/agent/services/pdfFigureRuntimeService.ts.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import zipfile
from pathlib import Path
from typing import Iterable


RUNTIME_KIND = "llm-for-zotero/pdf-figure-runtime"
VALID_PLATFORMS = {
    "macos-arm64",
    "macos-x64",
    "linux-arm64",
    "linux-x64",
    "windows-arm64",
    "windows-x64",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Package a conda/micromamba environment as a PDF figure runtime."
    )
    parser.add_argument(
        "--env-dir",
        required=True,
        type=Path,
        help="Runtime environment directory to package.",
    )
    parser.add_argument(
        "--platform",
        required=True,
        choices=sorted(VALID_PLATFORMS),
        help="Plugin platform key, such as macos-arm64 or linux-x64.",
    )
    parser.add_argument(
        "--version",
        required=True,
        help="Runtime version expected by PDF_FIGURE_RUNTIME_VERSION.",
    )
    parser.add_argument(
        "--out-dir",
        required=True,
        type=Path,
        help="Directory where the runtime ZIP should be written.",
    )
    return parser.parse_args()


def relative_path(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def is_inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def first_existing(root: Path, candidates: Iterable[str]) -> str:
    for candidate in candidates:
        if (root / candidate).exists():
            return candidate
    raise FileNotFoundError(
        "Could not find any expected path: " + ", ".join(candidates)
    )


def runtime_layout(env_dir: Path, platform_key: str) -> tuple[str, str, list[str]]:
    windows = platform_key.startswith("windows")
    exe = ".exe" if windows else ""
    python_path = first_existing(
        env_dir,
        ["python.exe", "bin/python3", "bin/python", "bin/python3.11"],
    )
    poppler_bin_dir = "Library/bin" if windows else "bin"
    required_poppler = [
        f"{poppler_bin_dir}/pdftoppm{exe}",
        f"{poppler_bin_dir}/pdftohtml{exe}",
        f"{poppler_bin_dir}/pdfinfo{exe}",
    ]
    for required in required_poppler:
        if not (env_dir / required).exists():
            raise FileNotFoundError(f"Required Poppler executable is missing: {required}")
    return python_path, poppler_bin_dir, [python_path, *required_poppler]


def should_skip(relative: str) -> bool:
    parts = relative.split("/")
    if "__pycache__" in parts:
        return True
    if relative.endswith((".pyc", ".pyo")):
        return True
    if parts[0] == "pkgs":
        return True
    return False


def zip_info_for(relative: str, source: Path) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(relative)
    mode = stat.S_IMODE(source.stat().st_mode)
    if source.is_dir():
        mode = 0o755
    info.external_attr = mode << 16
    return info


def add_file(zip_file: zipfile.ZipFile, source: Path, relative: str) -> None:
    if should_skip(relative):
        return
    actual_source = source
    if source.is_symlink():
        actual_source = source.resolve(strict=True)
    if not actual_source.is_file():
        return
    info = zip_info_for(relative, actual_source)
    with actual_source.open("rb") as file:
        zip_file.writestr(info, file.read(), compress_type=zipfile.ZIP_DEFLATED)


def add_directory_tree(
    zip_file: zipfile.ZipFile,
    source_dir: Path,
    archive_prefix: str,
    env_root: Path,
) -> None:
    source_dir = source_dir.resolve(strict=True)
    if not is_inside(source_dir, env_root):
        raise ValueError(f"Refusing to package symlink outside env: {source_dir}")
    for current_root, dir_names, file_names in os.walk(source_dir):
        current = Path(current_root)
        relative_root = Path(archive_prefix) / current.relative_to(source_dir)
        for name in file_names:
            source = current / name
            relative = (relative_root / name).as_posix()
            add_file(zip_file, source, relative)
        for name in list(dir_names):
            child = current / name
            if child.is_symlink():
                target = child.resolve(strict=True)
                relative = (relative_root / name).as_posix()
                if target.is_dir():
                    add_directory_tree(zip_file, target, relative, env_root)
                elif target.is_file():
                    add_file(zip_file, child, relative)
                dir_names.remove(name)


def add_env_contents(zip_file: zipfile.ZipFile, env_dir: Path) -> None:
    env_root = env_dir.resolve(strict=True)
    for current_root, dir_names, file_names in os.walk(env_root):
        current = Path(current_root)
        for name in file_names:
            source = current / name
            relative = relative_path(source, env_root)
            if relative == "runtime.json":
                continue
            add_file(zip_file, source, relative)
        for name in list(dir_names):
            child = current / name
            if child.is_symlink():
                target = child.resolve(strict=True)
                relative = relative_path(child, env_root)
                if target.is_dir():
                    add_directory_tree(zip_file, target, relative, env_root)
                elif target.is_file():
                    add_file(zip_file, child, relative)
                dir_names.remove(name)


def main() -> None:
    args = parse_args()
    env_dir = args.env_dir.resolve(strict=True)
    python_path, poppler_bin_dir, executable_paths = runtime_layout(
        env_dir, args.platform
    )
    manifest = {
        "kind": RUNTIME_KIND,
        "version": args.version,
        "platform": args.platform,
        "pythonPath": python_path,
        "popplerBinDir": poppler_bin_dir,
        "executablePaths": executable_paths,
    }
    args.out_dir.mkdir(parents=True, exist_ok=True)
    zip_path = (
        args.out_dir
        / f"llm-for-zotero-pdf-figure-runtime-v{args.version}-{args.platform}.zip"
    )
    with zipfile.ZipFile(zip_path, "w", allowZip64=True) as zip_file:
        zip_file.writestr(
            "runtime.json",
            json.dumps(manifest, indent=2, sort_keys=True).encode("utf-8"),
            compress_type=zipfile.ZIP_DEFLATED,
        )
        add_env_contents(zip_file, env_dir)
    print(zip_path)


if __name__ == "__main__":
    main()
