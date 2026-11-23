<p align="center">
  <a href="https://genex.games">
    <picture>
      <source srcset=".github/logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset=".github/logo-light.svg" media="(prefers-color-scheme: light)">
      <img src=".github/logo-light.svg" alt="Genex" width="320">
    </picture>
  </a>
</p>
<p align="center"><a href="README.md">English</a> · <a href="README.ru.md">Русский</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.de.md">Deutsch</a> · <b>Français</b> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.zh-Hans.md">简体中文</a></p>
<p align="center">App de bureau open source pour créer des jeux avec l’IA.<br>Les agents configurent le moteur, créent ton jeu et le testent tout seuls.</p>
<p align="center">
  <a href="https://github.com/genex-games/genex-desktop/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/genex-games/genex-desktop?style=flat-square" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/genex-games/genex-desktop?style=flat-square" /></a>
  <a href="https://github.com/genex-games/genex-desktop/actions/workflows/check.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/genex-games/genex-desktop/check.yml?branch=dev&style=flat-square&label=build" /></a>
</p>

<p align="center"><img src=".github/banner.png" alt="Genex, une app de bureau pour créer des jeux avec l’IA : Unreal Engine, Unity, Godot, Roblox et Three.js, avec des outils de création de jeux intégrés" width="100%"></p>

---

### Télécharger

| Plateforme | Télécharger |
| --- | --- |
| macOS (Apple Silicon) | [`Genex.dmg`](https://github.com/genex-games/genex-desktop/releases/latest/download/Genex.dmg) |
| Linux (x64) | `.deb`, `.rpm` ou `.zip` de la [dernière version](https://github.com/genex-games/genex-desktop/releases/latest). Le `.deb` et le `.rpm` ajoutent le dépôt de paquets de Genex : les mises à jour de ton système (Software Updater, `apt`, `dnf`) apportent ensuite chaque nouvelle version |
| Windows (x64), préversion | [`Genex-Setup.exe`](https://github.com/genex-games/genex-desktop/releases/latest/download/Genex-Setup.exe). Pas encore signé : si Windows affiche un avertissement, choisis « Informations complémentaires », puis « Exécuter quand même » |

Genex débute : attends-toi à quelques imperfections, et parle-nous-en dans les
[issues](https://github.com/genex-games/genex-desktop/issues).

### Ce qu’il fait

→ Crée dans Unreal Engine, Unity, Godot, Roblox Studio ou Three.js\
→ N’importe quelle IA : Claude Code, Codex (ChatGPT), Antigravity, Cursor, Grok, OpenCode et OpenRouter\
→ Ou des modèles locaux : Ollama, LM Studio, llama.cpp\
→ Plusieurs agents : mélange les modèles entre l’agent principal, les assistants et les vérificateurs\
→ Outils de création de jeux intégrés : Blender, Tripo, Meshy, Uthana, ElevenLabs, fal\
→ Multijoueur avec serveur autoritaire en un seul prompt\
→ Publie sur le Web, Mac, Windows et Linux

> [!TIP]
> Tes jeux ont besoin d’un outil ? [Crée un plugin](#build-a-plugin) et mets-le dans le Marketplace
> de Genex pour tout le monde.

### Contribuer

Il te faut macOS sur Apple Silicon, Git et Node 24.

```bash
git clone https://github.com/genex-games/genex-desktop.git
cd genex-desktop
nvm install && nvm use   # Node 24, d’après .nvmrc
npm ci
npm run studio:dev -- start --profile first-run --fixture app-basics
```

La fixture lance l’app avec des modèles scriptés et des jeux d’exemple, donc pas besoin de compte.
Lis [CONTRIBUTING.md](CONTRIBUTING.md) avant d’ouvrir une pull request ; les agents de code
commencent par [AGENTS.md](AGENTS.md).

<a id="build-a-plugin"></a>

### Créer un plugin

Les plugins donnent de nouveaux outils aux agents de Genex : un générateur de ressources, un pont
vers un moteur, un service avec lequel ton jeu communique. Les outils Blender et Genex fournis avec
l’app sont aussi des plugins. Depuis une copie du dépôt Genex :

```bash
npm run plugin:new -- my-plugin --out ~/studio-plugins   # le créer à partir de l’exemple
npm run plugin:doctor -- ~/studio-plugins/my-plugin      # le vérifier comme Genex le fera
```

1. **Essaie-le** : dans l’app, ouvre **Plugins → Ajouter → Charger un plugin local…** et choisis le dossier.
2. **Partage-le** : pousse-le dans un dépôt GitHub public et publie une release pour chaque version.
   Tout le monde pourra l’installer depuis là avec **Plugins → Ajouter → Installer depuis GitHub…**.
3. **Fais-le référencer** : ouvre une pull request sur
   [genex-plugins](https://github.com/genex-games/genex-plugins/blob/main/CONTRIBUTING.md). Un
   mainteneur la relit, et le plugin apparaît dans le Marketplace de chaque app Genex.

Le [guide des plugins](docs/PLUGIN_GUIDE.md) couvre les outils, les panneaux, les réglages et les comptes.

### Documentation

Pour l’instant, la documentation n’existe qu’en anglais.

- [Présentation du produit](docs/agent/context.md) : ce que fait l’app, avec une page par fonctionnalité
- [Guide du développeur](docs/STUDIO-DEVELOPER-FIELD-GUIDE.md) : les commandes et où sont les données
- [Publication des versions](docs/release-operations.md) : empaqueter, signer et publier une version

<a id="code-signing-policy"></a>

### Politique de signature du code

Signature de code gratuite fournie par [SignPath.io](https://about.signpath.io/), certificat de la
[SignPath Foundation](https://signpath.org/).

Les builds Windows ne sont signés que lorsque GitHub Actions les construit à partir du code source de
ce dépôt, et un mainteneur approuve chaque version avant sa signature.
En attendant, les builds Windows sont publiés non signés, en préversion ; chaque version indique
le SHA-256 de chaque fichier dans `SHA256SUMS`.

- Contributeurs et relecteurs : [membres de genex-games](https://github.com/orgs/genex-games/people)
- Approbateurs : [propriétaires de genex-games](https://github.com/orgs/genex-games/people?query=role%3Aowner)

Confidentialité : ce que Genex enregistre et envoie est décrit dans sa [politique de confidentialité](PRIVACY.md) ;
les fournisseurs, plugins et services connectés ont leurs propres politiques.

---

[Confidentialité](PRIVACY.md) · [Sécurité](SECURITY.md) · [Signature du code](#code-signing-policy) ·
[Licence MIT](LICENSE), copyright `genex.games` · [Mentions tierces](THIRD-PARTY-NOTICES.md)
