#!/usr/bin/env bash
# Make sure the run's release exists before a build job attaches its package.
#
# prepare-release creates the draft up front, but it can be gone by the time a
# build finishes — a draft deleted from the web UI while the run was going is
# exactly what happened once — and then the last step of an otherwise good build
# failed with "release not found". Requires GH_TOKEN in the environment.
set -euo pipefail

tag="${1:?release tag required}"
draft="${2:-true}"

if gh release view "$tag" > /dev/null 2>&1; then
  exit 0
fi

echo "Release $tag is missing; recreating it."
args=("$tag" --title "Yomika $tag" --generate-notes --target "${GITHUB_SHA:?}")
if [ "$draft" = "true" ]; then args+=(--draft); fi
gh release create "${args[@]}"
