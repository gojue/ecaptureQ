#!/usr/bin/env python3
"""Validate complete distributions; publish one checksum manifest, not sidecars."""
import argparse
import hashlib
from pathlib import Path
import shutil

from release_common import package_name

ROOT = Path(__file__).resolve().parent.parent


def expected_packages(version):
    packages = set()
    for kind in ('desktop', 'server'):
        for arch in ('amd64', 'arm64'):
            packages.add(package_name(kind, 'windows', arch, version) + '.zip')
            for extension in ('.deb', '.rpm'):
                packages.add(package_name(kind, 'linux', arch, version) + extension)
        packages.add(package_name(kind, 'darwin', 'universal', version) + '.zip')
    packages.add(package_name('desktop', 'darwin', 'universal', version) + '.dmg')
    return packages


def collect(directory, version, release_dir=None):
    expected = expected_packages(version)
    sidecars = {name + '.sha256' for name in expected}
    actual = {path.name for path in directory.iterdir()}
    has_sidecars = bool(actual & sidecars)
    required = expected | (sidecars if has_sidecars else {'SHA256SUMS'})
    allowed = expected | sidecars | {'SHA256SUMS'}
    missing, extra = required - actual, actual - allowed
    if missing or extra:
        raise ValueError(f'Incomplete or unexpected release assets: missing={sorted(missing)}, extra={sorted(extra)}')
    lines = []
    for name in sorted(expected):
        path = directory / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f'Invalid release artifact: {name}')
        digest = hashlib.sha256()
        with path.open('rb') as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(block)
        line = f'{digest.hexdigest()}  {name}\n'
        if has_sidecars:
            sidecar = directory / (name + '.sha256')
            if sidecar.is_symlink() or sidecar.read_text(encoding='utf-8') != line:
                raise ValueError(f'Checksum mismatch: {name}')
        lines.append(line)
    manifest = ''.join(lines)
    sums = directory / 'SHA256SUMS'
    if sums.is_symlink() or (sums.exists() and sums.read_text(encoding='utf-8') != manifest):
        raise ValueError('Checksum mismatch: SHA256SUMS')
    sums.write_text(manifest, encoding='utf-8')
    if release_dir is not None:
        if release_dir.resolve() == directory.resolve() or (release_dir.exists() and any(release_dir.iterdir())):
            raise ValueError('Use a separate empty release output directory')
        release_dir.mkdir(parents=True, exist_ok=True)
        for name in sorted(expected | {'SHA256SUMS'}):
            shutil.copy2(directory / name, release_dir / name)
    return len(expected)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--release-dir', type=Path)
    args = parser.parse_args()
    try:
        count = collect(args.directory, (ROOT / 'VERSION').read_text().strip(), args.release_dir)
    except (OSError, ValueError) as error:
        parser.exit(1, f'Release verification failed: {error}\n')
    print(f'Verified {count} packages and SHA256SUMS')


if __name__ == '__main__':
    main()
