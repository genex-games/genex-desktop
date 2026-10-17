# Open harness: overview and Builds view design

Design references for the open harness: one agent (the lead) that works on any project, plugins that
add reach without acting as gates, workers in the chat's permission mode, and a finish check at the end
of a Loop.

- `harness-map.html`: one self-contained page (open it in a browser). The whole system, projects and
  facts, workers and permission modes, hooks, locks and jobs, the Builds graph, the Loop and its finish
  check.
- `builds-graph/`: the Builds view, today and with the open harness. Each board is a PNG plus its HTML
  source (the HTML loads Genex's fonts from `src/renderer/fonts/`).
  - `today.png`: today's Builds view, captured from the `build-graph` dev fixture.
  - `loop-workers.png`: a Loop with three workers and a background job; the finish check waits at the end.
  - `chat-turn.png`: a chat turn that started two workers; chat turns get no finish check.
  - `finish-check.png`: the finish check's four states (reviewing, not yet, done, stopped after three no's).

Copy rules the boards follow: a worker shows its task and a plain status ("Working", "Working in
Unreal", "Done", "Added to your game", "Waiting for a worker"); no internal words (reader, writer,
copy, lock, merge, sandbox) reach the UI. The graph stays a node/edge graph.
