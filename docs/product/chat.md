# Chat and questions

## What the user sees

One conversation per game. User messages are right-aligned bubbles, images above; long
ones fold with Show more. Replies are Markdown prose. Any existing file the chat
names is a link: game Markdown and images open beside it, others in their app (programs
only shown). Empty chat is blank. Only the prompt bar writes and sends; a pasted image
adds the picture, not its file name.

The chat's work shows a short status and elapsed time; waiting is static. A running build
is one card (time used of its hours, what happens now, Builds), not chat work, nothing under it. No duplicate Stop
controls or narration.

Neighboring tools group under a **Worked on N steps** (or **Worked in Unreal**)
disclosure; failures stay visible. Play views and assets sit under the work
that made them. Build updates use a short status and See it;
a finished build is that card with Play, opening Builds; checks stay in Builds and Studio.
A build that taught nothing adds no learned line. An Unreal turn saves and snapshots unsaved editor
work, saying so. A port snapshots first, keeps web files as reference, and the chat goes on in the
new kind (Unreal's once it answers).
The [design specification](../agent/design.md#chat-reading-and-activity) owns exact values.

## Questions and plans

Replies get current plugin, account, MCP and template facts each turn; asking about plugins
never resumes a build. A reply may start workers in the chat's mode (Plan holds writers); they
stop with the reply. Agents may look at app windows, never clicking, in any mode; background
work they start is one line with Stop, ending when Genex quits.

- An `ask_user` question opens the question panel: options and a typed-answer row; Send answer
  confirms a choice. Chat about this puts it aside for the composer; any reply settles it.
  Progress is never a question; an unsaid game, look or engine before a build is: a game with no
  kind asks which engine (its plugin on) until picked.
- Permission requests need an explicit answer and stay pinned above the composer. Worker plugin questions appear in the owning run’s conversation,
  cancelled with their worker. Plugins ask Approve or Decline; Claude asks **Allow**, the grant it offers
  (**Always allow …**) or **Deny**, or takes words instead; a plan leaving Plan is approved
  into a mode. Stop, the turn's end or a restart withdraws one.
- A game reply's one-line `bash` block offers **Run** and **Copy**; output shows below and
  reaches the agent unseen, reopening no build.
- **Plan mode** (Add's bulb) is a one-message choice: the plan is Markdown with **Approve**,
  **Make changes** and **Cancel**; only Approve starts it, and a revision needs fresh approval.
  Failed generation offers Choose model, Model providers, Try again, Dismiss.

## Sending, waiting and history

A sent message shows at once: idle, as the next bubble, **Sending** until saved.
While the chat works it joins that turn, **Sending…** until the agent reads it, then sits where
it was read. During a build its lead takes and answers it at once.
Otherwise (a picture, another model) it waits **Queued**, removable. During work a
sendable draft shows Send, else Stop; Stopping shows until it ends, and Stop works
again after five seconds. Stop hands over to
the oldest queued message; the stopped build then shows only its result, else Stopped once, with
Resume. A message cut off by a quit is retried once, then left to resend.

**Rewind** sits beside every sent bubble unless the chat answers; a running
build stops first. That message and all after it leave the
chat and model context (the log keeps them); a fresh session answers next; it
returns to the composer with its pictures and waiting follow-ups. **Restore game files** returns
the folder to before that message, off at first if files changed outside the
chat; otherwise one line says why only the conversation rewinds. Files too large to save stay,
named in the dialog and the chat. Outside Unreal projects' changes stay.

History is paged; reading older messages stops following live output.

## Where to work

[ChatPanel](../../src/renderer/panels/ChatPanel.tsx) feeds the transcript,
[chat components](../../src/renderer/chat) draw it and
[PromptBar](../../src/renderer/ui/PromptBar.tsx) owns writing.
Queue and session internals: [conversation coordinator](../conversation-coordinator.md); workers
and build results: [Builds and Live](builds-live.md).
