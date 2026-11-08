#!/usr/bin/env python3
"""Package an already-built eCaptureQ executable, never the entire build tree."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parent.parent
VERSION_PATTERN = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\Z")


def check_binary(binary, target_os, arch):
    metadata = subprocess.check_output(["go", "version", "-m", str(binary)], text=True)
    for key, value in (("GOOS", target_os), ("GOARCH", arch)):
        if not re.search(r"\b" + key + "=" + re.escape(value) + r"\s", metadata):
            raise ValueError(f"Binary does not contain expected {key}={value} build metadata")


def checksum(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    path.with_name(path.name + ".sha256").write_text(f"{digest.hexdigest()}  {path.name}\n", encoding="utf-8")


def zip_tree(stage, destination):
    # macOS ditto preserves signatures, stapled tickets, extended attributes and modes.
    if sys.platform == "darwin":
        subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(stage), str(destination)], check=True)
        return
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for source in sorted(stage.rglob("*")):
            archive.write(source, source.relative_to(stage.parent).as_posix())


def package(kind, target_os, arch, version, binary, output, dmg=False, signing="unsigned"):
    if not VERSION_PATTERN.fullmatch(version):
        raise ValueError("Version must be a semantic version without a leading v")
    if dmg and (kind != "desktop" or target_os != "darwin" or sys.platform != "darwin"):
        raise ValueError("--dmg requires a macOS host and macOS desktop package")
    if signing == "notarized" and (kind != "desktop" or target_os != "darwin"):
        raise ValueError("Notarized signing status is only supported for macOS desktop")
    binary = binary.resolve(strict=True)
    executable = binary / "Contents/MacOS/eCaptureQ" if kind == "desktop" and target_os == "darwin" else binary
    if not executable.is_file():
        raise ValueError(f"Built executable is missing: {executable}")
    check_binary(executable, target_os, arch)
    if signing == "notarized":
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(binary)], check=True)
        subprocess.run(["xcrun", "stapler", "validate", str(binary)], check=True)
    output.mkdir(parents=True, exist_ok=True)
    output = output.resolve()
    name = f"ecaptureq-{version}-{kind}-{target_os}-{arch}"
    results = []
    with tempfile.TemporaryDirectory(prefix="ecaptureq-package-") as temp:
        stage = Path(temp) / name
        stage.mkdir()
        for filename in ("LICENSE", "NOTICE", "README.md"):
            shutil.copy2(ROOT / filename, stage / filename)
        # The README shares the official UI logo; do not ship the frontend source tree.
        (stage / "frontend").mkdir()
        shutil.copy2(ROOT / "frontend/ecapture-logo.svg", stage / "frontend/ecapture-logo.svg")
        (stage / "config").mkdir()
        shutil.copy2(ROOT / "config/sources.example.json", stage / "config/sources.example.json")
        # Public documentation screenshots must accompany the README's relative links.
        shutil.copytree(ROOT / "docs", stage / "docs", ignore=shutil.ignore_patterns("*.log"))
        if binary.is_dir():
            for entry in binary.rglob("*"):
                if entry.is_symlink() and not entry.resolve().is_relative_to(binary):
                    raise ValueError("Application bundle contains a link outside the bundle")
            # ditto retains the notarization ticket; copytree does not preserve all macOS metadata.
            subprocess.run(["ditto", str(binary), str(stage / "eCaptureQ.app")], check=True)
        else:
            suffix = ".exe" if target_os == "windows" else ""
            filename = ("ecaptureq-server" if kind == "server" else "eCaptureQ") + suffix
            shutil.copy2(binary, stage / filename)
            if target_os != "windows":
                (stage / filename).chmod(0o755)
        try:
            commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, stderr=subprocess.DEVNULL).strip()
        except (OSError, subprocess.CalledProcessError):
            commit = "unknown"
        info = {"product": "eCaptureQ", "version": version, "kind": kind, "os": target_os,
                "arch": arch, "commit": commit, "signing": signing}
        (stage / "BUILD-INFO.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
        runtime = {"linux": "Desktop requires GTK4 and WebKitGTK 6.0 runtime libraries.",
                   "windows": "Desktop requires the Microsoft Edge WebView2 runtime.",
                   "darwin": "Desktop requires macOS 12 or newer; older versions have not been validated."}[target_os]
        (stage / "INSTALL.txt").write_text(
            f"eCaptureQ {version} ({kind}, {target_os}/{arch})\n\n"
            "Server: run ecaptureq-server --addr 127.0.0.1:28257 and open the address in your browser.\n"
            "Desktop: launch eCaptureQ; no separately started server is needed.\n"
            + runtime + "\nSigning status: " + signing + ".\n"
            "The source example contains placeholders. Configure your own remote eCapture endpoint.\n"
            "No collector, captured traffic or private settings are bundled. See README.md and docs/.\n",
            encoding="utf-8")
        extension = ".zip" if target_os in ("windows", "darwin") else ".tar.gz"
        archive = output / (name + extension)
        if extension == ".zip":
            zip_tree(stage, archive)
        else:
            with tarfile.open(archive, "w:gz") as bundle:
                bundle.add(stage, arcname=name, filter=lambda entry: normalized_tar_entry(entry))
        checksum(archive)
        results.append(archive)
        if dmg:
            # Keep the install shortcut out of the portable ZIP archive.
            (stage / "Applications").symlink_to("/Applications", target_is_directory=True)
            image = output / (name + ".dmg")
            subprocess.run(["hdiutil", "create", "-volname", f"eCaptureQ {version}", "-srcfolder", str(stage),
                            "-ov", "-format", "UDZO", str(image)], check=True)
            checksum(image)
            results.append(image)
    for result in results:
        print(result)
    return results


def normalized_tar_entry(entry):
    entry.uid = entry.gid = 0
    entry.uname = entry.gname = "root"
    return entry


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", choices=("server", "desktop"), required=True)
    parser.add_argument("--os", choices=("linux", "darwin", "windows"), required=True)
    parser.add_argument("--arch", choices=("amd64", "arm64"), required=True)
    parser.add_argument("--version", default=(ROOT / "VERSION").read_text().strip())
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "dist/packages")
    parser.add_argument("--dmg", action="store_true")
    parser.add_argument("--signing", choices=("unsigned", "notarized"), default="unsigned")
    args = parser.parse_args()
    if args.binary is None:
        if args.kind == "server":
            args.binary = ROOT / ("bin/ecaptureq-server.exe" if args.os == "windows" else "bin/ecaptureq-server")
        else:
            args.binary = ROOT / {"darwin": "dist/eCaptureQ.app", "windows": "dist/eCaptureQ.exe", "linux": "dist/eCaptureQ"}[args.os]
    try:
        package(args.kind, args.os, args.arch, args.version, args.binary, args.output, args.dmg, args.signing)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Packaging failed: {error}\n")


if __name__ == "__main__":
    main()
