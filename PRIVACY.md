# Desktop data and privacy

Updated October 20, 2026. Contact: **team@genex.games**. This describes the desktop
application. Connected providers, plugins and the hosted Genex service have separate policies.

## Local storage

Games remain in the selected games folder. The application profile holds conversation events,
model usage, run evidence, screenshots, installed harness instructions, proposals, plugin data
and settings. Game and harness Git snapshots retain earlier file versions. Deleting a visible
message or disconnecting a service does not erase those versions.

Provider sign-ins belong to their CLI or account integration. Studio stores its own plugin and
connector secrets through the operating system's encrypted storage. Provider credentials are
excluded from renderer messages and ordinary event logs. A native plugin is executable code
with the user's access; process isolation is not a security sandbox.

Conversation history, recovery snapshots and plugin data have no automatic expiry. Diagnostic
log rotation is bounded separately. Removal of a plugin preserves its data; replacing it with
another source has a separate erase operation. Back up the profile and games before manually
deleting them. Deletion of local data does not delete a provider's or hosted service's records.

## Network and model use

The selected model receives conversation context, relevant instructions, tool results and
selected files or screenshots needed for the request. Cloud providers process these under
their account terms. Local models run on the machine; model installation still downloads
weights. Provider CLIs retain their own telemetry and account controls.

Installed macOS and Windows release builds ask update.electronjs.org (run by the Electron
project) hourly whether a newer release exists, sending the app version, platform and
architecture, and download it from GitHub Releases. Installed Linux release builds ask the GitHub
API for the latest published release every six hours (and when you choose Check for Updates),
which sends nothing beyond the request itself; the download is yours to start. The `.deb` and
`.rpm` add the Genex package repository (packages.genex.games, served by Cloudflare), so your
system's package manager asks it for updates on its own schedule, as it does every repository;
those copies then ask GitHub nothing. Removing Genex removes the repository; to keep it out, put
`repo=off` in `/etc/default/genex` before installing. Development
builds and builds you package yourself under another name do not check.

The catalog downloads listings and pinned plugin packages anonymously from its configured
hosts and GitHub. Asset generation and publishing contact Genex using the connected account.
Links to genex.games that Studio opens in your browser carry `s=desktop`, so the site can tell
the visit came from the app; the tag is the same for everyone and adds nothing else.
Connector tools contact their configured service. Each connector call asks for consent unless
the user saved an exact tool grant in Settings. Revocation blocks subsequent calls; it cannot
undo a remote action or recall data already sent.

