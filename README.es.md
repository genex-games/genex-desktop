<p align="center">
  <a href="https://genex.games">
    <picture>
      <source srcset=".github/logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset=".github/logo-light.svg" media="(prefers-color-scheme: light)">
      <img src=".github/logo-light.svg" alt="Genex" width="320">
    </picture>
  </a>
</p>
<p align="center"><a href="README.md">English</a> · <a href="README.ru.md">Русский</a> · <b>Español</b> · <a href="README.pt-BR.md">Português</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.zh-Hans.md">简体中文</a></p>
<p align="center">App de escritorio de código abierto para crear juegos con IA.<br>Los agentes configuran el motor, crean tu juego y lo prueban por su cuenta.</p>
<p align="center">
  <a href="https://github.com/genex-games/genex-desktop/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/genex-games/genex-desktop?style=flat-square" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/genex-games/genex-desktop?style=flat-square" /></a>
  <a href="https://github.com/genex-games/genex-desktop/actions/workflows/check.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/genex-games/genex-desktop/check.yml?branch=dev&style=flat-square&label=build" /></a>
</p>

<p align="center"><img src=".github/banner.png" alt="Genex, una app de escritorio para crear juegos con IA: Unreal Engine, Unity, Godot, Roblox y Three.js, con herramientas de desarrollo de juegos integradas" width="100%"></p>

---

### Descargar

| Plataforma | Descargar |
| --- | --- |
| macOS (Apple Silicon) | [`Genex.dmg`](https://github.com/genex-games/genex-desktop/releases/latest/download/Genex.dmg) |
| Linux (x64) | `.deb`, `.rpm` o `.zip` de la [última versión](https://github.com/genex-games/genex-desktop/releases/latest). El `.deb` y el `.rpm` añaden el repositorio de paquetes de Genex, así que las actualizaciones de tu sistema (Software Updater, `apt`, `dnf`) traen cada versión nueva |
| Windows (x64), versión preliminar | [`Genex-Setup.exe`](https://github.com/genex-games/genex-desktop/releases/latest/download/Genex-Setup.exe). Todavía sin firmar: si Windows te avisa, elige «Más información» y luego «Ejecutar de todas formas» |

Genex está en sus inicios: puede que encuentres detalles por pulir. Cuéntanoslos en
[issues](https://github.com/genex-games/genex-desktop/issues).

### Qué hace

→ Crea en Unreal Engine, Unity, Godot, Roblox Studio o Three.js\
→ Cualquier IA: Claude Code, Codex (ChatGPT), Antigravity, Cursor, Grok, OpenCode y OpenRouter\
→ O modelos locales: Ollama, LM Studio, llama.cpp\
→ Varios agentes: combina modelos para el agente principal, los ayudantes y los revisores\
→ Herramientas de desarrollo de juegos integradas: Blender, Tripo, Meshy, Uthana, ElevenLabs, fal\
→ Multijugador con servidor autoritativo en un solo prompt\
→ Publica para Web, Mac, Windows y Linux

> [!TIP]
> ¿Tus juegos necesitan una herramienta? [Crea un plugin](#build-a-plugin) y súbelo al Marketplace
> de Genex para todos.

### Contribuir

Necesitas macOS en Apple Silicon, Git y Node 24.

```bash
git clone https://github.com/genex-games/genex-desktop.git
cd genex-desktop
nvm install && nvm use   # Node 24, según .nvmrc
npm ci
npm run studio:dev -- start --profile first-run --fixture app-basics
```

El fixture abre la app con modelos simulados y juegos de ejemplo, así que no necesitas cuenta.
Lee [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir un pull request; los agentes de código
empiezan por [AGENTS.md](AGENTS.md).

<a id="build-a-plugin"></a>

### Crear un plugin

Los plugins dan nuevas herramientas a los agentes de Genex: un generador de recursos, un puente
con un motor, un servicio con el que habla tu juego. Las herramientas de Blender y de Genex que
vienen con la app también son plugins. Desde una copia del repositorio de Genex:

```bash
npm run plugin:new -- my-plugin --out ~/studio-plugins   # créalo a partir del ejemplo
npm run plugin:doctor -- ~/studio-plugins/my-plugin      # revísalo como lo hará Genex
```

1. **Pruébalo**: en la app, ve a **Plugins → Añadir → Cargar plugin local…** y elige la carpeta.
2. **Compártelo**: súbelo a un repositorio público de GitHub y publica una release para cada versión.
   Cualquiera podrá instalarlo desde ahí con **Plugins → Añadir → Instalar desde GitHub…**.
3. **Publícalo en el catálogo**: abre un pull request en
   [genex-plugins](https://github.com/genex-games/genex-plugins/blob/main/CONTRIBUTING.md). Un
   mantenedor lo revisa y aparece en el Marketplace de todas las apps de Genex.

La [guía de plugins](docs/PLUGIN_GUIDE.md) explica herramientas, paneles, ajustes y cuentas.

### Documentación

Por ahora, la documentación solo está en inglés.

- [Visión general del producto](docs/agent/context.md): qué hace la app, con una página por función
- [Guía para desarrolladores](docs/STUDIO-DEVELOPER-FIELD-GUIDE.md): comandos y dónde se guardan los datos
- [Publicar una versión](docs/release-operations.md): empaquetar, firmar y publicar

<a id="code-signing-policy"></a>

### Política de firma de código

Firma de código gratuita de [SignPath.io](https://about.signpath.io/), certificado de
[SignPath Foundation](https://signpath.org/).

Las builds de Windows solo se firman cuando GitHub Actions las genera a partir del código de este
repositorio, y un mantenedor aprueba cada versión antes de firmarla.
Mientras la firma no esté lista, las builds de Windows salen sin firmar como versión preliminar;
cada versión incluye el SHA-256 de cada archivo en `SHA256SUMS`.

- Committers y revisores: [miembros de genex-games](https://github.com/orgs/genex-games/people)
- Aprobadores: [propietarios de genex-games](https://github.com/orgs/genex-games/people?query=role%3Aowner)

Privacidad: lo que Genex guarda y envía está en su [política de privacidad](PRIVACY.md); los
proveedores, plugins y servicios que conectes tienen sus propias políticas.

---

[Privacidad](PRIVACY.md) · [Seguridad](SECURITY.md) · [Política de firma de código](#code-signing-policy) ·
[Licencia MIT](LICENSE), copyright `genex.games` · [Avisos de terceros](THIRD-PARTY-NOTICES.md)
