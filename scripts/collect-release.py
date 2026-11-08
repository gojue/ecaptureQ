#!/usr/bin/env python3
"""Require every distribution target and verify hashes before publication."""
import argparse
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def expected_packages(version):
    packages = set()
    for kind in ("server", "desktop"):
        for target_os in ("linux", "darwin", "windows"):
            for arch in ("amd64", "arm64"):
                stem = f"ecaptureq-{version}-{kind}-{target_os}-{arch}"
                packages.add(stem + (".tar.gz" if target_os == "linux" else ".zip"))
                if kind == "desktop" and target_os == "darwin":
                    packages.add(stem + ".dmg")
    return packages


def collect(directory, version):
    expected = expected_packages(version)
    allowed = expected | {name + ".sha256" for name in expected} | {"SHA256SUMS"}
    actual = {path.name for path in directory.iterdir()}
    missing = (expected | {name + ".sha256" for name in expected}) - actual
    extra = actual - allowed
    if missing or extra:
        raise ValueError(f"Incomplete or unexpected release assets: missing={sorted(missing)}, extra={sorted(extra)}")
    lines = []
    for name in sorted(expected):
        path = directory / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"Invalid release artifact: {name}")
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
        line = f"{digest.hexdigest()}  {name}\n"
        if (directory / (name + ".sha256")).read_text(encoding="utf-8") != line:
            raise ValueError(f"Checksum mismatch: {name}")
        lines.append(line)
    (directory / "SHA256SUMS").write_text("".join(lines), encoding="utf-8")
    return len(expected)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        count = collect(args.directory, (ROOT / "VERSION").read_text(encoding="utf-8").strip())
    except (OSError, ValueError) as error:
        parser.exit(1, f"Release verification failed: {error}\n")
    print(f"Verified {count} packages; wrote SHA256SUMS")


if __name__ == "__main__":
    main()
