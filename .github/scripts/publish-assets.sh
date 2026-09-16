#!/usr/bin/env bash
# Publish the packages of one build as version + commit named release assets,
# each with a `.sha256` beside it, and keep the release to a single build.
#
# Names embed the app version (from tauri.conf.json) and the short commit, so a
# new build never overwrites an old one — which is why the assets this platform
# left from an earlier commit are removed first. Only this platform's own assets
# are touched, so the three build jobs can publish concurrently. Requires
# GH_TOKEN, node and a checkout of the commit being built.
#
#   publish-assets.sh <tag> <draft> <platform> <package>...
#
# with <platform> one of windows-x64, android-arm64-v8a, ios-arm64-unsigned.
set -euo pipefail

tag="${1:?release tag required}"
draft="${2:?draft flag required}"
platform="${3:?platform label required}"
shift 3
test "$#" -gt 0 || { echo 'no packages given' >&2; exit 1; }

script_dir=$(cd "$(dirname "$0")" && pwd)
version=$(node -p "require('./src-tauri/tauri.conf.json').version")
sha=$(git rev-parse --short=7 HEAD)

# A draft deleted from the web UI while the run was going is the one case where
# the release is not there any more.
bash "$script_dir/ensure-release.sh" "$tag" "$draft"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
for package in "$@"; do
  test -f "$package" || { echo "missing package: $package" >&2; exit 1; }
  name="yomika-${version}-${platform}-${sha}.${package##*.}"
  cp "$package" "$stage/$name"
  if command -v sha256sum > /dev/null 2>&1; then
    (cd "$stage" && sha256sum "$name" > "$name.sha256")
  else
    (cd "$stage" && shasum -a 256 "$name" > "$name.sha256")
  fi
  echo "Prepared $name"
done

# Drop this platform's assets from earlier commits.
while read -r name; do
  [ -n "$name" ] || continue
  case "$name" in
    yomika-*-"$platform"-*) gh release delete-asset "$tag" "$name" --yes ;;
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
    cat "$stage"/*.sha256
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi
