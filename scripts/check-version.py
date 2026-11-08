#!/usr/bin/env python3
"""Validate the release identity before any build or tag publication."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re

ROOT = Path(__file__).resolve().parent.parent
SEMVER = re.compile(
    r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?\Z"
)


def check_version(root, tag=None):
    version = (root / "VERSION").read_text(encoding="utf-8").strip()
    match = SEMVER.fullmatch(version)
    if not match or any(part.isdecimal() and len(part) > 1 and part.startswith("0")
                        for part in (match.group(4) or "").split(".")):
        raise ValueError("VERSION must contain one valid semantic version without a leading v")
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    with (root / "build/desktop/Info.plist").open("rb") as source:
        info = plistlib.load(source)
    if package.get("version") != version or info.get("ECaptureQVersion") != version:
        raise ValueError("VERSION, package.json and Info.plist ECaptureQVersion must match")
    if info.get("CFBundleShortVersionString") != ".".join(match.group(1, 2, 3)):
        raise ValueError("Info.plist numeric version must match VERSION's major.minor.patch")
    if tag is not None and tag != "v" + version:
        raise ValueError(f"Tag must be v{version}")
    return version, bool(match.group(4))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag")
    args = parser.parse_args()
    try:
        version, prerelease = check_version(ROOT, args.tag)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Version check failed: {error}\n")
    output = f"version={version}\nprerelease={str(prerelease).lower()}\n"
    print(output, end="")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as target:
            target.write(output)


if __name__ == "__main__":
    main()
