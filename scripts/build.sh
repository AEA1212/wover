#!/usr/bin/env bash
# Package Wover as dist/wover-<version>.xpi (macOS and Linux).
#
#   ./scripts/build.sh          build an unsigned .xpi (for about:debugging,
#                               Firefox Developer Edition or Nightly)
#   ./scripts/build.sh --sign   build a .xpi signed by Mozilla, installable in
#                               any Firefox (needs Node.js and AMO API keys,
#                               see "Signing" in README.md)
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' manifest.json | head -n 1)
mkdir -p dist

# Everything except the repository's own files goes into the package.
excluded=('.*' 'docs/*' 'scripts/*' 'dist/*' 'node_modules/*' '*.md')

if [[ "${1:-}" == "--sign" ]]; then
  if [[ -z "${WEB_EXT_API_KEY:-}" || -z "${WEB_EXT_API_SECRET:-}" ]]; then
    echo "Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET first (see Signing in README.md)." >&2
    exit 1
  fi
  command -v npx >/dev/null || { echo "Signing needs Node.js (npx): https://nodejs.org" >&2; exit 1; }
  npx --yes web-ext@8 sign --channel=unlisted --source-dir . --artifacts-dir dist \
    --ignore-files 'docs/**' 'scripts/**' 'dist/**' 'node_modules/**' '*.md'
  echo "Signed package written to dist/"
  exit 0
fi

out="dist/wover-$version.xpi"
rm -f "$out"
if command -v zip >/dev/null; then
  zip -q -r -X "$out" . -x "${excluded[@]}"
elif command -v python3 >/dev/null; then
  python3 - "$out" <<'PY'
import os, sys, zipfile
skip_dirs = {'docs', 'scripts', 'dist', 'node_modules'}
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk('.'):
        rel_root = os.path.relpath(root, '.')
        dirs[:] = [d for d in dirs if not d.startswith('.') and not (rel_root == '.' and d in skip_dirs)]
        for name in files:
            if name.startswith('.') or name.endswith('.md'):
                continue
            path = os.path.normpath(os.path.join(rel_root, name))
            z.write(path, path.replace(os.sep, '/'))
PY
else
  echo "Install zip or python3 to build the package." >&2
  exit 1
fi
echo "Built $out"
