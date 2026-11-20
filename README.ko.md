<p align="center">
  <a href="https://genex.games">
    <picture>
      <source srcset=".github/logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset=".github/logo-light.svg" media="(prefers-color-scheme: light)">
      <img src=".github/logo-light.svg" alt="Genex" width="320">
    </picture>
  </a>
</p>
<p align="center"><a href="README.md">English</a> · <a href="README.ru.md">Русский</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a> · <a href="README.ja.md">日本語</a> · <b>한국어</b> · <a href="README.zh-Hans.md">简体中文</a></p>
<p align="center">AI로 게임을 만드는 오픈 소스 데스크톱 앱.<br>에이전트가 엔진을 준비하고, 게임을 만들고, 직접 플레이 테스트까지 해요.</p>
<p align="center">
  <a href="https://github.com/genex-games/genex-desktop/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/genex-games/genex-desktop?style=flat-square" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/genex-games/genex-desktop?style=flat-square" /></a>
  <a href="https://github.com/genex-games/genex-desktop/actions/workflows/check.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/genex-games/genex-desktop/check.yml?branch=dev&style=flat-square&label=build" /></a>
</p>

<p align="center"><img src=".github/banner.png" alt="Genex, AI로 게임을 만드는 데스크톱 앱: Unreal Engine, Unity, Godot, Roblox, Three.js 지원, 게임 개발 도구 내장" width="100%"></p>

---

### 다운로드

| 플랫폼 | 다운로드 |
| --- | --- |
| macOS (Apple Silicon) | [`Genex.dmg`](https://github.com/genex-games/genex-desktop/releases/latest/download/Genex.dmg) |
| Linux (x64) | [최신 릴리스](https://github.com/genex-games/genex-desktop/releases/latest)에서 `.deb`, `.rpm` 또는 `.zip`을 받으세요. `.deb`와 `.rpm`은 Genex 패키지 저장소를 추가하므로, 시스템 업데이트(Software Updater, `apt`, `dnf`)로 이후 버전도 받을 수 있어요 |
| Windows (x64), 미리 보기 | [`Genex-Setup.exe`](https://github.com/genex-games/genex-desktop/releases/latest/download/Genex-Setup.exe). 아직 서명되지 않았어요. Windows가 경고하면 '추가 정보'를 누른 뒤 '실행'을 선택하세요 |

Genex는 아직 초기 단계라 다듬어지지 않은 부분이 있을 수 있어요.
[issues](https://github.com/genex-games/genex-desktop/issues)에서 알려 주세요.

### 할 수 있는 일

→ Unreal Engine, Unity, Godot, Roblox Studio 또는 Three.js로 만들기\
→ 원하는 AI 사용: Claude Code, Codex (ChatGPT), Antigravity, Cursor, Grok, OpenCode, OpenRouter\
→ 로컬 모델도 가능: Ollama, LM Studio, llama.cpp\
→ 멀티 에이전트: 메인 에이전트, 작업자, 리뷰어에 각각 다른 모델 사용\
→ 게임 개발 도구 내장: Blender, Tripo, Meshy, Uthana, ElevenLabs, fal\
→ 프롬프트 하나로 서버 권한 방식 멀티플레이\
→ Web, Mac, Windows, Linux로 게시

> [!TIP]
> 게임에 필요한 도구가 있나요? [플러그인을 만들어](#build-a-plugin) Genex 마켓플레이스에 올려
> 모두와 나눠 보세요.

### 기여하기

Apple Silicon macOS, Git, Node 24가 필요해요.

```bash
git clone https://github.com/genex-games/genex-desktop.git
cd genex-desktop
nvm install && nvm use   # .nvmrc의 Node 24
npm ci
npm run studio:dev -- start --profile first-run --fixture app-basics
```

픽스처는 스크립트로 동작하는 모델과 예제 게임으로 앱을 실행하므로 계정이 필요 없어요. 풀 리퀘스트를
열기 전에 [CONTRIBUTING.md](CONTRIBUTING.md)를 읽어 주세요. 코딩 에이전트는
[AGENTS.md](AGENTS.md)부터 시작해요.

<a id="build-a-plugin"></a>

### 플러그인 만들기

플러그인은 Genex 에이전트에게 새 도구를 줘요. 에셋 생성기, 엔진 연결, 게임이 통신하는 서비스
같은 것들이죠. 앱에 기본으로 들어 있는 Blender와 Genex 도구도 플러그인이에요. Genex 저장소를
체크아웃한 폴더에서:

```bash
npm run plugin:new -- my-plugin --out ~/studio-plugins   # 예제로 만들기
npm run plugin:doctor -- ~/studio-plugins/my-plugin      # Genex와 같은 방식으로 검사하기
```

1. **써 보기**: 앱에서 **플러그인 → 추가 → 로컬 플러그인 불러오기…** 를 열고 폴더를 고르세요.
2. **공유하기**: 공개 GitHub 저장소에 올리고 버전마다 릴리스를 게시하세요.
   그러면 누구나 **플러그인 → 추가 → GitHub에서 설치…** 로 설치할 수 있어요.
3. **목록에 올리기**:
   [genex-plugins](https://github.com/genex-games/genex-plugins/blob/main/CONTRIBUTING.md)에 풀
   리퀘스트를 여세요. 메인테이너가 검토하면 모든 Genex 앱의 마켓플레이스에 나타나요.

도구, 패널, 설정, 계정은 [플러그인 가이드](docs/PLUGIN_GUIDE.md)에서 다뤄요.

### 문서

문서는 아직 영어로만 있어요.

- [제품 개요](docs/agent/context.md): 앱이 하는 일, 기능마다 한 페이지
- [개발자 가이드](docs/STUDIO-DEVELOPER-FIELD-GUIDE.md): 실행 명령과 데이터 위치
- [릴리스 운영](docs/release-operations.md): 패키징, 서명, 릴리스 게시

<a id="code-signing-policy"></a>

### 코드 서명 정책

무료 코드 서명은 [SignPath.io](https://about.signpath.io/)가, 인증서는
[SignPath Foundation](https://signpath.org/)이 제공해요.

Windows 빌드는 GitHub Actions가 이 저장소의 소스로 빌드한 경우에만 서명되며, 메인테이너가 각
릴리스를 서명 전에 승인해요.
서명이 준비될 때까지 Windows 빌드는 서명 없이 미리 보기로 나가요. 모든 릴리스는 각 파일의
SHA-256을 `SHA256SUMS`에 적어 둬요.

- 커미터와 리뷰어: [genex-games 멤버](https://github.com/orgs/genex-games/people)
- 승인자: [genex-games 소유자](https://github.com/orgs/genex-games/people?query=role%3Aowner)

개인정보: Genex가 저장하고 보내는 내용은 [개인정보 처리방침](PRIVACY.md)에 있어요. 연결한
제공자, 플러그인, 서비스는 각자의 정책을 따라요.

---

[개인정보](PRIVACY.md) · [보안](SECURITY.md) · [코드 서명 정책](#code-signing-policy) ·
[MIT 라이선스](LICENSE), copyright `genex.games` · [서드파티 고지](THIRD-PARTY-NOTICES.md)
