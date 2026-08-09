#!/usr/bin/env python3
"""Fetch pinned Pybricks Code sources and prepare the HackyLens IDE tree."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
DEPS = ROOT / "_deps"
DOWNLOADS = DEPS / "downloads"
UPSTREAM = DEPS / "pybricks-code-upstream"
OVERLAY = ROOT / "ide" / "pybricks-code-overlay"
WORKTREE = ROOT / "build" / "hackylens-code"
PACKAGE_OVERRIDES = "package-overrides.json"

REPOSITORY = "pybricks/pybricks-code"
REVISION = "ea9af98d1fd0a842ed76d3a7f83767f363bc1b17"
TREE_URL = f"https://api.github.com/repos/{REPOSITORY}/git/trees/{REVISION}?recursive=1"
RAW_ROOT = f"https://raw.githubusercontent.com/{REPOSITORY}/{REVISION}/"
TREE_CACHE = DOWNLOADS / f"pybricks-code-{REVISION}.tree.json"
MARKER = UPSTREAM / ".hackylens-upstream.json"
USER_AGENT = "HackyLens-IDE-bootstrap/1"

# HackyLens replaces the LEGO firmware/Bluetooth backend. These 63 MiB of
# device firmware and instructional video are unreachable from its entrypoint.
OMITTED_ASSET_SUFFIXES = {".bin", ".mp4"}
OMITTED_ASSET_PREFIXES = (
    "src/firmware/assets/",
    "src/firmware/bootloaderInstructions/assets/",
)


def request_bytes(url: str, attempts: int = 5) -> bytes:
    error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = Request(
                url,
                headers={
                    "Accept": "application/vnd.github+json",
                    "User-Agent": USER_AGENT,
                },
            )
            with urlopen(request, timeout=90) as response:
                return response.read()
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            error = exc
            if attempt + 1 < attempts:
                time.sleep(min(8.0, 0.5 * (2**attempt)))
    raise RuntimeError(f"download failed after {attempts} attempts: {url}: {error}")


def git_blob_sha(data: bytes) -> str:
    header = f"blob {len(data)}\0".encode("ascii")
    return hashlib.sha1(header + data).hexdigest()


def safe_relative_path(value: str) -> Path:
    posix = PurePosixPath(value)
    if posix.is_absolute() or not posix.parts or ".." in posix.parts:
        raise RuntimeError(f"unsafe upstream path: {value!r}")
    if any("\\" in part for part in posix.parts):
        raise RuntimeError(f"unsafe upstream path separator: {value!r}")
    return Path(*posix.parts)


def load_tree(offline: bool) -> dict[str, Any]:
    if not TREE_CACHE.is_file():
        if offline:
            raise RuntimeError(f"offline tree cache missing: {TREE_CACHE}")
        TREE_CACHE.parent.mkdir(parents=True, exist_ok=True)
        payload = request_bytes(TREE_URL)
        temporary = TREE_CACHE.with_suffix(".json.part")
        temporary.write_bytes(payload)
        temporary.replace(TREE_CACHE)
    try:
        tree = json.loads(TREE_CACHE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"invalid Pybricks tree cache: {exc}") from exc
    if tree.get("sha") != REVISION or tree.get("truncated") is not False:
        raise RuntimeError("Pybricks tree cache is not the complete pinned revision")
    if not isinstance(tree.get("tree"), list):
        raise RuntimeError("Pybricks tree cache has no entries")
    return tree


def omitted_asset(path: str, with_lego_assets: bool) -> bool:
    if with_lego_assets:
        return False
    return path.startswith(OMITTED_ASSET_PREFIXES) and Path(path).suffix.lower() in OMITTED_ASSET_SUFFIXES


def verified(path: Path, size: int, sha: str) -> bool:
    if not path.is_file() or path.stat().st_size != size:
        return False
    return git_blob_sha(path.read_bytes()) == sha


def prune_upstream(expected: set[Path]) -> int:
    """Remove cache entries that are not blobs from the selected revision.

    ``actions/cache`` restores the whole ``_deps`` directory.  A cache made by
    an older bootstrap script can therefore contain files that are absent from
    the pinned Git tree.  Since the prepared worktree is a directory copy,
    leaving those files in place would make its contents depend on cache
    history rather than solely on ``REVISION``.
    """
    if not UPSTREAM.exists():
        return 0
    if not UPSTREAM.is_dir() or UPSTREAM.is_symlink():
        raise RuntimeError(f"unexpected upstream cache path: {UPSTREAM}")

    expected_files = {path for path in expected}
    expected_files.add(Path(MARKER.name))
    removed = 0
    for path in sorted(
        UPSTREAM.rglob("*"),
        key=lambda item: len(item.relative_to(UPSTREAM).parts),
        reverse=True,
    ):
        relative = path.relative_to(UPSTREAM)
        if path.is_symlink():
            path.unlink()
            removed += 1
        elif path.is_file():
            if relative not in expected_files:
                path.unlink()
                removed += 1
        elif path.is_dir():
            try:
                path.rmdir()
            except OSError:
                pass
        else:
            raise RuntimeError(f"unexpected upstream cache entry: {path}")
    if removed:
        print(f"[IDE] pruned {removed} stale upstream cache entries")
    return removed


def fetch_blob(entry: dict[str, Any], offline: bool) -> tuple[str, bool]:
    relative = safe_relative_path(str(entry["path"]))
    destination = UPSTREAM / relative
    size = int(entry["size"])
    sha = str(entry["sha"])
    if verified(destination, size, sha):
        return str(relative), False
    if offline:
        raise RuntimeError(f"offline blob missing or invalid: {relative}")
    url = RAW_ROOT + quote(PurePosixPath(str(entry["path"])).as_posix(), safe="/")
    data = request_bytes(url)
    if len(data) != size or git_blob_sha(data) != sha:
        raise RuntimeError(f"blob verification failed: {relative}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".part")
    temporary.write_bytes(data)
    temporary.replace(destination)
    return str(relative), True


def fetch_upstream(tree: dict[str, Any], offline: bool,
                   with_lego_assets: bool, jobs: int) -> None:
    entries = [
        entry for entry in tree["tree"]
        if entry.get("type") == "blob"
        and not omitted_asset(str(entry.get("path", "")), with_lego_assets)
    ]
    expected_paths = {
        safe_relative_path(str(entry["path"])) for entry in entries
    }
    prune_upstream(expected_paths)
    expected = sum(int(entry["size"]) for entry in entries)
    UPSTREAM.mkdir(parents=True, exist_ok=True)
    downloaded = 0
    completed = 0
    print(f"[IDE] verify/fetch {len(entries)} blobs ({expected} bytes)")
    with ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
        futures = {
            pool.submit(fetch_blob, entry, offline): entry
            for entry in entries
        }
        for future in as_completed(futures):
            path, changed = future.result()
            completed += 1
            downloaded += int(futures[future]["size"]) if changed else 0
            if changed and (completed % 20 == 0 or completed == len(entries)):
                print(f"[IDE] {completed}/{len(entries)} blobs, downloaded {downloaded} bytes")
    marker = {
        "repository": f"https://github.com/{REPOSITORY}",
        "revision": REVISION,
        "profile": "hackylens-source",
        "verified_blobs": len(entries),
        "verified_bytes": expected,
        "omitted": [
            "src/firmware/assets/*.bin",
            "src/firmware/bootloaderInstructions/assets/*.mp4",
        ] if not with_lego_assets else [],
    }
    MARKER.write_text(json.dumps(marker, indent=2) + "\n", encoding="utf-8")


def remove_generated_worktree() -> None:
    resolved = WORKTREE.resolve()
    build_root = (ROOT / "build").resolve()
    if resolved.parent != build_root or resolved.name != "hackylens-code":
        raise RuntimeError(f"refusing to replace unexpected IDE path: {resolved}")
    if WORKTREE.exists():
        shutil.rmtree(WORKTREE)


def prepare_worktree() -> None:
    if not OVERLAY.is_dir():
        raise RuntimeError(f"HackyLens IDE overlay missing: {OVERLAY}")
    remove_generated_worktree()
    shutil.copytree(
        UPSTREAM,
        WORKTREE,
        ignore=shutil.ignore_patterns(".git", "*.part", ".hackylens-upstream.json"),
    )
    shutil.copytree(OVERLAY, WORKTREE, dirs_exist_ok=True)
    shutil.copy2(MARKER, WORKTREE / "HACKYLENS_UPSTREAM.json")
    overrides_path = WORKTREE / PACKAGE_OVERRIDES
    if overrides_path.is_file():
        try:
            package = json.loads((WORKTREE / "package.json").read_text(encoding="utf-8"))
            overrides = json.loads(overrides_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"invalid IDE package override: {exc}") from exc
        if not isinstance(package, dict) or not isinstance(overrides, dict):
            raise RuntimeError("IDE package override must contain JSON objects")
        # Only metadata and commands are overridden. Dependencies stay pinned to
        # the upstream yarn.lock so `yarn install --immutable` remains meaningful.
        forbidden = {"dependencies", "devDependencies", "resolutions", "packageManager"}
        if forbidden.intersection(overrides):
            raise RuntimeError("IDE package override may not change pinned dependencies")
        package.update(overrides)
        (WORKTREE / "package.json").write_text(
            json.dumps(package, indent=4) + "\n", encoding="utf-8"
        )
        overrides_path.unlink()
    if not (WORKTREE / "LICENSE").is_file():
        raise RuntimeError("prepared IDE lost the upstream MIT license")
    print(f"[IDE] prepared {WORKTREE}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true",
                        help="verify cached blobs without network access")
    parser.add_argument("--fetch-only", action="store_true",
                        help="do not create build/hackylens-code")
    parser.add_argument("--with-lego-assets", action="store_true",
                        help="also fetch unused LEGO firmware/video blobs")
    parser.add_argument("--jobs", type=int, default=8)
    args = parser.parse_args()
    if args.jobs < 1 or args.jobs > 32:
        parser.error("--jobs must be between 1 and 32")
    tree = load_tree(args.offline)
    fetch_upstream(tree, args.offline, args.with_lego_assets, args.jobs)
    if not args.fetch_only:
        prepare_worktree()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
