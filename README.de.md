<p align="center">
  <a href="https://genex.games">
    <picture>
      <source srcset=".github/logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset=".github/logo-light.svg" media="(prefers-color-scheme: light)">
      <img src=".github/logo-light.svg" alt="Genex" width="320">
    </picture>
  </a>
</p>
<p align="center"><a href="README.md">English</a> · <a href="README.ru.md">Русский</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português</a> · <b>Deutsch</b> · <a href="README.fr.md">Français</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.zh-Hans.md">简体中文</a></p>
<p align="center">Open-Source-Desktop-App für Spieleentwicklung mit KI.<br>Agenten richten die Engine ein, bauen dein Spiel und testen es selbst.</p>
<p align="center">
  <a href="https://github.com/genex-games/genex-desktop/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/genex-games/genex-desktop?style=flat-square" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/genex-games/genex-desktop?style=flat-square" /></a>
  <a href="https://github.com/genex-games/genex-desktop/actions/workflows/check.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/genex-games/genex-desktop/check.yml?branch=dev&style=flat-square&label=build" /></a>
</p>

<p align="center"><img src=".github/banner.png" alt="Genex, eine Desktop-App für Spieleentwicklung mit KI: Unreal Engine, Unity, Godot, Roblox und Three.js, mit eingebauten Game-Dev-Tools" width="100%"></p>

---

### Download

| Plattform | Download |
| --- | --- |
| macOS (Apple Silicon) | [`Genex.dmg`](https://github.com/genex-games/genex-desktop/releases/latest/download/Genex.dmg) |
| Linux (x64) | `.deb`, `.rpm` oder `.zip` aus dem [neuesten Release](https://github.com/genex-games/genex-desktop/releases/latest). `.deb` und `.rpm` fügen das Paket-Repository von Genex hinzu, damit die Updates deines Systems (Software Updater, `apt`, `dnf`) jede neue Version mitbringen |
| Windows (x64), Vorschau | [`Genex-Setup.exe`](https://github.com/genex-games/genex-desktop/releases/latest/download/Genex-Setup.exe). Noch nicht signiert: Wenn Windows warnt, wähle „Weitere Informationen“ und dann „Trotzdem ausführen“ |

Genex ist noch früh dran: Rechne mit Ecken und Kanten und erzähl uns davon in den
[Issues](https://github.com/genex-games/genex-desktop/issues).

### Was es kann

→ Bau in Unreal Engine, Unity, Godot, Roblox Studio oder Three.js\
→ Jede KI: Claude Code, Codex (ChatGPT), Antigravity, Cursor, Grok, OpenCode und OpenRouter\
→ Oder lokale Modelle: Ollama, LM Studio, llama.cpp\
→ Mehrere Agenten: Kombiniere Modelle für Hauptagent, Helfer und Prüfer\
→ Eingebaute Game-Dev-Tools: Blender, Tripo, Meshy, Uthana, ElevenLabs, fal\
→ Mehrspieler mit autoritativem Server in einem einzigen Prompt\
→ Veröffentlichen für Web, Mac, Windows und Linux

> [!TIP]
> Deine Spiele brauchen ein Tool? [Bau ein Plugin](#build-a-plugin) und stell es für alle in den
> Genex Marketplace.

### Mitmachen

Du brauchst macOS auf Apple Silicon, Git und Node 24.

```bash
git clone https://github.com/genex-games/genex-desktop.git
cd genex-desktop
nvm install && nvm use   # Node 24, aus .nvmrc
npm ci
npm run studio:dev -- start --profile first-run --fixture app-basics
```

Die Fixture startet die App mit geskripteten Modellen und Beispielspielen, du brauchst also kein
Konto. Lies [CONTRIBUTING.md](CONTRIBUTING.md), bevor du einen Pull Request öffnest;
Coding-Agenten fangen bei [AGENTS.md](AGENTS.md) an.

<a id="build-a-plugin"></a>

### Ein Plugin bauen

Plugins geben den Agenten von Genex neue Tools: einen Asset-Generator, eine Brücke zu einer
Engine, einen Dienst, mit dem dein Spiel spricht. Die Blender- und Genex-Tools, die mit der App
kommen, sind auch Plugins. Aus einem Genex-Checkout:

```bash
npm run plugin:new -- my-plugin --out ~/studio-plugins   # aus dem Beispiel anlegen
npm run plugin:doctor -- ~/studio-plugins/my-plugin      # so prüfen, wie Genex es prüft
```

1. **Ausprobieren**: In der App **Plugins → Hinzufügen → Lokales Plugin laden…** öffnen und den Ordner wählen.
2. **Teilen**: Lade es in ein öffentliches GitHub-Repository hoch und veröffentliche für jede Version ein Release.
   Dann kann es jeder mit **Plugins → Hinzufügen → Von GitHub installieren…** installieren.
3. **Listen**: Öffne einen Pull Request bei
   [genex-plugins](https://github.com/genex-games/genex-plugins/blob/main/CONTRIBUTING.md). Ein
   Maintainer prüft ihn, und das Plugin erscheint im Marketplace jeder Genex-App.

Der [Plugin-Leitfaden](docs/PLUGIN_GUIDE.md) erklärt Tools, Panels, Einstellungen und Konten.

### Dokumentation

Die Dokumentation gibt es vorerst nur auf Englisch.

- [Produktüberblick](docs/agent/context.md): was die App kann, mit einer Seite pro Funktion
- [Entwickler-Leitfaden](docs/STUDIO-DEVELOPER-FIELD-GUIDE.md): Befehle und wo die Daten liegen
- [Releases](docs/release-operations.md): ein Release paketieren, signieren und veröffentlichen

<a id="code-signing-policy"></a>

### Richtlinie zur Code-Signierung

Kostenlose Code-Signierung von [SignPath.io](https://about.signpath.io/), Zertifikat von der
[SignPath Foundation](https://signpath.org/).

Windows-Builds werden nur signiert, wenn GitHub Actions sie aus dem Quellcode dieses Repositorys
baut, und ein Maintainer gibt jedes Release frei, bevor es signiert wird.
Bis die Signierung steht, erscheinen Windows-Builds unsigniert als Vorschau; jedes Release listet
die SHA-256 jeder Datei in `SHA256SUMS`.

- Committer und Reviewer: [Mitglieder von genex-games](https://github.com/orgs/genex-games/people)
- Freigabe: [Owner von genex-games](https://github.com/orgs/genex-games/people?query=role%3Aowner)

Datenschutz: Was Genex speichert und sendet, steht in der [Datenschutzerklärung](PRIVACY.md);
verbundene Anbieter, Plugins und Dienste haben eigene Richtlinien.

---

[Datenschutz](PRIVACY.md) · [Sicherheit](SECURITY.md) · [Code-Signierung](#code-signing-policy) ·
[MIT-Lizenz](LICENSE), copyright `genex.games` · [Hinweise zu Drittanbietern](THIRD-PARTY-NOTICES.md)
