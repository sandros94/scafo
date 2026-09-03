#!/usr/bin/env bash
#
# Prints the image references a publishing run should tag, one per line.
#
#   image-tags.sh --image ghcr.io/o/n --sha "$GITHUB_SHA"
#   image-tags.sh --image ghcr.io/o/n --version v1.2.3 --latest
#
# Every publishing path routes through here so the tag *shape* is defined once.
# Which tags a path asks for is the caller's decision:
#
#   push to main       --sha                      -> :edge, :sha-1234567
#   release tag        --version [--latest]       -> :1.2.3 [, :latest]
#
# --latest is a separate flag rather than implied by --version: a prerelease
# must never move the :latest pointer.

set -euo pipefail

image=""
version=""
sha=""
latest=false

while [ "$#" -gt 0 ]; do
	case "$1" in
	--image)
		image="${2-}"
		shift 2
		;;
	--version)
		version="${2-}"
		shift 2
		;;
	--sha)
		sha="${2-}"
		shift 2
		;;
	--latest)
		latest=true
		shift
		;;
	*)
		echo "image-tags: unknown argument '$1'" >&2
		exit 1
		;;
	esac
done

if [ -z "$image" ]; then
	echo "image-tags: --image is required" >&2
	exit 1
fi

if [ -z "$version" ] && [ -z "$sha" ]; then
	echo "image-tags: at least one of --version or --sha is required" >&2
	exit 1
fi

tags=()

if [ -n "$version" ]; then
	# Image tags carry the bare semver, without the git tag's "v".
	tags+=("${image}:${version#v}")
	if [ "$latest" = true ]; then
		tags+=("${image}:latest")
	fi
fi

if [ -n "$sha" ]; then
	tags+=("${image}:edge" "${image}:sha-${sha:0:7}")
fi

printf '%s\n' "${tags[@]}"
