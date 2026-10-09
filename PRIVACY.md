# Desktop data and privacy

Updated October 7, 2026. Contact: **team@genex.games**. This describes the desktop
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
which sends nothing beyond the request itself; the download is yours to start. Development
builds and builds you package yourself under another name do not check.

The catalog downloads listings and pinned plugin packages anonymously from its configured
hosts and GitHub. Asset generation and publishing contact Genex using the connected account.
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

Studio finds Claude Code and Codex through a manual override, your login-shell `PATH`, then
standard locations, and never installs or updates them unless you choose that in Settings.
Subscription limits apply; there is no fallback to API-key billing, and an ambient
`ANTHROPIC_API_KEY` is not used. Provider tokens never reach the renderer or the event log. The
bundled Genex CLI runs with its crash reporting off unless you set `GENEX_TELEMETRY`;
`DO_NOT_TRACK` and `GENEX_DISABLE_SENTRY` are passed on to it.

Opening a folder does not authorize its Claude settings or hooks. The Open Game trust checkbox
is an explicit choice because hooks can run commands with the user's access. Interactive
permission modes and native plugins have broader reach than unattended sandboxed workers.

## Publication

Export uses declared public paths, excludes private directories and credential file types,
refuses symlinks and stops if a scanned file contains a credential Studio knows. This is not a
universal detector for every secret. Host-created game snapshots exclude `.env` and `.env.*`;
secrets already present in repository history still require independent cleanup.

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
