# Studio and learning

## The Studio workspace

Studio pairs a separate assistant conversation with Activity. The tool-free assistant explains
Studio from a bounded view of settings, games, recent activity and proposals; chatting commissions
no game and grants no authority over the harness. It points to waiting suggestions,
never its own. **How it works**, beside its title, explains the loop.

Its composer offers text, images, model, effort and Send/Stop; no game roles, Loop
or tools. Its first message points games to their own chats, then example questions; its records
appear in Activity.

## Activity and review

Activity orders pending suggestions, **Recent runs**, then **What Harness has learned**.
Restores, restarts and app updates are omitted. The host restores a failed harness update;
failed recovery offers **Reset harness to shipped version** or Quit. Run rows show the game,
request and outcome; expanding shows captures, Play build and Open game chat. Checks stay in
Builds. Empty Activity offers **Start building** or **New game**; runs start from a game's Mode menu.

## Learning and instructions

Learning starts on; **Apply suggestions automatically** starts off on fresh installs. The switch
in Activity's header turns all learning on or off; Harness's own edits are listed there, each
undoable.
Off, Harness learns nothing new: no review after a run, suggestions, game lessons, recipe
statistics or automatic apply. What it learned stays in use, undoable; waiting
suggestions can still be applied or discarded; runs are still recorded.

Harness learns from run evidence and proposes reusable instruction changes; proposed, applied,
checked and game-quality results are distinct. Builders' lessons arrive as one suggestion; a
learning count certifies no better game. A game chat shows one
plain line about what Harness learned from that build, with **Review in Harness**.

Each proposal carries a plain title and summary for people who never read instruction files;
older ones name what they change. Checked suggestions
are applied or discarded together; the file, the proposer's notes and
the diff (wrapped, with context) stay behind **See the exact edit**, or show directly when the row
has nothing else. Missing plain words are asked for once more. Applied changes name who let them land and keep
their diff and **Undo this change**, reverting that change alone; later changes and per-game
lessons stay. A suggestion written against since-changed instructions is
applied on top when it still fits, else refused. **Look for
improvements** appears once runs exist, reviews recent builds and shows the result on the button
(Found, Added or Nothing new). **Settings → Harness** owns automatic application, **Maximum concurrent workers**
(default four, up to twelve) and **How suggestions are tested**.
Changes land through validated, recoverable host APIs, never by executing a chat reply. The
agent's own edits carry a plain title and summary too.
Code changes are type-checked and started in a copy first; a failing one is refused.

App updates keep the installed harness's edits and report their changes.

## Where to work

[ReviewPanel](../../src/renderer/panels/ReviewPanel.tsx) owns Activity;
[ChatPanel](../../src/renderer/panels/ChatPanel.tsx) the Studio conversation.
[Harness runtime](../harness-runtime.md): runtime and learning boundaries.
[Architecture](../agent/architecture.md): Studio, proposals and host persistence.
[Design](../agent/design.md#studio-hierarchy-and-progressive-disclosure): shared visual hierarchy.
