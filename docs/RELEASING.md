# Releasing

Absence ships as a desktop package (NSIS installer on Windows, AppImage and
`tar.gz` on Linux). `.github/workflows/release.yml` builds both on GitHub's
runners and publishes a GitHub Release with the installers attached, so a
release never depends on a local machine being set up.

## Two ways to release

### 1. Manual, from the Actions tab (recommended)

1. Write the notes first: `docs/RELEASE_NOTES_v<version>.md` (English, with a
   `## 中文摘要` section at the end — see `docs/RELEASE_NOTES_v0.4.0.md`).
2. Commit and push that file to `main`.
3. GitHub ▸ **Actions** ▸ **Release** ▸ **Run workflow**:
   - `version`: `0.4.0` (no leading `v`)
   - `prerelease`: tick for `-beta`/`-rc` style releases
   - `draft`: leave ticked to get a draft release you can review and publish
     yourself (untick to publish immediately)
4. When the run finishes, open **Releases**, check the notes and the assets,
   then publish the draft:

   ```bash
   gh release edit v0.4.0 --draft=false
   ```

The workflow stamps the version into the workspace `package.json` files for the
build only, so the installer is named `Absence Setup 0.4.0.exe` /
`Absence-0.4.0.AppImage` even if the committed versions lag behind.

### 2. Automatic, by pushing a tag

```bash
git tag v0.4.0
git push origin v0.4.0
```

A tag push runs the same workflow with `draft: false` and auto-detects
`prerelease` from the tag name (`v0.5.0-beta.1` → pre-release). This is the
"hands-off" path: build, notes and publish happen in one run.

## What the workflow does

| Job | Runner | Purpose |
| --- | --- | --- |
| `prepare` | ubuntu | Normalizes `version`/`tag`, picks `docs/RELEASE_NOTES_v<tag>.md` if present, decides draft/prerelease |
| `checks` | ubuntu | `npm run typecheck --workspaces` + `npm run check:offline` — a broken tree cannot ship |
| `build` | windows-latest, ubuntu-latest | `npm ci`, `npm --prefix apps/desktop ci`, `npm run desktop:dist`, upload installers |
| `publish` | ubuntu | Downloads both artifact sets, writes `SHA256SUMS.txt`, picks or generates the notes, creates/updates the Release |

Notes come from `docs/RELEASE_NOTES_<tag>.md` (or `docs/RELEASE_<tag>.md`) when
that file exists. Otherwise they are generated from the commit subjects between
the previous tag and this one, grouped by conventional-commit type
(`scripts/release/notes.mjs`, also runnable locally as
`npm run release:notes -- v0.4.0`). GitHub's own auto-generated notes are not
used because they group pull requests, and this repo mostly pushes to `main`
directly — `.github/release.yml` is kept only for the "Generate release notes"
button in the Releases UI.

Assets attached to the release:

- `Absence Setup <version>.exe` — Windows installer (NSIS)
- `Absence-<version>.AppImage`, `Absence-<version>.tar.gz` — Linux
- `SHA256SUMS.txt` — checksums for everything above

`latest*.yml` files from electron-builder are attached too. They are only used
by an auto-updater; Absence does not ship one yet, so they are harmless.

## Notes on the build

- The native process observers (`native/agentwatch/agentwatch.exe`,
  `native/agentwatch-linux/agentwatch-linux`) are **committed prebuilt**. CI
  does not compile them; rebuild locally with `npm run build:agentwatch` (MinGW
  or MSVC on Windows) or `native/agentwatch-linux/build.sh` (clang + libbpf on
  Linux) when their sources change, then commit the new binary.
- Packages are unsigned. Windows SmartScreen and macOS Gatekeeper will warn;
  signing needs certificates as repository secrets and is out of scope for now.
  `CSC_IDENTITY_AUTO_DISCOVERY=false` is set so electron-builder never probes
  for a signing identity.
- Linux builds need the observer's executable bit: git stores it as `100644`,
  so the workflow runs `chmod +x` before packaging.
- Re-running a failed release is safe: if the Release already exists, the
  `publish` job uploads assets with `--clobber` and refreshes the notes instead
  of failing.

## Version numbers

`package.json` versions are the source of truth for artifact names. The release
workflow overrides them at build time from the `version` input/tag, so you can
release without a version-bump commit. If you prefer the repo to carry the
version, bump it before tagging:

```bash
npm version 0.4.0 --no-git-tag-version --workspaces --include-workspace-root
npm --prefix apps/desktop version 0.4.0 --no-git-tag-version
git commit -am "chore: release v0.4.0"
git tag v0.4.0 && git push origin main --tags
```

## Running the packaging step locally

```bash
npm ci
npm --prefix apps/desktop ci
npm run desktop:dist        # web build + server bundle + electron-builder
```

Output lands in `dist/desktop/release/` (git-ignored). See
[ARCHITECTURE.md](ARCHITECTURE.md) for what the staging step puts inside the
package.
