<p align="center">
  <a href="https://genex.games">
    <picture>
      <source srcset=".github/logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset=".github/logo-light.svg" media="(prefers-color-scheme: light)">
      <img src=".github/logo-light.svg" alt="Genex" width="320">
    </picture>
  </a>
</p>
<p align="center"><a href="README.md">English</a> · <a href="README.ru.md">Русский</a> · <a href="README.es.md">Español</a> · <b>Português</b> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.zh-Hans.md">简体中文</a></p>
<p align="center">App desktop de código aberto para criar jogos com IA.<br>Os agentes configuram a engine, criam seu jogo e testam tudo sozinhos.</p>
<p align="center">
  <a href="https://github.com/genex-games/genex-desktop/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/genex-games/genex-desktop?style=flat-square" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/genex-games/genex-desktop?style=flat-square" /></a>
  <a href="https://github.com/genex-games/genex-desktop/actions/workflows/check.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/genex-games/genex-desktop/check.yml?branch=dev&style=flat-square&label=build" /></a>
</p>

<p align="center"><img src=".github/banner.png" alt="Genex, um app desktop para criar jogos com IA: Unreal Engine, Unity, Godot, Roblox e Three.js, com ferramentas de desenvolvimento de jogos integradas" width="100%"></p>

---

### Download

| Plataforma | Download |
| --- | --- |
| macOS (Apple Silicon) | [`Genex.dmg`](https://github.com/genex-games/genex-desktop/releases/latest/download/Genex.dmg) |
| Linux (x64) | `.deb`, `.rpm` ou `.zip` da [versão mais recente](https://github.com/genex-games/genex-desktop/releases/latest). O `.deb` e o `.rpm` adicionam o repositório de pacotes do Genex, então as atualizações do sistema (Software Updater, `apt`, `dnf`) trazem cada nova versão |
| Windows (x64), prévia | [`Genex-Setup.exe`](https://github.com/genex-games/genex-desktop/releases/latest/download/Genex-Setup.exe). Ainda sem assinatura: se o Windows avisar, clique em “Mais informações” e depois em “Executar assim mesmo” |

O Genex ainda está no começo: pode ter umas arestas para aparar. Conte para a gente em
[issues](https://github.com/genex-games/genex-desktop/issues).

### O que ele faz

→ Crie na Unreal Engine, Unity, Godot, Roblox Studio ou Three.js\
→ Qualquer IA: Claude Code, Codex (ChatGPT), Antigravity, Cursor, Grok, OpenCode e OpenRouter\
→ Ou modelos locais: Ollama, LM Studio, llama.cpp\
→ Vários agentes: misture modelos entre o agente principal, os ajudantes e os revisores\
→ Ferramentas de desenvolvimento de jogos integradas: Blender, Tripo, Meshy, Uthana, ElevenLabs, fal\
→ Multijogador com servidor autoritativo em um só prompt\
→ Publique para Web, Mac, Windows e Linux

> [!TIP]
> Seus jogos precisam de uma ferramenta? [Crie um plugin](#build-a-plugin) e coloque no Marketplace
> do Genex para todo mundo.

### Como contribuir

Você precisa de macOS em Apple Silicon, Git e Node 24.

```bash
git clone https://github.com/genex-games/genex-desktop.git
cd genex-desktop
nvm install && nvm use   # Node 24, do .nvmrc
npm ci
npm run studio:dev -- start --profile first-run --fixture app-basics
```

O fixture abre o app com modelos simulados e jogos de exemplo, então não precisa de conta. Leia o
[CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir um pull request; agentes de código começam pelo
[AGENTS.md](AGENTS.md).

<a id="build-a-plugin"></a>

### Criar um plugin

Plugins dão novas ferramentas aos agentes do Genex: um gerador de recursos, uma ponte com uma
engine, um serviço com que seu jogo conversa. As ferramentas do Blender e do Genex que vêm com o
app também são plugins. A partir de uma cópia do repositório do Genex:

```bash
npm run plugin:new -- my-plugin --out ~/studio-plugins   # cria a partir do exemplo
npm run plugin:doctor -- ~/studio-plugins/my-plugin      # verifica do jeito que o Genex vai verificar
```

1. **Teste**: no app, vá em **Plugins → Adicionar → Carregar plugin local…** e escolha a pasta.
2. **Compartilhe**: envie para um repositório público no GitHub e publique uma release para cada versão.
   Qualquer pessoa pode instalar de lá com **Plugins → Adicionar → Instalar do GitHub…**.
3. **Liste no catálogo**: abra um pull request para o
   [genex-plugins](https://github.com/genex-games/genex-plugins/blob/main/CONTRIBUTING.md). Um
   mantenedor revisa, e o plugin aparece no Marketplace de todos os apps do Genex.

O [guia de plugins](docs/PLUGIN_GUIDE.md) explica ferramentas, painéis, configurações e contas.

### Documentação

Por enquanto, a documentação está só em inglês.

- [Visão geral do produto](docs/agent/context.md): o que o app faz, com uma página por recurso
- [Guia de desenvolvimento](docs/STUDIO-DEVELOPER-FIELD-GUIDE.md): comandos e onde ficam os dados
- [Publicação de versões](docs/release-operations.md): empacotar, assinar e publicar uma versão

<a id="code-signing-policy"></a>

### Política de assinatura de código

Assinatura de código gratuita da [SignPath.io](https://about.signpath.io/), certificado da
[SignPath Foundation](https://signpath.org/).

As builds para Windows só são assinadas quando o GitHub Actions as gera a partir do código deste
repositório, e um mantenedor aprova cada versão antes da assinatura.
Enquanto a assinatura não estiver pronta, as builds para Windows saem sem assinatura como prévia;
cada versão lista o SHA-256 de cada arquivo em `SHA256SUMS`.

- Committers e revisores: [membros da genex-games](https://github.com/orgs/genex-games/people)
- Aprovadores: [donos da genex-games](https://github.com/orgs/genex-games/people?query=role%3Aowner)

Privacidade: o que o Genex guarda e envia está na [política de privacidade](PRIVACY.md); os
provedores, plugins e serviços conectados têm as próprias políticas.

---

[Privacidade](PRIVACY.md) · [Segurança](SECURITY.md) · [Política de assinatura de código](#code-signing-policy) ·
[Licença MIT](LICENSE), copyright `genex.games` · [Avisos de terceiros](THIRD-PARTY-NOTICES.md)
