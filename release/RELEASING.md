# Releasing rice-field

This directory holds everything needed to build and publish a new version of
rice-field. The extension ships through **two independent registries**, each
with its own auth and CLI. They accept the same `.vsix` — we build once and
upload twice.

| Registry | Reach | CLI | Token env var |
| --- | --- | --- | --- |
| VS Code Marketplace | VS Code | `vsce` | `VSCE_PAT` |
| Open VSX Registry | Cursor, VSCodium, Windsurf, Gitpod, Theia | `ovsx` | `OVSX_PAT` |

## One-time setup

### VS Code Marketplace (`VSCE_PAT`)

1. Sign in at `https://marketplace.visualstudio.com/manage`.
2. Create a publisher named `UnseriousVentures` (or match whatever is in `package.json`).
3. Generate a Personal Access Token in Azure DevOps with scope **Marketplace → Manage**.

### Open VSX (`OVSX_PAT`)

1. Create an Eclipse Foundation account at `https://accounts.eclipse.org/user/register`.
2. Sign the Eclipse Contributor Agreement at `https://accounts.eclipse.org/user/eca`.
3. Log in at `https://open-vsx.org` with GitHub (using the same email as the Eclipse account).
4. Avatar → Settings → Access Tokens → **Generate New Token**.
5. One time only: claim the publisher namespace
   ```bash
   OVSX_PAT=<token> npx ovsx create-namespace UnseriousVentures
   ```

### Local config

```bash
cp release/.env.example release/.env
# edit release/.env and paste in VSCE_PAT and OVSX_PAT
```

`release/.env` is gitignored.

### GitHub Actions config

Add both tokens as repo secrets at
`Settings → Secrets and variables → Actions`:
- `VSCE_PAT`
- `OVSX_PAT`

## Releasing a new version

### Option A — tag push (recommended)

CI picks up any `v*` tag and publishes to both markets automatically.

```bash
npm version patch          # or minor / major — bumps package.json + creates git tag
git push origin main --follow-tags
```

The `.github/workflows/release.yml` workflow runs `npm run publish`
(which invokes `release/publish.sh`) against the tagged commit, then attaches
the `.vsix` to a GitHub Release.

### Option B — local publish

Runs the exact same script CI runs.

```bash
npm version patch
git push origin main --follow-tags
npm run publish
```

Flags:
- `npm run publish:vsce` — VS Code Marketplace only
- `npm run publish:ovsx` — Open VSX only
- `npm run publish:dry` — build + package, skip uploads

## Directory layout

```
release/
├── publish.sh       # the publish flow — runs locally and in CI
├── .env.example     # template for local tokens
├── .env             # your tokens (gitignored)
└── RELEASING.md     # this file

dist/                # VSIX output (gitignored)
└── rice-field-X.Y.Z.vsix
```

## Retry semantics

If one market succeeds and the other fails, don't re-run the full publish —
you'd rebuild unnecessarily, and `vsce publish` would reject the republish
because the version is already live. Instead:

```bash
bash release/publish.sh --ovsx-only --skip-build   # reuses dist/*.vsix as-is
```

Same for `--vsce-only --skip-build`.

## Troubleshooting

**`vsce` rejects the publish with "Version already exists"**
The version in `package.json` was already pushed to VS Code Marketplace. Bump
the version (`npm version patch`) and try again.

**`ovsx` errors with "Insufficient access rights"**
Either (a) your `OVSX_PAT` is missing or wrong, or (b) the `UnseriousVentures`
namespace hasn't been claimed on Open VSX yet. Run `npx ovsx create-namespace
UnseriousVentures` once to claim it.

**Open VSX says "Publisher agreement not signed"**
Sign the ECA at `https://accounts.eclipse.org/user/eca` and wait ~5 minutes
for Eclipse's SSO to propagate before retrying.

**README images render broken on a marketplace listing**
Marketplace pages don't resolve relative image paths — rewrite them as
absolute `https://raw.githubusercontent.com/...` URLs before the next
publish.
