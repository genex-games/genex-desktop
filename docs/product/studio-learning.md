# Studio and learning

## The Studio workspace

Studio pairs a separate assistant conversation with Activity. Its assistant explains Studio
state using a bounded view of settings, games, recent activity and proposals. It is tool-free: chatting here does not
commission a game or grant authority to mutate the harness. It points to waiting suggestions,
never its own. **How it works**, beside its title, explains the loop.

Its composer offers text, images, model, effort and Send/Stop; no game roles, Loop
or tools. Its first message points games to their own chats; example questions follow. Its own records
appear in Activity, not here.

## Activity and review

Activity orders pending suggestions, **Recent runs**, then **What Harness has learned**.
Restores, restarts and app updates are omitted. The host restores a failed harness update;
failed recovery offers **Reset harness to shipped version** or Quit. Run rows show the game,
request and outcome; expanding shows captures, Play build and Open game chat. Checks stay in
Builds. Empty Activity offers **Start building** or **New game**.
Timed runs start from the game composer's Mode menu; settings live in **Settings → Harness**.

## Learning and instructions

Learning starts on; **Apply suggestions automatically** starts off on fresh installs. The switch
in Activity's header turns all learning on or off. Harness's edits to itself are listed there,
each undoable.
Off, Harness learns nothing new: no review after a run, suggestions, game lessons, recipe
statistics or automatic apply. What it learned stays in use and can be undone; waiting
suggestions can still be applied or discarded. Runs are still recorded.

Harness learns from run evidence and proposes reusable instruction changes; proposed, applied,
checked and game-quality results are distinct. Builders' lessons arrive as one suggestion. A
learning count does not certify a better game. A game chat shows one
plain line about what Harness learned from that build, with **Review in Harness**.

Each proposal carries a plain title and summary for someone who never reads
instruction files; older ones name what they change. Checked suggestions
are applied or discarded together; the file, the proposer's notes and
the diff (wrapped, with context) stay behind **See the exact edit**, or show directly when the row
has nothing else. Missing plain words are asked for once more. Applied changes say who let them land and keep
their diff and **Undo this change**, which takes back that change alone; later changes and what
Harness learned about each game stay. A suggestion written against instructions that have since
changed is applied on top of them when it still fits, and refused when it does not. **Look for
improvements** appears once runs exist and shows its result on the button
(Found, Added or Nothing new). **Settings → Harness** owns automatic application, **Maximum concurrent workers**
(default four, up to twelve) and **How suggestions are tested**.
Changes land through validated, recoverable host APIs, never by executing a chat reply. The
agent's own edits carry a plain title and summary too.
Code changes are type-checked and started in a copy first; a failing one is refused.

App updates keep the installed harness's edits and report their changes.

## Where to work

[ReviewPanel](../../src/renderer/panels/ReviewPanel.tsx) owns Activity;
[ChatPanel](../../src/renderer/panels/ChatPanel.tsx) handles the separate Studio conversation.
[Harness runtime](../harness-runtime.md) describes the installed runtime and learning boundaries.
Search [Architecture](../agent/architecture.md) for Studio, proposals or host persistence.
[Design](../agent/design.md#studio-hierarchy-and-progressive-disclosure) owns the shared visual hierarchy.
