#!/usr/bin/env python3
"""Combine matching Intel/Apple Silicon builds; sign only after merging."""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys

from release_common import check_binary


def resource_manifest(bundle):
    result = {}
    for path in bundle.rglob('*'):
        relative = path.relative_to(bundle).as_posix()
        if relative == 'Contents/MacOS/eCaptureQ' or relative.startswith('Contents/_CodeSignature/'):
            continue
        if path.is_symlink():
            raise ValueError('Unexpected symlink in input bundle')
        if path.is_file():
            result[relative] = path.read_bytes()
    return result


def merge(amd64, arm64, output):
    if sys.platform != 'darwin':
        raise ValueError('Merge macOS binaries on a macOS host with Xcode')
    if output.exists():
        raise ValueError('Output already exists; choose a fresh output path')
    bundle = amd64.is_dir()
    if bundle != arm64.is_dir():
        raise ValueError('Both inputs must be apps or both must be executable files')
    if bundle and resource_manifest(amd64) != resource_manifest(arm64):
        raise ValueError('App resources and version metadata must match between architectures')
    relative = Path('Contents/MacOS/eCaptureQ') if bundle else None
    inputs = [path / relative if bundle else path for path in (amd64, arm64)]
    for binary, arch in zip(inputs, ('amd64', 'arm64')):
        check_binary(binary, 'darwin', arch)
    output.parent.mkdir(parents=True, exist_ok=True)
    if bundle:
        subprocess.run(['ditto', str(arm64), str(output)], check=True)
        shutil.rmtree(output / 'Contents/_CodeSignature', ignore_errors=True)
    target = output / relative if bundle else output
    subprocess.run(['lipo', '-create', *map(str, inputs), '-output', str(target)], check=True)
    target.chmod(0o755)
    check_binary(target, 'darwin', 'universal')
    print(f'Merged x86_64 + arm64: {output}; sign this final output before packaging.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('amd64', 'arm64', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    try:
        merge(args.amd64, args.arm64, args.output)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Merge failed: {error}\n')


if __name__ == '__main__':
    main()
