"""Shared distribution identity and Go/Mach-O validation (no GUI dependencies)."""
from pathlib import Path
import re
import subprocess
import tempfile

MAC_ARCHES = {"amd64": "x86_64", "arm64": "arm64"}


def package_name(kind, target_os, arch, version):
    if kind not in ("desktop", "server") or target_os not in ("linux", "windows", "darwin"):
        raise ValueError("Unsupported package target")
    if arch not in ("amd64", "arm64", "loong64", "universal") or (arch == "universal" and target_os != "darwin"):
        raise ValueError("Universal packages require macOS")
    if arch == "loong64" and target_os != "linux":
        raise ValueError("loong64 packages are only available for Linux")
    if arch == "loong64" and kind == "desktop":
        raise ValueError("loong64 desktop packages are not supported")
    product = "ecaptureq" if kind == "desktop" else "ecaptureq-web"
    return f"{product}-{version}-{'macos' if target_os == 'darwin' else target_os}-{arch}"


def check_thin_binary(binary, target_os, arch):
    metadata = subprocess.check_output(["go", "version", "-m", str(binary)], text=True)
    for key, value in (("GOOS", target_os), ("GOARCH", arch)):
        if not re.search(r"\b" + key + "=" + re.escape(value) + r"\s", metadata):
            raise ValueError(f"Binary does not contain expected {key}={value} build metadata")


def check_binary(binary, target_os, arch):
    if arch != "universal":
        check_thin_binary(binary, target_os, arch)
        return
    if target_os != "darwin":
        raise ValueError("Universal packages require macOS")
    arches = subprocess.check_output(["lipo", "-archs", str(binary)], text=True).split()
    if len(arches) != 2 or set(arches) != set(MAC_ARCHES.values()):
        raise ValueError("Universal binary must contain exactly x86_64 and arm64")
    with tempfile.TemporaryDirectory(prefix="ecaptureq-slices-") as temp:
        for go_arch, mac_arch in MAC_ARCHES.items():
            thin = Path(temp) / go_arch
            subprocess.run(["lipo", str(binary), "-thin", mac_arch, "-output", str(thin)], check=True)
            check_thin_binary(thin, "darwin", go_arch)
