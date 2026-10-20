# Chat and questions

## What the user sees

One conversation per game. User messages are right-aligned bubbles, images above or alone; long
ones fold with Show more. Any existing file the chat names is a link: game Markdown and
images open beside it, others in their app (programs only shown). Only the prompt bar sends.
Dropped pictures stay pictures; other files become links. @ tags (max 5): local games read-only,
Genex ones in `.studio/refs/`, assets `src/assets/`.

Chat work shows its status and clock; waiting is static. A running build is one card that holds
still: parts counted, their checklist, Open in Builds. Run workers get no lines.

Neighboring tools group under **Worked on N steps** (or **Worked in Unreal**);
failures stay visible. Play views and assets sit under their work. Build updates use a short
status and See it; a finished build is that card with Play, opening Builds; checks stay in Builds
and Studio. A build that taught nothing adds no learned line. Exact values:
[design specification](../agent/design.md#chat-reading-and-activity).

## Questions and plans

Replies get current plugin, account, MCP and template facts; asking about plugins never
resumes a build. A reply may start workers in the chat's mode (Plan holds writers), stopping
with it; each is one line opening its work on Builds. Background work is one line with Stop until Genex
quits; agents may [look at apps](projects-engines.md#plugins-on-or-off) in any mode.

- An `ask_user` question opens the question panel: options and a typed-answer row; Send answer
  confirms a choice. Chat about this puts it aside for the composer; any reply settles it.
  Progress is never a question; an unsaid game, look or engine before a build is.
- Permission requests wait above the composer; a worker's plugin
  questions appear in its run, cancelled with it. Plugins ask Approve or Decline; Claude asks **Allow**, the grant it offers
  (**Always allow …**) or **Deny**, or takes words instead; a plan leaving Plan is approved
  into a mode. Stop, the turn's end or a restart withdraws one; answered ones collapse.
- Settings → Permissions lets cua-driver drive the Mac or PC
  ([computer use](../computer-use.md#the-persons-computer)).
- A game reply's one-line `bash` block offers **Run** and **Copy**; output shows below and
  reaches the agent unseen, reopening no build.
- **Plan mode** (Add's bulb) is a one-message choice: the plan is Markdown with **Approve**,
  **Make changes** and **Cancel**; only Approve starts it; a revision needs fresh approval.
  Failed generation offers Choose model, Model providers, Try again, Dismiss.

## Sending, waiting and history

A sent message shows at once: idle, as the next bubble, **Sending** until saved.
While the chat works it reaches that work at its next step (else waits below, removable): **Sending…** until
read, then sits there. A changed Mode, model or effort applies from there; workers carry over
or finish. A build's lead hears it, wrap-up included.
During work a sendable draft shows Send, else Stop; Stopping shows until done; a second press
within 5 s is ignored. The stopped build shows its result, else Stopped once, with Resume. A
message a quit cut off is retried once, then left to resend.

**Rewind** sits beside every sent bubble unless the chat answers; a running build stops first.
It and later messages leave chat and model context (the log keeps them); a fresh session
answers next; it returns to the composer with pictures and follow-ups. **Restore game
files** returns the folder to before it, off at first if files changed outside the chat (else a
line says why). Its line offers **Bring back newer version** until another message; the chat
stays rewound. Files too large to save stay, named in dialog and chat. Outside Unreal projects'
changes stay ([Unreal](projects-engines.md#unreal)).

History is paged; scrolling up stops following.

## Where to work

[ChatPanel](../../src/renderer/panels/ChatPanel.tsx) feeds the transcript,
[chat components](../../src/renderer/chat) draw it,
[PromptBar](../../src/renderer/ui/PromptBar.tsx) writes.
Queue and session internals: [conversation coordinator](../conversation-coordinator.md).