| Feature | Needs |
| --- | --- |
| Creating, opening, previewing, checking and exporting games | Nothing beyond a model below; exports are static web bundles |
| Local models | [Ollama](https://ollama.com) running on this Mac, or a Bonsai model downloaded in Settings (Apple Silicon) |
| Claude models | [Claude Code](https://code.claude.com/docs/en/setup), installed separately and signed in with a Claude subscription |
| ChatGPT/Codex models | The [Codex CLI](https://developers.openai.com/codex/cli/), installed separately; **Connect ChatGPT** signs in through your browser |
| Blender assets | Blender on this Mac, or one click downloads a pinned release from download.blender.org |
| Plugin catalog | Anonymous downloads from `plugins.genex.games` and GitHub |
| Genex asset generation, credits and hosted publishing | A Genex account (paid credits); publishing also needs `git-lfs` |
| Play | Nothing to browse and play; likes, comments, signed-in play, paying coin in games, invite links, profiles and friends need a Genex account; Remix needs `git`; voice chat needs microphone access (macOS asks once) |
| OpenRouter models | An OpenRouter account; prompts and context go to openrouter.ai and the model maker it routes to |
| OpenCode models | [OpenCode](https://opencode.ai), installed separately; prompts go to whatever provider OpenCode is set up with |
| Local server models | A model server you run (TabbyAPI, LM Studio, llama.cpp, vLLM); prompts go to the address you enter, which may be another computer on your network |

Studio finds Claude Code and Codex through a manual override, your login-shell `PATH`, then
standard locations, and never installs or updates them unless you choose that in Settings.
Subscription limits apply; there is no fallback to API-key billing, and an ambient
`ANTHROPIC_API_KEY` is not used. Provider tokens never reach the renderer or the event log. The
bundled Genex CLI runs with its crash reporting off unless you set `GENEX_TELEMETRY`;
`DO_NOT_TRACK` and `GENEX_DISABLE_SENTRY` are passed on to it.

**Let agents control your computer** (Settings → Permissions, macOS and Windows) is off by default.
With it on, an agent can click and type in the apps you allow, through the cua-driver bundled with
Genex, which on a Mac uses Genex's own Screen Recording and Accessibility access; on Windows a small
PowerShell helper also tells Genex which app is in front and which app a click reaches. Each chat
session asks you first, each app is asked for once, and ⌃⌥⌘Esc (Ctrl+Alt+Shift+Esc on Windows)
stops it; the driver stops 30 s after the last session ends. On a Mac, without the setting,
agents can still look at an app's window (`app_look`: its picture and the text of its controls),
never at System Settings, the login and password prompts, password managers or Genex itself.
Those screenshots and window texts go to the selected model provider like any other tool result.

Opening a folder does not authorize its Claude settings or hooks. The Open Game trust checkbox
is an explicit choice because hooks can run commands with the user's access. Interactive
permission modes and native plugins have broader reach than unattended sandboxed workers.

## Engine plugins

The Unity, Godot, Roblox and Unreal plugins work in the engine's own app on this computer. Each
engine's own terms apply to its app, its account and what you publish with it; Genex never signs
in for you.

- **Unity.** Setup adds Unity's Pipeline package (`com.unity.pipeline`) to your game's Unity
  project, and Genex talks to your open editor through it on 127.0.0.1. Scene data, console
  output and Game view captures go to the model. Getting Unity downloads Unity Hub from
  `public-cdn.cloud.unity3d.com`; Hub then installs the editor. To find open editors Genex reads
  the list of running processes.
- **Godot.** Getting Godot downloads it from Godot's GitHub releases. Setup writes Genex's add-on
  (`addons/genex`) into the project.
- **Roblox.** Getting Roblox Studio downloads it from `setup.rbxcdn.com`. Genex puts its helper
  plugin into Studio and uses Studio's built-in MCP server. Publishing, uploads and Creator Store
  inserts run on your own Roblox account, each after you approve it. The Luau checks download
  from GitHub, and selene fetches Roblox's API list on its first run.
- **Unreal.** Setup copies Genex's editor helper into the project, and Genex talks to Epic's
  editor MCP server on 127.0.0.1.

Installing Unity Hub or Godot first moves an older app of the same name to the Trash. Captures
and text an engine returns reach the model like any other tool result.

## Play

Play reads the genex.games catalog from `https://api.genex.games` without a sign-in: the lists of
games, tools and assets, which tabs have something in them, the search catalog and, every 20 seconds while the dashboard
is in view, how many people are in its multiplayer games. Covers and author pictures load from
cdn.genex.technology, assets.genex.games, assets.genex.technology, api.genex.games, Google
(lh3.googleusercontent.com) and GitHub (avatars.githubusercontent.com). A game's five-second cover
clip loads from cdn.genex.technology only while you rest the pointer on its card.

Playing a game loads it from its own `https://<name>.genex.technology/` address, and genex.games
counts the play. The game runs in Play's own storage, apart from your games and the rest of the
app, where it keeps its saves; it may use only pointer lock, full screen and clipboard writes, and
links that leave Genex games open in your browser (a coin purchase opens the app's own sheet
instead). A game in voice chat gets a microphone the app controls: your microphone feeds it only
while you turn on the mic in the game's bar (off for every game until you do), and a game never
gets a camera. What the game does with that audio is the game's: a Genex game in voice chat sends
it to the other players in its room, directly or through Genex's relay. Which games you left the
mic on for, and the microphone you chose, stay in the app profile. Signed in to Genex, the app
sends the account's token to the Genex API to get a single-use sign-in ticket for that game
(without one, the game plays as a guest), to read a game's likes including yours, to save or remove
a like, and to read your referral code, which Invite a friend adds to the link it copies. Share and
Invite only copy a genex.games link to the clipboard.

A game with a Mac app has its own page, read from the Genex API (with the account's token when
signed in, so it shows your like). The app is downloaded only when you press Install, over https
from genex.games' CDN (cdn.genex.technology) and without your token; its size, checksum and
signature are checked before it opens. Installed games and their saves live in the app profile.
Each game runs in a sandbox with no network that can write only its own saves, preferences and
a scratch folder removed when it ends, and removing a game keeps its saves. At start and every six hours the app reads each installed
game's page in the same way to tell you about a newer version. genex.games does not count plays
of a Mac app yet.

A game's comments are read from the Genex API without a sign-in, a page at a time while you scroll
them, with each writer's name and picture. Signed in, the app also sends the account's token to
post a comment you write (its text, at most 500 characters, becomes public on the game's page) or
delete one of yours, and reads who the account is to know which comments are yours.

When a game asks you to pay coin for something, the app catches the genex.games window the game
opens for it, which never shows or loads a page, and draws its own sheet over the game instead.
Signed in, it sends the account's token to the Genex API to read that purchase (the item, its price
and the game it is for) and your coin balance, and, only when you press Pay, to confirm that one
purchase. Cancel, Esc, closing the sheet or leaving the game cancels it, with the same token. The
app saves nothing about the purchase. Signed out, the sheet offers Sign in and reads nothing. Get
coin opens genex.games in your browser.

Signed in, the app also reads, with that token, who the account is (its name, nickname, whether
you chose it, picture, Pro and join date; the email the API returns never leaves the app's main
process) and the Friends page: your friends with the game each is in when they share it, requests
both ways, whether friends see the game you are in, and your invite link. Who the account is is read at launch, when
the window comes to the front, when the Mac is back online, when plugins change and, while a sign-in
waits in your browser, every 2 seconds; the Friends page at launch, every 2 minutes
for the sidebar's count of waiting requests, every 20 seconds while Friends is open and after each
change you make there. A profile reads that account's public profile (name, picture, Pro, join date,
published games) and, signed in, how you stand with them. Adding, accepting, declining, cancelling
and removing a friend, changing who sees your game, renaming your account and a new picture (made
into a 512-pixel WebP in the app, then uploaded to the address Genex hands back) are sent with the
token; people search sends what you type (2 to 40 characters). A nickname you type is sent, with
the token, a moment after your last key to ask whether it is free (unless the app can tell at once
that it is malformed or already yours), and once more when you save it. Post on X opens X's post
page in your browser with your link filled in, and Share… hands the link to the Mac's share menu:
neither sends anything until you post or choose an app there. A profile also reads that person's
friends (yours first) and how many people played their games. Your own stats (plays and players
per game per day, and who plays now) are read with the token only while your profile or the Stats
page shows them, and only you see them. Top creators are read without a sign-in. Choosing your
generated avatar or your photo, and Regenerate's new variant (a number), are sent with the token;
the generated avatar itself is drawn in the app from your account id and that number and sends
nothing. The Genex plugin's Credits tab reads, with the token,
your balance, Pro allowance, invite bonus and last few spends, and the public price list; Get
credits opens genex.games/plans in your browser. That an account has seen its avatar's welcome
(and been asked for its nickname) stays in the app profile, as do the account last signed in (its
id, name, nickname, picture addresses, Pro, join date and avatar choice) and its last balance, so
the app shows them while offline; signing out removes them. Signing in happens in your browser, on genex.games; signing out forgets the
account on this Mac; turning the Genex plugin off signs nothing out.

Remix clones the game's public source over https from git.genex.games into a new folder in your
games folder, without its history, hooks, content filters or symbolic links; files the game keeps
in Git LFS come from that same repository, through your Mac's git-lfs. The copy's
Claude settings and hooks are not trusted. Recent (the last 12 games played) and a dismissed Genex
card stay in the app profile. Development fixture launches answer from local data and open no
connection.

## Publication

Export uses declared public paths, excludes private directories and credential file types,
refuses symlinks and stops if a scanned file contains a credential Studio knows. This is not a
universal detector for every secret. Host-created game snapshots exclude `.env` and `.env.*`;
secrets already present in repository history still require independent cleanup.

After a turn on a game, and as Publish opens, Genex takes a cover picture and, for a game that
stages its own clip, records a five-second cover clip of it playing. Both stay in the app
profile; the clip is uploaded to Genex only with a publish.

When Publish lists a game's Mac or Windows app as ready, the same press also uploads that app (the
build in the game folder, zipped) to genex.games once the web version is live, where people
playing in the Genex desktop app can install it. A game with no web version is published as its
apps alone, and listed in the gallery under the name shown in Publish.

A plugin's staged upload requires a second review showing every included and excluded file.
Approve only after checking that list and the contents. An unlisted draft is still uploaded to
a remote service; listing it publicly is a separate confirmation. Hosted retention and account
deletion are governed by the service, not by deletion of the desktop profile.

## Analytics and shared build metrics

Studio itself sends no usage analytics, session recordings or crash reports.

**Share build metrics** (Settings → Privacy) is off by default and is a consent of its own.
When it is on, each finished build becomes one row of anonymous numbers sent to the Genex API
(`https://api.genex.games/api/desktop/contributions`): app version and platform; engine, model,
mode, launch and permission mode; how the build ended and whether it worked; the hour it
finished (never the minute); wall, first boot, first preview and median delegation times; how
many build steps it had; token counts by kind and role (the lead, builders, judges, subagents
and the helper models a coding tool calls on its own); the lead's context peak and compactions;
model and tool call counts; and the in-app judges' process signals (victory, run status, stop
code, liveness and check counts). Each row also carries a random install id, replaced every 90
days, and the version of this consent text.

A row never carries prompts, messages, code, file or project names, paths, screenshots or
account ids. It is sent without a sign-in or cookies and is never linked to a Genex account,
even when you are signed in. Every field is a code, a version, a number or that hour, checked
before the row is queued. **See what would be sent** shows the exact row. Rows wait in the
profile's `run-sharing` folder; one not sent within 7 days is dropped. Turning sharing off
forgets rows not yet sent.

**Delete what I shared** asks the server to remove every row this computer sent. Each row and
each delete is proven by a random secret made on this device, sent only to that server and kept
there only as a keyed hash, so nobody else can add to or delete this install's rows; later rows
use a new install id. The server keeps rows for
at most 180 days. When Genex pauses contributions, nothing is sent and Settings says sharing is
paused; Delete what I shared keeps working while it is. Developer, test and eval launches never
send. A self-built copy can point sharing at its own server with `STUDIO_RUNS_URL`, or remove it
by setting that variable empty.

The bundled Genex CLI's crash reporting defaults off. Coding providers have separate controls.

## Send feedback

**Send feedback** (the bug at the top of the sidebar) sends only when you press Send. It carries
what you wrote, the screen you were on (home, a game's chat, Harness or Plugins), the app version
and the operating system's version to the Genex API (`https://api.genex.games/api/desktop/feedback`),
where the Genex team reads it. It carries no account id or game files and is sent without a
sign-in. The server keeps no IP address or user agent with a report and deletes reports after
180 days.

Two switches add more, each on its own and off each time the dialog opens. **Attach app logs**
adds the Copy diagnostics text: versions, data paths, provider status and the newest 100 lines
of the app log, at most 128 KB (past that, the middle is cut). **Attach this chat**, shown while a chat is open, adds that chat's newest 200
events: your messages, the replies, tool calls and their results, each text cut to 2,000
characters, at most 256 KB in all. Keys, tokens, email addresses and your home folder are
removed by their shape before it leaves the Mac; like Publication's scan, this is not a
universal detector, so leave a chat that holds something private off.

Report suspected exposure privately using [SECURITY.md](SECURITY.md).
