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

from release_common import check_binary, package_name


ROOT = Path(__file__).resolve().parent.parent
VERSION_PATTERN = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\Z")


def check_macos_signature(bundle, signing, arch="universal"):
    """Validate every CPU slice, not only the current host architecture."""
    codes = (bundle / "Contents/MacOS/eCaptureQ", bundle) if bundle.is_dir() else (bundle,)
    arches = ("x86_64", "arm64") if arch == "universal" else (("x86_64",) if arch == "amd64" else ("arm64",))
    for code in codes:
        subprocess.run(["codesign", "--verify", "--all-architectures", "--deep", "--strict", str(code)], check=True)
        for cpu in arches:
            details = subprocess.check_output(
                ["codesign", "--display", "--arch", cpu, "--verbose=2", str(code)],
                text=True, stderr=subprocess.STDOUT,
            ).splitlines()
            adhoc = "Signature=adhoc" in details
            if signing == "adhoc" and not adhoc:
                raise ValueError("Requested ad-hoc package does not have an ad-hoc signature")
            if signing == "notarized" and (
                adhoc or not any(line.startswith("Authority=Developer ID Application:") for line in details)
            ):
                raise ValueError("Notarized package requires a Developer ID Application signature")
    if signing == "notarized":
        subprocess.run(["xcrun", "stapler", "validate", str(bundle)], check=True)


def linux_config(stage, kind, arch, version):
    """No install hooks, auto-start, private config or probe dependencies."""
    product = "ecaptureq" if kind == "desktop" else "ecaptureq-web"
    executable = "eCaptureQ" if kind == "desktop" else "ecaptureq-web"
    contents = [{"src": str(stage / executable), "dst": f"/usr/bin/{product}", "file_info": {"mode": 0o755}}]
    for source in sorted(stage.rglob("*")):
        if source.is_file() and source != stage / executable:
            contents.append({"src": str(source), "dst": f"/usr/share/doc/{product}/" + source.relative_to(stage).as_posix(),
                             "file_info": {"mode": 0o644}})
    for name in ("LICENSE", "NOTICE"):
        contents.append({"src": str(stage / name), "dst": f"/usr/share/licenses/{product}/{name}", "file_info": {"mode": 0o644}})
    config = {"name": product, "arch": arch, "platform": "linux", "version": version,
              "version_schema": "semver", "release": "1", "section": "net", "priority": "optional",
              "maintainer": "CFC4N <cfc4n.cs@gmail.com>", "vendor": "eCaptureQ",
              "homepage": "https://github.com/gojue/ecaptureQ", "license": "Apache-2.0",
              "description": "eCapture network protocol analysis " + ("application" if kind == "desktop" else "Web interface"),
              "contents": contents}
    if kind == "desktop":
        contents.extend([
            {"src": str(ROOT / "build/linux/ecaptureq.desktop"), "dst": "/usr/share/applications/ecaptureq.desktop", "file_info": {"mode": 0o644}},
            {"src": str(ROOT / "frontend/ecaptureq-logo.svg"), "dst": "/usr/share/icons/hicolor/scalable/apps/ecaptureq.svg", "file_info": {"mode": 0o644}},
        ])
        # Built on Ubuntu 24.04; do not promise compatibility with older C libraries.
        config["overrides"] = {
            "deb": {"depends": ["libc6 (>= 2.39)", "libgtk-4-1 (>= 4.14)", "libwebkitgtk-6.0-4 (>= 2.44)", "libglib2.0-0t64 (>= 2.80)"]},
            "rpm": {"depends": ["glibc >= 2.39", "gtk4 >= 4.14", "webkitgtk6.0 >= 2.44", "glib2 >= 2.80"]},
        }
    return config


def linux_packages(stage, output, kind, arch, version, formats):
    config_file = stage.parent / "nfpm.json"
    config_file.write_text(json.dumps(linux_config(stage, kind, arch, version), indent=2) + "\n")
    results = []
    for package_format in formats:
        destination = output / (stage.name + "." + package_format)
        subprocess.run(["nfpm", "package", "--config", str(config_file), "--packager", package_format,
                        "--target", str(destination)], check=True)
        checksum(destination)
        results.append(destination)
    return results


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


