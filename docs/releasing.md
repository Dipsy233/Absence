# Releasing

[English](releasing.md) | [简体中文](releasing.zh-CN.md)

Absence ships as desktop packages: an NSIS installer and a portable ZIP on
Windows, and an AppImage and `tar.gz` on Linux. `.github/workflows/release.yml`
builds on GitHub runners for Windows and Linux only, then publishes a GitHub
Release with the installers attached. A release does not depend on a local
machine being set up.

## Release notes

Every release has two complete documents:

- `docs/releases/v<version>.md` — English
- `docs/releases/v<version>.zh-CN.md` — Simplified Chinese

Both documents describe the same release. A short Chinese section appended to
the English file is not a substitute for the Chinese document.

Each document contains three sections:

1. User-visible changes: what changed and what it means for the user.
2. Breaking changes: removed capabilities, changed defaults, removed endpoints
   and environment variables, and what replaces them.
3. Known limitations: what the release does not cover.

Notes for a past release describe that release and use the past tense. When a
capability was removed later, the note names the release that removed it.

## Two ways to release

### 1. Manual, from the Actions tab

1. Write the two notes files, `docs/releases/v0.5.0.md` and
   `docs/releases/v0.5.0.zh-CN.md`.
2. Commit and push to `main`.
3. GitHub ▸ **Actions** ▸ **Release** ▸ **Run workflow**:
   - `version`: `0.5.0` (no leading `v`)
   - `prerelease`: tick for `-beta` / `-rc` style releases
   - `draft`: leave ticked to get a draft release you can review and publish
     yourself; untick to publish immediately
4. When the run finishes, open **Releases**, check the notes and the assets,
   then publish the draft:

   ```bash
   gh release edit v0.5.0 --draft=false
   ```

The workflow stamps the version into the workspace `package.json` files for the
build only, so the installer is named `Absence.Setup-0.5.0.exe` and the Linux
package `Absence-0.5.0.AppImage` even if the committed versions lag behind.

### 2. Automatic, by pushing a tag

```bash
git tag v0.5.0
git push origin v0.5.0
```

A tag push runs the same workflow with `draft: false` and detects `prerelease`
from the tag name (`v0.5.0-beta.1` → pre-release). Build, notes and publish
happen in one run.

## What the workflow does

| Job | Runner | Purpose |
| --- | --- | --- |
| `prepare` | ubuntu | Normalizes `version` / `tag`, picks `docs/releases/<tag>.md` or `docs/releases/<tag>.zh-CN.md` if present, decides draft / prerelease |
| `checks` | ubuntu | `npm run typecheck --workspaces` + `npm run check:offline`; a failing check stops the release |
| `build` | windows-latest, ubuntu-latest | `npm ci`, `npm --prefix apps/desktop ci`, `npm run desktop:dist`, uploads the packages |
| `publish` | ubuntu | Downloads both artifact sets, writes `SHA256SUMS.txt`, picks or generates the notes, creates or updates the Release |

The release body comes from `docs/releases/<tag>.md`; when the English file is
absent, the workflow falls back to `docs/releases/<tag>.zh-CN.md`. If neither
exists, it is generated from the commit subjects between the previous tag and
this one, grouped by conventional-commit type (`scripts/release/notes.mjs`,
also runnable locally as `npm run release:notes -- v0.5.0`). GitHub's
auto-generated notes are not used because they group pull requests, and this
repository mostly pushes to `main` directly; `.github/release.yml` is kept only
for the "Generate release notes" button in the Releases UI.

Assets attached to the release:

- `Absence.Setup-0.5.0.exe` — Windows installer (NSIS)
- `Absence-0.5.0.zip` — Windows portable: unzip it anywhere and run
  `Absence.exe`, with no installation or registry entries
- `Absence-0.5.0.AppImage`, `Absence-0.5.0.tar.gz` — Linux
- `SHA256SUMS.txt` — checksums for everything above

Artifact names are pinned in `apps/desktop/package.json` (`win.artifactName`
for the ZIP and Linux packages, `nsis.artifactName` for the installer) instead
of the default electron-builder name, which GitHub would upload with dots
instead of spaces. electron-builder also emits `.blockmap` and `latest*.yml`
files; they are excluded because they only matter to an auto-updater, and
Absence ships none.

## Notes on the build

- The native process observers (`native/agentwatch/agentwatch.exe`,
  `native/agentwatch-linux/agentwatch-linux`) are committed prebuilt. CI does
  not compile them; rebuild locally with `npm run build:agentwatch` (MinGW or
  MSVC on Windows) or `native/agentwatch-linux/build.sh` (clang + libbpf on
  Linux) when their sources change, then commit the new binary.
- Packages are unsigned. Windows SmartScreen warns before running the
  installer; signing needs certificates as repository secrets and is out of
  scope. `CSC_IDENTITY_AUTO_DISCOVERY=false` is set so electron-builder never
  probes for a signing identity.
- Linux builds need the observer's executable bit: git stores it as `100644`,
  so the workflow runs `chmod +x` before packaging.
- Re-running a failed release is safe: if the Release already exists, the
  `publish` job uploads assets with `--clobber` and refreshes the notes instead
  of failing.

## Version numbers

The release workflow overrides the `package.json` versions at build time from
the `version` input or the tag, so a release does not require a version-bump
commit. If the repository should carry the version, bump it before tagging:

```bash
npm version 0.5.0 --no-git-tag-version --workspaces --include-workspace-root
npm --prefix apps/desktop version 0.5.0 --no-git-tag-version
git commit -am "chore: release v0.5.0"
git tag v0.5.0 && git push origin main --tags
```

## Running the packaging step locally

```bash
npm ci
npm --prefix apps/desktop ci
npm run desktop:dist        # web build + server bundle + electron-builder
```

Output lands in `dist/desktop/release/` (git-ignored). The packaged files and
extra resources are declared in `apps/desktop/package.json`; the staging step
that produces the server bundle is `apps/desktop/scripts/stage-desktop.mjs`.
