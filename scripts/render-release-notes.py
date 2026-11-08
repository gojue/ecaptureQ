#!/usr/bin/env python3
"""Put desktop downloads first and Web deployments in an optional section."""
import argparse
from pathlib import Path
import re

from release_common import package_name

ROOT = Path(__file__).resolve().parent.parent


def render(version, repository, template):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Invalid repository name')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', version):
        raise ValueError('Invalid release version')
    if template.count('<!-- downloads -->') != 1:
        raise ValueError('Release notes require exactly one downloads placeholder')
    base = f'https://github.com/{repository}/releases/download/v{version}/'
    def link(label, kind, target_os, arch, extension):
        return f'[{label}]({base}{package_name(kind, target_os, arch, version)}.{extension})'
    tables = []
    for kind in ('desktop', 'server'):
        if kind == 'server':
            tables.append('<details>\n<summary>eCaptureQ Web — browser deployment</summary>\n')
        else:
            tables.append('### Download eCaptureQ\n')
        tables.extend(['| System | Intel / AMD64 | ARM64 |', '| --- | --- | --- |'])
        mac = link('Universal ZIP', kind, 'darwin', 'universal', 'zip')
        if kind == 'desktop':
            mac = link('Universal DMG', kind, 'darwin', 'universal', 'dmg') + ' · ' + mac
        tables.append(f'| macOS | {mac} | Same universal download |')
        win = [link('ZIP', kind, 'windows', arch, 'zip') for arch in ('amd64', 'arm64')]
        tables.append(f'| Windows | {win[0]} | {win[1]} |')
        for label, extension in (('Ubuntu / Debian', 'deb'), ('Fedora', 'rpm')):
            linux = [link(extension.upper(), kind, 'linux', arch, extension) for arch in ('amd64', 'arm64')]
            tables.append(f'| Linux ({label}) | {linux[0]} | {linux[1]} |')
        tables.append('')
        if kind == 'server':
            tables.append('</details>\n')
    tables.append(f'[SHA256SUMS]({base}SHA256SUMS)\n')
    return template.replace('<!-- downloads -->', '\n'.join(tables))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', default='gojue/ecaptureQ')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    content = render((ROOT / 'VERSION').read_text().strip(), args.repo, (ROOT / 'docs/release-notes.md').read_text())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(content, encoding='utf-8')


if __name__ == '__main__':
    main()
