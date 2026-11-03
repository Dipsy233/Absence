# Documentation

[English](README.md) | [简体中文](README.zh-CN.md)

Index of every document in `docs/`. Each document exists as an English file and a
Simplified Chinese file with the `.zh-CN.md` suffix, and both versions are
maintained together. The internal note is the only exception and is not public.

## Current documents

| Document | Languages | Purpose | Audience |
|---|---|---|---|
| [architecture.md](architecture.md) | English · [简体中文](architecture.zh-CN.md) | Data flow, repository layout, module responsibilities, event projection, storage, API and desktop shell | Contributors, maintainers |
| [agent-support.md](agent-support.md) | English · [简体中文](agent-support.zh-CN.md) | Discovery order, readiness states, built-in profiles, custom entries and authentication | Users, contributors |
| [ui-faces.md](ui-faces.md) | English · [简体中文](ui-faces.zh-CN.md) | The three switchable faces and the Drip overlay, the data flow they share and their dependencies | Users, contributors |
| [ui-style-interface.md](ui-style-interface.md) | English · [简体中文](ui-style-interface.zh-CN.md) | The style and colour-scheme layers, design tokens, contrast rules and the steps for adding a style | Contributors |
| [avatar-skin.md](avatar-skin.md) | English · [简体中文](avatar-skin.zh-CN.md) | Uploading avatar skins, fallback rules, storage location and limits | Users |
| [testing.md](testing.md) | English · [简体中文](testing.zh-CN.md) | Gates, registered checks, ACP checks, end-to-end simulation and check groups | Contributors, maintainers |
| [testing-strategy.md](testing-strategy.md) | English · [简体中文](testing-strategy.zh-CN.md) | Test layering, what each layer can prove, and the reasons for the split | Contributors, maintainers |
| [releasing.md](releasing.md) | English · [简体中文](releasing.zh-CN.md) | Release workflow, build targets, artifacts, signing and versioning | Maintainers |

## Release notes

Release notes are frozen records of a version. Each file describes the state of
the project at that release; changes made later are not reflected in it.

| Document | Languages | Purpose | Audience |
|---|---|---|---|
| [releases/v0.2.0.md](releases/v0.2.0.md) | English · [简体中文](releases/v0.2.0.zh-CN.md) | Release notes for v0.2.0 | Users, maintainers |
| [releases/v0.3.0.md](releases/v0.3.0.md) | English · [简体中文](releases/v0.3.0.zh-CN.md) | Release notes for v0.3.0 | Users, maintainers |
| [releases/v0.4.0.md](releases/v0.4.0.md) | English · [简体中文](releases/v0.4.0.zh-CN.md) | Release notes for v0.4.0 | Users, maintainers |
| [releases/v0.5.0.md](releases/v0.5.0.md) | English · [简体中文](releases/v0.5.0.zh-CN.md) | Release notes for v0.5.0 | Users, maintainers |

## Internal

Material in `docs/internal/` is working material for maintainers. It is not
published, is not linked from the project README, and does not describe the
current design.

| Document | Languages | Purpose | Audience |
|---|---|---|---|
| [internal/acp-branch-analysis.txt](internal/acp-branch-analysis.txt) | English only · not public | Raw notes from the analysis of the ACP2 refactor branch | Maintainers only |