def package(kind, target_os, arch, version, binary, output, dmg=False, signing="unsigned", linux_format="archive"):
    name = package_name(kind, target_os, arch, version)
    if linux_format not in ("archive", "all", "deb", "rpm"):
        raise ValueError("Unknown Linux package format")
    if not VERSION_PATTERN.fullmatch(version):
        raise ValueError("Version must be a semantic version without a leading v")
    if dmg and (kind != "desktop" or target_os != "darwin" or sys.platform != "darwin"):
        raise ValueError("--dmg requires a macOS host and macOS desktop package")
    if signing not in ("unsigned", "adhoc", "notarized"):
        raise ValueError("Unknown signing status")
    if signing != "unsigned" and (target_os != "darwin" or (signing == "notarized" and kind != "desktop")):
        raise ValueError("Notarized signing is only supported for macOS desktop; ad-hoc requires macOS")
    if signing != "unsigned" and sys.platform != "darwin":
        raise ValueError("Verify signed macOS desktop packages on a macOS host")
    binary = binary.resolve(strict=True)
    executable = binary / "Contents/MacOS/eCaptureQ" if kind == "desktop" and target_os == "darwin" else binary
    if not executable.is_file():
        raise ValueError(f"Built executable is missing: {executable}")
    check_binary(executable, target_os, arch)
    if signing != "unsigned":
        check_macos_signature(binary, signing, arch)
    output.mkdir(parents=True, exist_ok=True)
    output = output.resolve()
    results = []
    with tempfile.TemporaryDirectory(prefix="ecaptureq-package-") as temp:
        stage = Path(temp) / name
        stage.mkdir()
        for filename in ("LICENSE", "NOTICE", "README.md"):
            shutil.copy2(ROOT / filename, stage / filename)
        # The README shares the official UI logo; do not ship the frontend source tree.
        (stage / "frontend").mkdir()
        shutil.copy2(ROOT / "frontend/ecaptureq-logo.svg", stage / "frontend/ecaptureq-logo.svg")
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
            if signing != "unsigned":
                check_macos_signature(stage / "eCaptureQ.app", signing, arch)
        else:
            suffix = ".exe" if target_os == "windows" else ""
            filename = ("ecaptureq-web" if kind == "server" else "eCaptureQ") + suffix
            shutil.copy2(binary, stage / filename)
            if target_os != "windows":
                (stage / filename).chmod(0o755)
        try:
            commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, stderr=subprocess.DEVNULL).strip()
        except (OSError, subprocess.CalledProcessError):
            commit = "unknown"
        info = {"product": "eCaptureQ", "version": version, "kind": kind, "os": target_os,
                "arch": arch, "commit": commit, "signing": signing, "notarized": signing == "notarized"}
        if arch == "universal":
            info["architectures"] = ["amd64", "arm64"]
        (stage / "BUILD-INFO.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
        runtime = {"linux": "Desktop requires GTK4 and WebKitGTK 6.0 runtime libraries.",
                   "windows": "Desktop requires the Microsoft Edge WebView2 runtime.",
                   "darwin": "Desktop requires macOS 12 or newer; older versions have not been validated."}[target_os]
        if kind == "server":
            runtime = "Web interface: no desktop GUI libraries or separate collector executable are bundled."
        signing_help = ""
        if signing == "adhoc":
            signing_help = (
                "This app is ad-hoc signed, without an Apple-certified developer identity, "
                "and has NOT been notarized by Apple.\n"
                "If macOS blocks the first launch, verify the download source and checksum, then use "
                "System Settings > Privacy & Security > Open Anyway for this app.\n"
            )
        product_title = "eCaptureQ Web" if kind == "server" else "eCaptureQ"
        system_title = "macOS" if target_os == "darwin" else target_os
        (stage / "INSTALL.txt").write_text(
            f"{product_title} {version} ({system_title}/{arch})\n\n" +
            ("Web: run ecaptureq-web --addr 127.0.0.1:28257 and open the address in your browser.\n"
             if kind == "server" else "Open eCaptureQ from your applications menu; no separately started server is needed.\n")
            + runtime + "\nSigning status: " + signing + ".\n" + signing_help +
            "The source example contains placeholders. Configure your own remote eCapture endpoint.\n"
            "No collector, captured traffic or private settings are bundled. See README.md and docs/.\n",
            encoding="utf-8")
        if target_os == "linux" and linux_format != "archive":
            formats = ("deb", "rpm") if linux_format == "all" else (linux_format,)
            results.extend(linux_packages(stage, output, kind, arch, version, formats))
        else:
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
    parser.add_argument("--arch", choices=("amd64", "arm64", "loong64", "universal"), required=True)
    parser.add_argument("--version", default=(ROOT / "VERSION").read_text().strip())
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "dist/packages")
    parser.add_argument("--linux-format", choices=("all", "deb", "rpm", "archive"), default="all")
    parser.add_argument("--dmg", action="store_true")
    parser.add_argument("--signing", choices=("unsigned", "adhoc", "notarized"), default="unsigned")
    args = parser.parse_args()
    if args.binary is None:
        if args.kind == "server":
            args.binary = ROOT / ("bin/ecaptureq-web.exe" if args.os == "windows" else "bin/ecaptureq-web")
        else:
            args.binary = ROOT / {"darwin": "dist/eCaptureQ.app", "windows": "dist/eCaptureQ.exe", "linux": "dist/eCaptureQ"}[args.os]
    try:
        package(args.kind, args.os, args.arch, args.version, args.binary, args.output, args.dmg, args.signing, args.linux_format)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Packaging failed: {error}\n")


if __name__ == "__main__":
    main()
