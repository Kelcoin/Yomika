#!/usr/bin/env bash
# Publish the packages of one build as release assets named
#
#   yomika-<version>-<short sha>-<platform>.<ext>
#
# with <platform> one of windows-x64, android-arm64-v8a, ios-arm64-unsigned:
# name and version first, the commit the build came from next, then the platform
# with its variant, extension after a dot — the order Node, ripgrep and uv use,
# with the commit where build metadata belongs rather than in the variant slot.
# Each package's SHA-256 goes into the run summary instead of a sidecar file.
#
# The release holds one build at a time, so this platform's assets from an
# earlier commit are dropped first. Only this platform's own assets are touched,
# so the three build jobs can publish concurrently. Requires GH_TOKEN, node and
# a checkout of the commit being built.
#
#   publish-assets.sh <tag> <draft> <platform> <package>...
set -euo pipefail

tag="${1:?release tag required}"
draft="${2:?draft flag required}"
platform="${3:?platform label required}"
shift 3
test "$#" -gt 0 || { echo 'no packages given' >&2; exit 1; }

script_dir=$(cd "$(dirname "$0")" && pwd)
version=$(node -p "require('./src-tauri/tauri.conf.json').version")
sha=$(git rev-parse --short=8 HEAD)

hash_of() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

# A draft deleted from the web UI while the run was going is the one case where
# the release is not there any more.
bash "$script_dir/ensure-release.sh" "$tag" "$draft"

stage=$(mktemp -d)
summary=$(mktemp)
trap 'rm -rf "$stage" "$summary"' EXIT

for package in "$@"; do
  test -f "$package" || { echo "missing package: $package" >&2; exit 1; }
  name="yomika-${version}-${sha}-${platform}.${package##*.}"
  cp "$package" "$stage/$name"
  (cd "$stage" && hash_of "$name") >> "$summary"
  echo "Prepared $name"
done

# Drop this platform's assets from earlier commits: the names carry the commit,
# so they would otherwise pile up. The match stays loose on purpose, so assets
# left by the older naming scheme are replaced as well.
while read -r name; do
  [ -n "$name" ] || continue
  case "$name" in
    yomika-*"$platform"*) gh release delete-asset "$tag" "$name" --yes ;;
    *) continue ;;
  esac
done < <(gh release view "$tag" --json assets -q '.assets[].name' 2> /dev/null || true)

gh release upload "$tag" "$stage"/* --clobber

# The hashes belong on the run page too, next to the download link.
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Published to \`$tag\`"
    echo
    echo '```'
    cat "$summary"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi
