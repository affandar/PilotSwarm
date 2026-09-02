#!/usr/bin/env bash
set -euo pipefail

# Install the pilotswarm CLI/TUI/MCP from the GitHub Release tarballs.
#
# For machines that cannot reach registry.npmjs.org, or whose npm mirror has
# not picked up the release yet. Every release attaches the three package
# tarballs (pilotswarm-sdk, pilotswarm-horizon-store, pilotswarm) that
# `npm publish` produced, byte-identical to the registry artifacts. This
# script downloads them and installs all three in one `npm install`, so the
# app's dependency on the same-version sdk and horizon-store resolves from
# the local files, not from a registry that may not have them.
#
# Transitive dependencies (everything that is not one of the three) still
# come from your configured npm registry; pass --registry to point at a
# mirror for this install only.
#
#   scripts/install-from-release.sh                     # latest release, global install
#   scripts/install-from-release.sh 0.5.57              # a specific version
#   scripts/install-from-release.sh --registry https://<mirror>/npm/
#   scripts/install-from-release.sh --prefix ~/.local   # install under a prefix instead of the global one
#   scripts/install-from-release.sh --keep              # leave the downloaded tarballs in ./dist-tarballs
#   scripts/install-from-release.sh --dry-run           # resolve and download, do not install
#   curl -fsSL https://raw.githubusercontent.com/affandar/PilotSwarm/main/scripts/install-from-release.sh | bash
#
# Note: `pilotswarm --version` is not a flag (it opens the TUI); the version is
# printed by this script and shown in the TUI header.
#
# Options:
#   [version]         Release version, with or without the leading "v". Default: the latest release.
#   --repo <o/r>      GitHub repository. Default: affandar/PilotSwarm (or $PILOTSWARM_REPO).
#   --registry <url>  npm registry for transitive dependencies (passed to npm install).
#   --prefix <dir>    npm prefix for the install (binaries land in <dir>/bin). Default: npm's global prefix.
#   --keep            Keep the tarballs in ./dist-tarballs instead of a temp dir.
#   --dry-run         Download and verify, print the install command, do not run it.
#   -h, --help        This text.
#
# Needs: bash, curl, npm (Node 24+). `gh` is used to resolve "latest" when
# present; otherwise the public GitHub API is used.

REPO="${PILOTSWARM_REPO:-affandar/PilotSwarm}"
VERSION=""
REGISTRY=""
PREFIX=""
KEEP=0
DRY_RUN=0
PACKAGES=(pilotswarm-sdk pilotswarm-horizon-store pilotswarm)

usage() {
    cat <<'EOF'
Install the pilotswarm CLI/TUI/MCP from the GitHub Release tarballs.

  install-from-release.sh [version] [--repo owner/repo] [--registry url] [--prefix dir] [--keep] [--dry-run]

  [version]         Release version, with or without the leading "v". Default: the latest release.
  --repo <o/r>      GitHub repository. Default: affandar/PilotSwarm (or $PILOTSWARM_REPO).
  --registry <url>  npm registry for transitive dependencies (passed to npm install).
  --prefix <dir>    npm prefix for the install (binaries land in <dir>/bin). Default: npm's global prefix.
  --keep            Keep the tarballs in ./dist-tarballs instead of a temp dir.
  --dry-run         Download and verify, print the install command, do not run it.
  -h, --help        This text.

Straight from GitHub, no clone:
  curl -fsSL https://raw.githubusercontent.com/affandar/PilotSwarm/main/scripts/install-from-release.sh | bash
  curl -fsSL https://raw.githubusercontent.com/affandar/PilotSwarm/main/scripts/install-from-release.sh | bash -s -- 0.5.57 --registry https://<mirror>/

Note: `pilotswarm --version` is not a flag (it opens the TUI); this script prints the installed version.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --repo)      REPO="$2"; shift 2 ;;
        --registry)  REGISTRY="$2"; shift 2 ;;
        --prefix)    PREFIX="$2"; shift 2 ;;
        --keep)      KEEP=1; shift ;;
        --dry-run)   DRY_RUN=1; shift ;;
        -h|--help)   usage; exit 0 ;;
        -*)          echo "error: unknown option $1" >&2; usage >&2; exit 2 ;;
        *)           if [ -n "$VERSION" ]; then echo "error: one version only" >&2; exit 2; fi; VERSION="$1"; shift ;;
    esac
