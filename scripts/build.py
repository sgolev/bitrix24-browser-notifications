#!/usr/bin/env python3
"""Assembles the browser extensions from the shared sources.

    python3 scripts/build.py [chromium|firefox|all] [--package]

For each target, copies src/ plus platforms/<target>/manifest.json into
build/<target>/ (an unpacked extension you can load in the browser, with the
unit tests under tests/). With --package, also writes the store upload
dist/bitrix24-notifications-<target>-<version>.zip (without tests).
"""

import argparse
import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'
TESTS = ROOT / 'tests'
BUILD = ROOT / 'build'
DIST = ROOT / 'dist'
TARGETS = ('chromium', 'firefox')

# Shared files a target does not use.
EXCLUDE = {
    'chromium': set(),
    'firefox': {'offscreen'},  # Firefox has no offscreen documents; sockets live in the background page
}
IGNORED = shutil.ignore_patterns('.DS_Store', '*~', '*.swp')


def fail(message):
    sys.exit(f'build.py: {message}')


def load_manifest(target):
    path = ROOT / 'platforms' / target / 'manifest.json'
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as e:
        fail(f'cannot read {path.relative_to(ROOT)}: {e}')


def manifest_files(manifest):
    """Extension files a manifest refers to (to catch broken paths before loading)."""
    files = set(manifest.get('icons', {}).values())
    background = manifest.get('background', {})
    files.update(background.get('scripts', []))
    if 'service_worker' in background:
        files.add(background['service_worker'])
    action = manifest.get('action', {})
    files.update(action.get('default_icon', {}).values())
    if 'default_popup' in action:
        files.add(action['default_popup'])
    if 'options_ui' in manifest:
        files.add(manifest['options_ui']['page'])
    return files


def build(target, manifest):
    out = BUILD / target
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(SRC, out, ignore=shutil.ignore_patterns(*EXCLUDE[target], '.DS_Store', '*~', '*.swp'))
    shutil.copytree(TESTS, out / 'tests', ignore=IGNORED)
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    missing = sorted(f for f in manifest_files(manifest) if not (out / f).is_file())
    if missing:
        fail(f'{target}: manifest refers to missing files: {", ".join(missing)}')
    return out


def package(target, out, version):
    DIST.mkdir(exist_ok=True)
    archive = DIST / f'bitrix24-notifications-{target}-{version}.zip'
    archive.unlink(missing_ok=True)
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
        for path in sorted(out.rglob('*')):
            rel = path.relative_to(out)
            if path.is_file() and rel.parts[0] != 'tests':
                z.write(path, rel.as_posix())
    return archive


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('target', nargs='?', default='all', choices=(*TARGETS, 'all'))
    parser.add_argument('--package', action='store_true', help='also write store ZIPs to dist/')
    args = parser.parse_args()

    manifests = {t: load_manifest(t) for t in TARGETS}
    versions = {t: m.get('version') for t, m in manifests.items()}
    if len(set(versions.values())) != 1:
        fail(f'manifest versions differ: {versions}')

    for target in TARGETS if args.target == 'all' else (args.target,):
        out = build(target, manifests[target])
        print(f'{target}: {out.relative_to(ROOT)}/')
        if args.package:
            print(f'{target}: {package(target, out, versions[target]).relative_to(ROOT)}')


if __name__ == '__main__':
    main()
