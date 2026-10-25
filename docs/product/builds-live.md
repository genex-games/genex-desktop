# Builds and Live

## From a request to a game

Auto edits directly or starts a Loop when asked: workers (four by default) while the chat leads.
Parts grow boldly within the ask; an art director reviews the whole game, its blockers alone
sending a part back. Other projects' Loops run [in place](projects-engines.md#loops-in-place).
Loop hours are a soft cap (a reviewer's yes ends early, in place after the lead's named gaps; 15
minutes' grace). Acceptance survives workers and restarts; external blockers pause at a
checkpoint; ∞ ends on verified outcomes with no blocker. Asked to finish, the lead lets rounds
end, then lands; Finish overrides the clock, never the final judge
([details](../harness-runtime.md#goal-completion-and-worker-approvals)).

An active run opens Builds once; a chat-shown build, or empty Builds, opens Live. Chat's files and images get closable tabs.

## The two views

**Live** plays the browser game in a native view, paused unwatched. The strip holds
Live/Builds/Assets, Reload, Play/Stop, Sound (⌥⌘M), Full screen (hold Esc), plugin actions,
Multiplayer, Publish. An empty scaffold shows “Ready for your first idea” or “Building your game”;
the first healthy build shows itself. Otherwise only the user changes Live (opening a game, Reload,
Play, Make live, a chat request while hidden) or a finished Unity/Godot `web/` build. A newer
healthy build, a changed folder, a chat's show or a broken shown build lights Reload and a line
with Update (built first, timed); hidden, all but a new build go in at once; Rust `assets/`-only
changes swap in mid-play. Play opens Live at once, saying the asked build is on its way over the
earlier one; a Rust run's healthy build is prebuilt in the background, reused by content, and the
person's builds never wait for agents'. The preview reaches only public CDNs. Other folders:
[projects](projects-engines.md#lives-views).

**Compiled games** (C++ · raylib; Rust · wgpu, needing WebGPU, on Apple-silicon Macs or Linux
x64) build per destination, sandboxed; **Web | Native** shows the Mac build in Live (of what Live
shows: a played build's copy, else the folder; the card counts its build time; Full screen), a crash its card,
Rust a profile strip and `[net]` room; in either view `game.mouseLook` locks the pointer; only **On a device** installs a phone build
([more](../agent/feature-map.md)). Rust's `genex.toml` turns on nav, streaming and animation (off
in the starter).

**Builds** is a graph: You asked, a row per part, Your build, then the lead while no part
works. Tries at one step fold into one node (what reached the build forms the line; paused
tries show Paused). An eye opens reviewers' notes. A
new build is “Checking it starts…” until it runs. A working node shows its agent's screen and
action; a selected one opens as a card; **Follow up in chat** notes the next message to its build.
Tabs and chat cards open earlier builds. A Loop, workers,
jobs or a claim make a tree: the lead (jobs below), then the finish check (Checking, Not yet with
reasons, Done, Stopped). In place, save points form one line.

Agents test in hidden windows, never Live; blind judges play when screenshots can't decide;
chat frames never certify a build. A finished worker, passing checks, integration and Live's
revision are distinct facts, each reported.

## Continuation and interruption

A chat-led build's session takes follow-ups: edits, resuming a paused run with its time left,
starting over only when asked. With Loop on, small changes go direct; more work reopens the
build until checked; a chat that cannot (Ollama's) answers as with Loop off. **Stop** interrupts at once, keeping finished
work: a stopped Loop shows one Stopped line with Resume, and Builds or chat makes it live. Limit, outage and crash pauses resume twice unless stopped (Settings → Harness); sign-in
pauses wait. A crash or restart settles abandoned activity from saved state.

## Where to work

- Stage: [WorkspaceStage](../../src/renderer/shell/WorkspaceStage.tsx),
  [PreviewPanel](../../src/renderer/panels/PreviewPanel.tsx); steps: [run-steps](../../src/renderer/run-steps.ts),
  [RunGraph](../../src/renderer/panels/RunGraph.tsx), [RunInspector](../../src/renderer/panels/RunInspector.tsx).
- [Conversation coordinator](../conversation-coordinator.md): queue, continuation, Stop;
  [Architecture](../agent/architecture.md), [Verification](../agent/verification.md): run, preview,
  recovery.
