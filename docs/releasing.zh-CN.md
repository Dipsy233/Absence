# 发布流程

[English](releasing.md) | [简体中文](releasing.zh-CN.md)

Absence 以桌面安装包的形式发布：Windows 是 NSIS 安装器和免安装 ZIP，Linux 是
AppImage 和 `tar.gz`。`.github/workflows/release.yml` 在 GitHub runner 上只构建
Windows 与 Linux，并把安装包附加到 GitHub Release，因此发布不依赖任何本地环境。

## 发布说明

每个版本有两份完整文档：

- `docs/releases/v<版本>.md` —— 英文
- `docs/releases/v<版本>.zh-CN.md` —— 简体中文

两份文档描述同一个版本。英文文件末尾附一段中文说明，不能替代中文文档。

每份文档包含三节：

1. 用户可见变化：改了什么，对用户有什么影响。
2. 破坏性变更：移除的能力、改变的默认值、移除的接口与环境变量，以及替代方式。
3. 已知限制：该版本未覆盖的范围。

历史版本的发布说明描述该版本当时的状态，使用过去时。某项能力在后续版本被移除时，
说明中写明移除它的版本。

## 两种触发方式

### 1. 手动触发

1. 写两份发布说明：`docs/releases/v0.5.0.md` 与
   `docs/releases/v0.5.0.zh-CN.md`。
2. 提交并推送到 `main`。
3. GitHub ▸ **Actions** ▸ **Release** ▸ **Run workflow**：
   - `version`：`0.5.0`（不要带 `v`）
   - `prerelease`：`-beta` / `-rc` 之类的版本勾选
   - `draft`：默认勾选，先生成草稿 Release，检查无误后自行发布；取消勾选则直接发布
4. 运行结束后打开 **Releases**，确认说明和产物，再发布草稿：

   ```bash
   gh release edit v0.5.0 --draft=false
   ```

工作流只在构建期间把版本号写进各个 `package.json`，不会提交，因此即使仓库里的
版本号落后，安装包也会按本次发布版本命名（`Absence.Setup-0.5.0.exe`、
`Absence-0.5.0.AppImage`）。

### 2. 推 tag 自动发布

```bash
git tag v0.5.0
git push origin v0.5.0
```

推 tag 会以 `draft: false` 运行同一个工作流，并根据 tag 名判断是否为预发布
（`v0.5.0-beta.1` → 预发布）。构建、说明、发布在一次运行内完成。

## 工作流做了什么

| Job | Runner | 作用 |
| --- | --- | --- |
| `prepare` | ubuntu | 归一化 `version` / `tag`，查找 `docs/releases/<tag>.md` 或 `docs/releases/<tag>.zh-CN.md`，决定 draft / prerelease |
| `checks` | ubuntu | `npm run typecheck --workspaces` + `npm run check:offline`；任一检查失败则停止发布 |
| `build` | windows-latest、ubuntu-latest | `npm ci`、`npm --prefix apps/desktop ci`、`npm run desktop:dist`，上传安装包 |
| `publish` | ubuntu | 合并两平台的产物、生成 `SHA256SUMS.txt`、选择或生成发布说明、创建或更新 Release |

发布正文取自 `docs/releases/<tag>.md`；英文文件缺失时回退到
`docs/releases/<tag>.zh-CN.md`。两者都不存在时，从上一个 tag 到本次 tag 之间的
提交信息自动生成，按 conventional-commit 类型分组（`scripts/release/notes.mjs`，
本地也可以运行 `npm run release:notes -- v0.5.0`）。不使用 GitHub 自带的自动
说明，因为它按 PR 分组，而本仓库大多直接推送到 `main`；`.github/release.yml`
只保留给 Releases 页面里的 "Generate release notes" 按钮使用。

Release 上附加的文件：

- `Absence.Setup-0.5.0.exe` —— Windows 安装器（NSIS）
- `Absence-0.5.0.zip` —— Windows 免安装版：解压到任意目录后直接运行
  `Absence.exe`，不写注册表、不需要安装
- `Absence-0.5.0.AppImage`、`Absence-0.5.0.tar.gz` —— Linux
- `SHA256SUMS.txt` —— 以上文件的校验和

产物名在 `apps/desktop/package.json` 里固定（ZIP 与 Linux 包用
`win.artifactName`，安装器用 `nsis.artifactName`），避免 electron-builder 的
默认名被 GitHub 上传时把空格换成点。electron-builder 还会生成 `.blockmap` 和
`latest*.yml`，这里排除了：它们只对自动更新器有用，而 Absence 目前没有自动
更新器。

## 构建相关的注意点

- 内核进程观察器（`native/agentwatch/agentwatch.exe`、
  `native/agentwatch-linux/agentwatch-linux`）是预编译并提交进仓库的。CI 不编译
  它们；源码变化时请在本地重新构建并提交新二进制：Windows 用
  `npm run build:agentwatch`（MinGW 或 MSVC），Linux 用
  `native/agentwatch-linux/build.sh`（clang + libbpf）。
- 安装包未签名。Windows SmartScreen 会在运行安装器前提示风险；签名需要证书和
  仓库 secrets，目前不在范围内。工作流设置了
  `CSC_IDENTITY_AUTO_DISCOVERY=false`，避免 electron-builder 探测签名身份。
- Linux 构建需要观察器有可执行位：git 里存的是 `100644`，所以打包前工作流会执行
  `chmod +x`。
- 失败后可以安全地重跑：如果 Release 已存在，`publish` 会用 `--clobber` 重新上传
  产物并刷新说明，而不是报错退出。

## 版本号

发布工作流在构建时用输入或 tag 覆盖各个 `package.json` 里的版本号，所以不 bump
版本号也能发布。如果希望仓库本身就带版本号，在打 tag 前先 bump：

```bash
npm version 0.5.0 --no-git-tag-version --workspaces --include-workspace-root
npm --prefix apps/desktop version 0.5.0 --no-git-tag-version
git commit -am "chore: release v0.5.0"
git tag v0.5.0 && git push origin main --tags
```

## 本地跑打包步骤

```bash
npm ci
npm --prefix apps/desktop ci
npm run desktop:dist        # web 构建 + 服务端打包 + electron-builder
```

产物在 `dist/desktop/release/`（已被 git 忽略）。打包内容与 extra resources 在
`apps/desktop/package.json` 中声明；生成服务端 bundle 的 staging 步骤是
`apps/desktop/scripts/stage-desktop.mjs`。