done

for tool in curl npm; do
    command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is required" >&2; exit 1; }
done

# ── Resolve the version ──────────────────────────────────────────
if [ -z "$VERSION" ] || [ "$VERSION" = "latest" ]; then
    if command -v gh >/dev/null 2>&1; then
        VERSION="$(gh release view --repo "$REPO" --json tagName --jq .tagName 2>/dev/null || true)"
    fi
    if [ -z "$VERSION" ]; then
        VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
            | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
    fi
    [ -n "$VERSION" ] || { echo "error: could not resolve the latest release of ${REPO}" >&2; exit 1; }
fi
VERSION="${VERSION#v}"
TAG="v${VERSION}"
BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"

# ── Download ─────────────────────────────────────────────────────
if [ "$KEEP" = 1 ]; then
    WORK_DIR="$(pwd)/dist-tarballs"
    mkdir -p "$WORK_DIR"
else
    WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pilotswarm-install.XXXXXX")"
    trap 'rm -rf "$WORK_DIR"' EXIT
fi

echo "pilotswarm ${VERSION} from ${REPO} (${TAG})"
echo "tarballs → ${WORK_DIR}"
FILES=()
for pkg in "${PACKAGES[@]}"; do
    file="${pkg}-${VERSION}.tgz"
    url="${BASE_URL}/${file}"
    printf '  %-36s ' "$file"
    if ! curl -fsSL --retry 3 -o "${WORK_DIR}/${file}" "$url"; then
        echo
        echo "error: download failed: ${url}" >&2
        echo "       check that release ${TAG} exists and carries the package tarballs" >&2
        exit 1
    fi
    # The tarball must contain a package.json that names this package and version.
    if ! tar -tzf "${WORK_DIR}/${file}" package/package.json >/dev/null 2>&1; then
        echo; echo "error: ${file} is not an npm package tarball" >&2; exit 1
    fi
    got="$(tar -xzOf "${WORK_DIR}/${file}" package/package.json | sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' | head -1)"
    if [ "$got" != "$VERSION" ]; then
        echo; echo "error: ${file} declares version '${got}', expected '${VERSION}'" >&2; exit 1
    fi
    if command -v shasum >/dev/null 2>&1; then
        echo "sha256 $(shasum -a 256 "${WORK_DIR}/${file}" | cut -c1-16)…"
    else
        echo "ok"
    fi
    FILES+=("${WORK_DIR}/${file}")
done

# ── Install ──────────────────────────────────────────────────────
NPM_ARGS=(install -g --no-audit --no-fund)
[ -n "$REGISTRY" ] && NPM_ARGS+=(--registry "$REGISTRY")
[ -n "$PREFIX" ]   && NPM_ARGS+=(--prefix "$PREFIX")

echo
echo "npm ${NPM_ARGS[*]} ${FILES[*]}"
if [ "$DRY_RUN" = 1 ]; then
    echo "(dry run: not installed)"
    exit 0
fi
npm "${NPM_ARGS[@]}" "${FILES[@]}"

# ── Verify ───────────────────────────────────────────────────────
if [ -n "$PREFIX" ]; then
    BIN="${PREFIX}/bin/pilotswarm"
else
    BIN="$(npm prefix -g)/bin/pilotswarm"
fi
# `pilotswarm --version` is not a flag: it starts the TUI. Read the installed
# package.json for the version and use --help as the smoke test.
PKG_JSON="$(dirname "$(dirname "$BIN")")/lib/node_modules/pilotswarm/package.json"
echo
if [ -x "$BIN" ]; then
    installed="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$PKG_JSON" 2>/dev/null | head -1)"
    echo "installed: ${BIN} (pilotswarm ${installed:-unknown})"
    "$BIN" --help </dev/null 2>/dev/null | head -1 || true
    case ":${PATH}:" in
        *":$(dirname "$BIN"):"*) ;;
        *) echo "note: $(dirname "$BIN") is not on your PATH" ;;
    esac
else
    echo "warning: ${BIN} not found after install; check 'npm prefix -g'" >&2
    exit 1
fi
