<p align="center">
  <a href="https://genex.games">
    <picture>
      <source srcset=".github/logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset=".github/logo-light.svg" media="(prefers-color-scheme: light)">
      <img src=".github/logo-light.svg" alt="Genex" width="320">
    </picture>
  </a>
</p>
<p align="center"><a href="README.md">English</a> · <b>Русский</b> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.zh-Hans.md">简体中文</a></p>
<p align="center">Десктопное приложение с открытым кодом для разработки игр с ИИ.<br>Агенты сами настраивают движок, собирают игру и тестируют её.</p>
<p align="center">
  <a href="https://github.com/genex-games/genex-desktop/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/genex-games/genex-desktop?style=flat-square" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/genex-games/genex-desktop?style=flat-square" /></a>
  <a href="https://github.com/genex-games/genex-desktop/actions/workflows/check.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/genex-games/genex-desktop/check.yml?branch=dev&style=flat-square&label=build" /></a>
</p>

<p align="center"><img src=".github/banner.png" alt="Genex — десктопное приложение для разработки игр с ИИ: Unreal Engine, Unity, Godot, Roblox и Three.js, со встроенными инструментами для геймдева" width="100%"></p>

---

### Скачать

| Платформа | Скачать |
| --- | --- |
| macOS (Apple Silicon) | [`Genex.dmg`](https://github.com/genex-games/genex-desktop/releases/latest/download/Genex.dmg) |
| Linux (x64) | `.deb`, `.rpm` или `.zip` из [последнего релиза](https://github.com/genex-games/genex-desktop/releases/latest). `.deb` и `.rpm` подключают репозиторий пакетов Genex, поэтому обновления системы (Software Updater, `apt`, `dnf`) сами приносят каждую новую версию |
| Windows (x64), предварительная версия | [`Genex-Setup.exe`](https://github.com/genex-games/genex-desktop/releases/latest/download/Genex-Setup.exe). Пока без подписи: если Windows предупреждает, нажми «Подробнее», затем «Выполнить в любом случае» |

Genex ещё на ранней стадии: где-то будут шероховатости. Расскажи нам о них в
[issues](https://github.com/genex-games/genex-desktop/issues).

### Что умеет

→ Создавай игры в Unreal Engine, Unity, Godot, Roblox Studio или Three.js\
→ Любой ИИ: Claude Code, Codex (ChatGPT), Antigravity, Cursor, Grok, OpenCode и OpenRouter\
→ Или локальные модели: Ollama, LM Studio, llama.cpp\
→ Несколько агентов: разные модели для главного агента, помощников и проверяющих\
→ Встроенные инструменты для геймдева: Blender, Tripo, Meshy, Uthana, ElevenLabs, fal\
→ Мультиплеер с игровой логикой на сервере — одним запросом\
→ Публикация в веб, на Mac, Windows и Linux

> [!TIP]
> Нужен инструмент для твоих игр? [Сделай плагин](#build-a-plugin) и выложи его в Маркетплейс
> Genex для всех.

### Участие в разработке

Понадобятся macOS на Apple Silicon, Git и Node 24.

```bash
git clone https://github.com/genex-games/genex-desktop.git
cd genex-desktop
nvm install && nvm use   # Node 24 из .nvmrc
npm ci
npm run studio:dev -- start --profile first-run --fixture app-basics
```

Фикстура запускает приложение со скриптовыми моделями и примерами игр, поэтому аккаунт не
нужен. Прежде чем открыть pull request, прочитай [CONTRIBUTING.md](CONTRIBUTING.md); агентам для
кода — начинать с [AGENTS.md](AGENTS.md).

<a id="build-a-plugin"></a>

### Сделать плагин

Плагины дают агентам Genex новые инструменты: генератор ассетов, мост к движку, сервис, с
которым работает твоя игра. Инструменты Blender и Genex, которые идут с приложением, — тоже
плагины. Из копии репозитория Genex:

```bash
npm run plugin:new -- my-plugin --out ~/studio-plugins   # создать по примеру
npm run plugin:doctor -- ~/studio-plugins/my-plugin      # проверить так же, как проверит Genex
```

1. **Попробовать**: в приложении открой **Плагины → Добавить → Загрузить локальный плагин…** и выбери папку.
2. **Поделиться**: выложи плагин в публичный репозиторий на GitHub и публикуй релиз для каждой версии.
   Тогда любой сможет поставить его через **Плагины → Добавить → Установить с GitHub…**.
3. **Добавить в каталог**: открой pull request в
   [genex-plugins](https://github.com/genex-games/genex-plugins/blob/main/CONTRIBUTING.md).
   Мейнтейнер его проверит, и плагин появится в Маркетплейсе каждого приложения Genex.

[Руководство по плагинам](docs/PLUGIN_GUIDE.md) рассказывает про инструменты, панели, настройки и аккаунты.

### Документация

Документация пока только на английском.

- [Обзор продукта](docs/agent/context.md): что умеет приложение, по странице на каждую функцию
- [Руководство разработчика](docs/STUDIO-DEVELOPER-FIELD-GUIDE.md): команды запуска и где хранятся данные
- [Выпуск релизов](docs/release-operations.md): сборка, подпись и публикация релиза

<a id="code-signing-policy"></a>

### Политика подписи кода

Бесплатную подпись кода предоставляет [SignPath.io](https://about.signpath.io/), сертификат —
[SignPath Foundation](https://signpath.org/).

Сборки для Windows подписываются, только если их собрал GitHub Actions из исходного кода этого
репозитория, и каждый релиз перед подписью одобряет мейнтейнер.
Пока подпись не настроена, сборки для Windows выходят без подписи как предварительная версия; в
каждом релизе SHA-256 каждого файла указан в `SHA256SUMS`.

- Коммитеры и ревьюеры: [участники genex-games](https://github.com/orgs/genex-games/people)
- Утверждают релизы: [владельцы genex-games](https://github.com/orgs/genex-games/people?query=role%3Aowner)

Конфиденциальность: что Genex хранит и отправляет, описано в его [политике конфиденциальности](PRIVACY.md);
у подключённых провайдеров, плагинов и сервисов свои политики.

---

[Конфиденциальность](PRIVACY.md) · [Безопасность](SECURITY.md) · [Политика подписи кода](#code-signing-policy) ·
[Лицензия MIT](LICENSE), copyright `genex.games` · [Стороннее ПО](THIRD-PARTY-NOTICES.md)
