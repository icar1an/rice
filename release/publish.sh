#!/usr/bin/env bash
# release/publish.sh — build the VSIX and publish it to one or both markets.
#
# rice-field ships through two independent extension registries:
#
#   1. VS Code Marketplace   — Microsoft's registry, used by VS Code itself.
#                              CLI: `vsce`. Token: VSCE_PAT (Azure DevOps PAT).
#   2. Open VSX Registry     — Eclipse Foundation's open registry, used by
#                              Cursor, VSCodium, Windsurf, Gitpod, Theia.
#                              CLI: `ovsx`. Token: OVSX_PAT (open-vsx.org token).
#
# Both registries accept the same .vsix file. We build once, publish twice.
#
# Flags:
#   --vsce-only    only publish to VS Code Marketplace
#   --ovsx-only    only publish to Open VSX
#   --dry-run      build + package, skip upload
#   --skip-build   reuse an already-built dist/<name>-<version>.vsix
#
# Usage examples:
#   npm run publish                         # both markets
#   npm run publish:vsce                    # VS Code Marketplace only
#   npm run publish:ovsx                    # Open VSX only
#   npm run publish:dry                     # build + package, no upload
#   bash release/publish.sh --ovsx-only --skip-build   # retry ovsx after vsce succeeded
#
# Tokens: put them in release/.env (gitignored) or export them in your shell.
# The GitHub Actions workflow wires them in via repo secrets of the same name.
#
# Version bumping is NOT done here. Run `npm version patch|minor|major` first.

set -euo pipefail

# ─── constants & paths ──────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

DIST_DIR="$ROOT_DIR/dist"

# ─── argument parsing ───────────────────────────────────────────────────────

DO_VSCE=1
DO_OVSX=1
DRY_RUN=0
SKIP_BUILD=0

for arg in "$@"; do
  case "$arg" in
    --vsce-only)  DO_OVSX=0 ;;
    --ovsx-only)  DO_VSCE=0 ;;
    --dry-run)    DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "error: unknown arg: $arg (try --help)" >&2
      exit 2 ;;
  esac
done

# ─── env loading ────────────────────────────────────────────────────────────

# Local publishing reads release/.env (gitignored). CI injects secrets
# directly as env vars and doesn't need a file.
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

# ─── metadata ───────────────────────────────────────────────────────────────

NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
VSIX="$DIST_DIR/${NAME}-${VERSION}.vsix"

echo "==> ${NAME} ${VERSION}"

# ─── token validation ───────────────────────────────────────────────────────

if [[ $DRY_RUN -eq 0 ]]; then
  if [[ $DO_VSCE -eq 1 && -z "${VSCE_PAT:-}" ]]; then
    echo "error: VSCE_PAT is not set. Pass --ovsx-only to skip VS Code Marketplace." >&2
    exit 1
  fi
  if [[ $DO_OVSX -eq 1 && -z "${OVSX_PAT:-}" ]]; then
    echo "error: OVSX_PAT is not set. Pass --vsce-only to skip Open VSX." >&2
    exit 1
  fi
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "warning: working tree has uncommitted changes — continuing" >&2
fi

# ─── build + package ────────────────────────────────────────────────────────

build_and_package() {
  echo "==> compiling"
  npm run compile

  echo "==> packaging to $VSIX"
  mkdir -p "$DIST_DIR"
  npx --no-install vsce package --out "$VSIX"
}

if [[ $SKIP_BUILD -eq 0 ]]; then
  build_and_package
else
  if [[ ! -f "$VSIX" ]]; then
    echo "error: --skip-build set but $VSIX does not exist" >&2
    exit 1
  fi
  echo "==> reusing existing $VSIX"
fi

if [[ $DRY_RUN -eq 1 ]]; then
  echo "==> dry run complete; artifact at $VSIX"
  exit 0
fi

# ─── flow 1: VS Code Marketplace ────────────────────────────────────────────

publish_to_vsce() {
  echo "==> [vsce] publishing to VS Code Marketplace"
  VSCE_PAT="$VSCE_PAT" npx --no-install vsce publish --packagePath "$VSIX"
}

# ─── flow 2: Open VSX (Cursor / VSCodium / Windsurf) ────────────────────────

publish_to_ovsx() {
  echo "==> [ovsx] publishing to Open VSX"
  OVSX_PAT="$OVSX_PAT" npx --no-install ovsx publish "$VSIX"
}

# ─── orchestration ──────────────────────────────────────────────────────────

VSCE_STATUS="skipped"
OVSX_STATUS="skipped"
FAILURES=0

if [[ $DO_VSCE -eq 1 ]]; then
  if publish_to_vsce; then
    VSCE_STATUS="ok"
  else
    VSCE_STATUS="FAIL"
    FAILURES=$((FAILURES + 1))
  fi
fi

if [[ $DO_OVSX -eq 1 ]]; then
  if publish_to_ovsx; then
    OVSX_STATUS="ok"
  else
    OVSX_STATUS="FAIL"
    FAILURES=$((FAILURES + 1))
  fi
fi

# ─── summary ────────────────────────────────────────────────────────────────

echo ""
echo "==> summary"
printf "    %-6s %s\n" "vsce" "$VSCE_STATUS"
printf "    %-6s %s\n" "ovsx" "$OVSX_STATUS"

if [[ $FAILURES -gt 0 ]]; then
  echo ""
  echo "one or more uploads failed. retry a single market with:" >&2
  echo "  npm run publish:vsce   # or publish:ovsx" >&2
  echo "  (add --skip-build to reuse $VSIX)" >&2
  exit 1
fi
