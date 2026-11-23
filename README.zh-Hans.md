<p align="center">
  <a href="https://genex.games">
    <picture>
      <source srcset=".github/logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset=".github/logo-light.svg" media="(prefers-color-scheme: light)">
      <img src=".github/logo-light.svg" alt="Genex" width="320">
    </picture>
  </a>
</p>
<p align="center"><a href="README.md">English</a> · <a href="README.ru.md">Русский</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <b>简体中文</b></p>
<p align="center">用 AI 做游戏的开源桌面应用。<br>智能体会自己配置引擎、制作你的游戏，并亲自试玩测试。</p>
<p align="center">
  <a href="https://github.com/genex-games/genex-desktop/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/genex-games/genex-desktop?style=flat-square" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/genex-games/genex-desktop?style=flat-square" /></a>
  <a href="https://github.com/genex-games/genex-desktop/actions/workflows/check.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/genex-games/genex-desktop/check.yml?branch=dev&style=flat-square&label=build" /></a>
</p>

<p align="center"><img src=".github/banner.png" alt="Genex，一款用 AI 做游戏的桌面应用：支持 Unreal Engine、Unity、Godot、Roblox 和 Three.js，内置游戏开发工具" width="100%"></p>

---

### 下载

| 平台 | 下载 |
| --- | --- |
| macOS (Apple Silicon) | [`Genex.dmg`](https://github.com/genex-games/genex-desktop/releases/latest/download/Genex.dmg) |
| Linux (x64) | 从[最新版本](https://github.com/genex-games/genex-desktop/releases/latest)下载 `.deb`、`.rpm` 或 `.zip`。`.deb` 和 `.rpm` 会添加 Genex 软件包仓库，之后系统更新（Software Updater、`apt`、`dnf`）就会带来每个新版本 |
| Windows (x64)，预览版 | [`Genex-Setup.exe`](https://github.com/genex-games/genex-desktop/releases/latest/download/Genex-Setup.exe)。暂未签名：如果 Windows 发出警告，请点“更多信息”，再点“仍要运行” |

Genex 还处于早期阶段，难免有不完善的地方，欢迎在
[issues](https://github.com/genex-games/genex-desktop/issues) 里告诉我们。

### 能做什么

→ 用 Unreal Engine、Unity、Godot、Roblox Studio 或 Three.js 制作\
→ 任意 AI：Claude Code、Codex (ChatGPT)、Antigravity、Cursor、Grok、OpenCode 和 OpenRouter\
→ 也能用本地模型：Ollama、LM Studio、llama.cpp\
→ 多智能体：主智能体、助手和审查员可以用不同的模型\
→ 内置游戏开发工具：Blender、Tripo、Meshy、Uthana、ElevenLabs、fal\
→ 一句提示词就能做服务器权威的多人游戏\
→ 发布到 Web、Mac、Windows 和 Linux

> [!TIP]
> 你的游戏需要什么工具？[做一个插件](#build-a-plugin)，放到 Genex 插件市场分享给所有人。

### 参与开发

你需要 Apple Silicon 的 macOS、Git 和 Node 24。

```bash
git clone https://github.com/genex-games/genex-desktop.git
cd genex-desktop
nvm install && nvm use   # 使用 .nvmrc 中的 Node 24
npm ci
npm run studio:dev -- start --profile first-run --fixture app-basics
```

这个测试环境会用脚本模型和示例游戏启动应用，所以不需要账号。提交 pull request 之前请先阅读
[CONTRIBUTING.md](CONTRIBUTING.md)；编程智能体请从 [AGENTS.md](AGENTS.md) 开始。

<a id="build-a-plugin"></a>

### 做一个插件

插件给 Genex 的智能体带来新工具：素材生成器、引擎桥接、游戏要连接的服务等。应用自带的 Blender
和 Genex 工具也是插件。在 Genex 仓库的检出目录中：

```bash
npm run plugin:new -- my-plugin --out ~/studio-plugins   # 从示例创建
npm run plugin:doctor -- ~/studio-plugins/my-plugin      # 按 Genex 的方式检查
```

1. **试用**：在应用中打开 **插件 → 添加 → 加载本地插件…**，然后选择文件夹。
2. **分享**：推送到公开的 GitHub 仓库，并为每个版本发布一个 release。
   这样任何人都可以通过 **插件 → 添加 → 从 GitHub 安装…** 来安装。
3. **上架**：向
   [genex-plugins](https://github.com/genex-games/genex-plugins/blob/main/CONTRIBUTING.md) 提交
   pull request。维护者审核后，它就会出现在每个 Genex 应用的插件市场里。

[插件指南](docs/PLUGIN_GUIDE.md)介绍了工具、面板、设置和账号。

### 文档

文档目前只有英文版。

- [产品概览](docs/agent/context.md)：应用能做什么，每个功能一页
- [开发者指南](docs/STUDIO-DEVELOPER-FIELD-GUIDE.md)：运行命令和数据存放位置
- [发布流程](docs/release-operations.md)：打包、签名和发布版本

<a id="code-signing-policy"></a>

### 代码签名政策

免费代码签名由 [SignPath.io](https://about.signpath.io/) 提供，证书由
[SignPath Foundation](https://signpath.org/) 提供。

只有 GitHub Actions 用本仓库源代码构建的 Windows 版本才会签名，且每个版本在签名前都要经过维护者批准。
在签名就绪之前，Windows 版本以未签名的预览版发布；每个版本都会在 `SHA256SUMS` 中列出每个文件的 SHA-256。

- 提交者和审查者：[genex-games 的成员](https://github.com/orgs/genex-games/people)
- 批准者：[genex-games 的所有者](https://github.com/orgs/genex-games/people?query=role%3Aowner)

隐私：Genex 会存储和发送哪些内容，请看它的[隐私政策](PRIVACY.md)；连接的服务商、插件和服务各有自己的政策。

---

[隐私](PRIVACY.md) · [安全](SECURITY.md) · [代码签名政策](#code-signing-policy) ·
[MIT 许可证](LICENSE)，copyright `genex.games` · [第三方声明](THIRD-PARTY-NOTICES.md)
