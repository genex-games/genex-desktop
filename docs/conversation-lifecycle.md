# Conversation and build lifecycle

A game chat message is input to the game's conversation: the chat's own session answers it, leads
a build it launches, and goes on after the build with the run's controls. It is not a request to
create a run. Every message is the chat's own turn, or its build's lead's while that build runs:
there is no second agent beside them. Studio's app-wide chat uses tool-free model completion with
conversation and recorded Studio activity. Historical game runs in an older Studio thread must not
bind a new Studio question to that game's run.

The failure this addresses: once a chat had started Autopilot — the Loop, while the harness keeps
the word (`start_autopilot`, `autopilot_<runId>`) — every follow-up re-entered the intake interview
with `start_autopilot` available. The existing run and a new run could then share a thread, cancellation flag, live
project, and graph: a request to wait for the remaining workers could start a second run.

## Ownership

- The harness owns run identity, the plan, worktrees, scheduling and cancellation.
  It reserves one run per thread/project synchronously, before planning or any model request.
- The chat owns conversation: the harness's queue (`loop/message-queue.ts`) and the chat's own
  session. Messages are persisted before acknowledgement and queued in order per chat. A
  follow-up sent while the chat's own response works joins that response, as words or — when it
  changes the response's settings — as a switch ([steer](#steering-the-chats-turn)); one sent
  while a run's lead works goes to that lead ([live chat](#live-chat-during-a-build)); any other,
  or one that cannot join, waits for the current response and for the build to close — the run
  itself, never the learning pass after it; other chats remain independent. The transcript
  shows follow-ups in muted bubbles below the current work, reading Sending… until they are read,
  whether handed over or waiting: there is no Queued label, and only one still waiting (not
  handed over) offers Send now in that label's place (the composer's Stop, offered while there is
  work to stop: the queue then answers what waits, oldest first), Edit (removed from the queue first, then its words and
  the pictures the composer attached go back before the draft, as a rewound message's do;
  `renderer/chat/put-back.ts`) and Remove. The harness keeps in-place edit/hold for older clients.
  Receipt, processing, completion, edit and removal have separate append-only events. Editing
  holds dispatch until saved or cancelled; that hold survives restart. Unanswered messages replay
  on boot, including updated text and attachments. A message cut off mid-answer is retried once
  (the count rides on `coordinator_message_requeued` and `coordinator_message_processing`); after a
  second interruption it is settled as `coordinator_message_handled` with `interrupted: true` and
  not replayed. The boot notice says which: Studio will retry it, or it asks to send it again.
  Removed and later input stays out of earlier
  prompts. The provider only sees the current version of each message.
  A commission is handled when its build launches; the run holds later messages independently.
  Restart must not replay the original commission merely because its build was interrupted.
- The chat's bookmark is its own session: worker sessions never overwrite it. A
  delegation that names a run, director or build worktree `cwd` never writes metadata
  `contractor`, and the harness view always drops the session ids run sessions mirror into the
  chat (`payload.runId`), so a follow-up never resumes a director or builder that carries
  such a marker. Two run delegations carry none and are still recorded as the chat's session: the
  classic integrator without an integration worktree and a base build with no project folder. One
  run delegation is the chat's on purpose: a waking run's lead whose director grant says
  `chatSession` sits in the game folder and continues the chat's own session, so the host keeps its
  session as `contractor` and the harness writes its `contractor_session`
  ([one session](#live-chat-during-a-build)).
- After a run its lead led, the chat goes on in that same session with its hands back
  ([after the build](#after-the-build-the-same-session)): it answers, after a finished run does
  requested work itself or starts a new Loop for more, goes on with a paused one for any work on the
  game beyond a quick fix (a question or a quick fix it handles itself, and the build stays
  paused), and shows or
  lands the build. Questions alone do not restart builders. Sending a message needs no Keep going
  button.
  Optional **Resume** also keeps the journal; a run interrupted by a quit or a crash is repaired
  at boot as paused, keyed on its journal artifact rather than on `mode`, so a director run is
  resumable too. A resumed
  director run goes on from its journal with no clock, as every Loop
  ([what ends a Loop](harness-runtime.md#what-ends-a-loop)): its lead's first message is Genex's
  line that it resumed, with the run's lines it was not told before the pause
  ([what wakes a Loop's lead](harness-runtime.md#what-wakes-a-loops-lead)); `run_status` names the
  rest ([the full journal](agent/architecture.md#the-run-director-workers-and-judging)). Starting a
  second run while one owns the project is rejected independently of any model prompt or UI
  state. A run that has begun writing its own end (`ActiveRun.closing`, set just before its
  `run_finished` or `autopilot_paused` is appended) no longer owns it: a Resume pressed as the
  pause shows waits for that close, then starts.
  A paused build an earlier version left with the classic pipeline's journal, resumed on an engine
  whose runs the director now leads, is closed as it stood instead (`run-dispatch.ts`
  `closingOlderBuild`): the director would start it again from its goal on a fresh clock. Its work
  is kept and the chat says why.

## Controls and delivery

The run's controls are host-owned tools (`shared/chat-run.ts` `RunControl`: `run_status`), which
the chat's own session keeps after a closed Loop run, answered
by `main/core/conversation.ts` `runControl` (the harness's `run.control`), which also does the
`resume_run` that session recorded. The host records each call it answers, so the chat shows the
session's own mirror of one as no second row, and a resume the session only recorded shows once,
when the chat does it (`renderer/chat-entries.ts` `recordedByHost`, `isHostRunTool`). `run_status`
reads the run's durable progress (a steer's `run_steering_delivered` is not progress and stays off
its list). A steer (`run_steering`) is the
record of words for a run: the chat's words its lead took ([live chat](#live-chat-during-a-build)),
a note about a build (main's `runFeedback`), or a Resume's. The lead reads the chat's words from its
line and a note as it comes; each one it heard is recorded `run_steering_delivered` how `lead`.
A Resume's words are the chat's own session's, which is the lead, so no lead is told them again.
Wrap-up is read from the log (`loop/run-inbox.ts`): a `finish` counts only after the run's latest
`run_registered` (`finishRequested`, the app's copy in `shared/chat-run.ts`). A resumed run never
inherits an earlier wrap-up, and Wrap up after Resume is recorded again.
Steering that reaches a classic build after its last round stays with that build: kept on its report
and handed over only if it goes on, never written into the game's NOTES.md, which every later chat
reads. The chat removes the "Steering backlog" section older builds left there before it answers
(`loop/steering-backlog.ts`), and prompts built from NOTES.md leave it out.
A resumed run's lead is handed again the chat's messages it took and never heard before the pause
(the app quit under it), never one it heard or gave back ([live chat](#live-chat-during-a-build)).

Wrap up (Builds, `studio:run.finish`, `conversation.ts` `requestRunFinish`; the lead's own
`wrap_up` while it builds) is distinct from Stop: it lets in-flight facet attempts finish, prevents
new facet rounds, then merges, performs an integration attempt and validation, and displays
accepted work. It does not promise the result passes all checks. Stop is explicit cancellation, the
composer's and Builds' alone; Resume (`autopilot.resume`) goes on with a paused build.
After a pause, `resume_run` goes on with that build for any work on the game beyond a quick fix; a
question or a quick fix the chat's own session handles itself, and the build stays paused.
`resume_run` can only resume a paused journal and cannot create a replacement run; a finished
run is never started again: more work is a new Loop ([after the build](#after-the-build-the-same-session)).

In a director run (a session-capable engine's Autopilot, including managed Bonsai) the workers are the
director's: the person's words reach the lead as they wrote them, at once if it rests and at its
next step if it works ([what wakes a Loop's lead](harness-runtime.md#what-wakes-a-loops-lead)), and
the lead forwards what applies with `worker_steer`. Wrap up
tells the director the user asked to finish; the director integrates what is ready and calls
`finish` itself, and the close still judges the build before it makes it live
([harness runtime](harness-runtime.md#goal-completion-and-worker-approvals)). Stop aborts the director's session and its workers' (`engine.abort {project}`) —
the composer's Stop interrupts immediately through `studio:cancel`.
It holds dispatch while aborting the old work, then releases the queue: the oldest queued message
runs once the interrupted response/build has saved and settled. An empty queue stays stopped.
A Stop sticks to the work it was pressed for. Main waits for a send still on its way
(`rewind.sendsLanded`), and with no build under way the harness marks the message being answered
or at the front (`MessageQueue.current`, `studio.stoppedMessages`), so its turn keeps the Stop and
ends at once ("Stopped before it started"). A build a chat turn launched keeps a Stop pressed since
(`handleRunStart` `keepStop`) and says it never started; a director run stopped while it prepared
opens no session; a chat turn stopped while it prepared starts no builder. The composer ignores a
press less than `STOP_RETRY_MS` after the chat's last acted-on Stop, even once the stopped work has
ended and what waited took over (`renderer/chat/chat-stop.ts`), so a double press never stops the
follow-up; a later press stops it as any Stop would.
There is no global sidebar Stop control or confirmation sheet. Escape remains scoped to the
composer and a chat-only turn. Wrapping up goes through `studio:run.finish`, which refuses a run
that is no longer running. A worker the director stops
mid-round keeps its work: the round is committed to its own ref,
`refs/studio/runs/<runId>/attempts/<facet>/<n>-stopped` (a ref, never a branch — the game's
`git branch` and `git tag` lists stay the user's), its worktree is left standing, and it is
neither judged nor rolled back; the reason names the director, never the user.

Every Loop works in the game folder, so a run leaves no build of its own to show or land: what it
made is the game, which Live's Reload offers. The work of a web game's Loop an earlier Genex paused
stays on its git ref (its refusal names it), which the chat's session merges with its own hands
when the person asks.

The run and chat have separate status lanes. Chat completion cannot clear a worker's status.
Send and Stop share one composer slot: a sendable draft shows Send, otherwise active work shows
Stop. **Plan mode** (Add) is an explicit one-message choice
and resets after submission and when work starts. In the permissions pill's Plan, a build the chat's
session records waits for the plan's approval, and `resume_run` does not run
([permissions](tool-permissions.md)).
Active/paused work bypasses stale review flags. Planning and revision preserve the original request, recent conversation, previous proposed or
approved plan, and saved run state. Explicit approval is still required before executing a newly
requested plan; sending a revision never approves it.

## Steering the chat's turn

A message sent while the chat's own turn works — the chat's own session (after a run, too) — is
delivered into that turn instead of waiting for it to end. The queue decides what
joins, the host how the session takes it, and the log records where it was read. Build steering
(`worker_steer`, the director's inbox) is
unchanged: while a run of this chat or its game is starting or running nothing is steered into a
chat turn; messages go to the run's lead ([live chat](#live-chat-during-a-build)) or wait.

- **What joins.** The runner of the processed message gets a steer handle (`loop/message-queue.ts`
  `SteerHandle`). When its turn will be answered by a session (`steer.expect`, from
  `chat-dispatch.ts` before the turn is set up, by the message's engine or, when it names none, its
  run's), a message sent meanwhile joins it unless something sent before the turn began still
  waits, a build runs, or it is a fresh build asked for or Studio's chat (`steer-switch.ts`
  `joinKindOf`). It joins as **words** when it settles what the turn runs on the same way (engine,
  model, effort and roles); otherwise as a **switch**, which only a runner that says so takes (`steer.open({
  switches, takes })`: the chat's own delegated turn when the dispatch names the message it follows,
  `asked`; never a run's builder). Slash text never joins: it waits for a turn of its own, as a
  command typed while Claude Code works runs once its turn ends. A switch to an engine
  that turn cannot go on with (one without sessions, or another engine than the lead's after its
  run, `turn-switch.ts` `endsTurnFor`) waits for a turn of its own; one that cannot join holds back
  nothing sent after it. Its receipt then carries `coordinator_message_steering {messageId, into}`,
  so it shows as Sending…. What joins before the session starts goes into its first prompt
  (`steer.open`; `coordinator_message_delivered`, `how: "prompt"`); what joins while it runs is
  handed to it. Studio's chat and local models without sessions take nothing mid-turn; a runner that
  never starts a session returns what joined to the queue.
- **Read mid-turn.** `engine.steer {threadId, into, messages}` (`main/core/chat-steer.ts`) finds the
  delegation whose `chatTurn` is `into`, waiting up to `FIND_SESSION_MS` for it to register — never
  a build worktree or the director. An engine with `steersMidTurn` takes
  words: Claude Code keeps the SDK input open (an async-iterable prompt,
  `substrate/engines/claude-steer.ts`) and pushes the message with `priority: "next"` and a uuid,
  as its sender's frame (`MessageFrom`, `shared/engine-requests.ts`): the person's words and
  pictures exactly as sent, with `origin: {kind: "human"}`, which CLI 2.1.257 shows the model as
  "The user sent a new message while you were working"; Genex's own line (a worker ended, a
  command's result) with `isSynthetic: true` and no origin, which it sends the model as a system
  message under "[MESSAGE FROM NON-USER
  SOURCE - NOT USER INPUT]", never as the user's (`claude-steer-cli.test.ts`, opt-in, runs the real
  CLI); both report `started`. The LocalSessions engines (Bonsai, OpenRouter, a local
  server) read it at the top of their next round (`substrate/engines/local-session-steer.ts`), and
  every engine with no sender field (Codex, Cursor, Grok Build, OpenCode, the local sessions) puts
  Genex's text under that same header (`genex-mark-prompts.ts`), in its steer and in a prompt whose
  `from` is Genex's. Ollama
  is the exception: its turn runs in the harness's own tool loop (`tool-loop.ts`), which takes no
  messages, so one sent meanwhile waits below it (removable) for a turn of its own. The
  CLI folds it in at the next tool result, or runs it as a follow-up turn of the same session when
  it arrives during the final answer. Its `command_lifecycle` `started` frame is the moment it was
  read: the engine emits `steer_delivered`, and the host appends `coordinator_message_delivered
  {how: "native"}` in stream order among the turn's mirrored rows, which is where the chat shows the
  bubble (`delivery-order.ts`). This needs a CLI that advertises `msg_lifecycle_v1` in its init
  capabilities (2.1.281 does); the input stays open until a result has answered everything read, so
  a late message is never cut off, and one taken but never started closes it after
  `STEER_STALL_MS`, reported as not delivered. The brief carries a uuid too: a resumed session may
  first answer what it had queued (a background task's notice), and that result does not close the
  input before the brief's own turn, whose Genex tool calls answer over it. A tool that only waits ends early when one of the
  person's messages is handed over (`loop/person-wrote.ts`: a worker wait, a lead's wait for a busy
  reviewer, a plugin lock wait on the host), so the session reaches its next step in seconds and may
  wait again; a line of Genex's ends no wait. A message the chat wrote itself (any `origin`) or a
  plugin's ask it shows (`desktop-assist.ts`) is queued `from: genex`, and every message keeps its
  sender on the way in: the turn it opens, its steer and its `run_steering` say Genex wrote it.
- **Cut at the next step and resume.** Any other session — Codex (`codex exec` closes stdin at
  spawn), OpenCode, an older Claude Code, and every session handed `ask_user` (a message folded in
  at its question's tool result would be answered by a turn that had already decided; the Loop's
  start alone does not count, `studio-tool-prompts.ts` `isInterview`) — and
  any switch (`native: false`) is cut (`steered`, never read as a Stop), but only between tool
  calls: the host defers the abort until no tool the session started is in flight
  (`main/core/steer-cut.ts`), so no tool's result is lost. `loop/chat-steer.ts` `steeredCall`
  appends `coordinator_message_delivered {how: "interrupt"}` and resumes the same session with the
  person's words alone, as they wrote them (several apart by a blank line, their pictures as
  images, `from: person`); a session cut before it read its prompt gets that prompt again with the
  words after it. A prompt says who wrote all of it (`oneSender`): words of another sender than the
  leg's — Genex's line among the person's, the person's after a Genex turn's own message — wait for
  the leg after it, in the order sent. A switch first moves the turn onto the message's settings (`TurnSwitches.
  apply`, `turn-switch.ts` `switchedSettings`: a turn started with that message would have run on
  them, the after-run session's engine kept), which the next leg runs on as its options, never as
  words: another model or effort resumes the same session with the words alone; another engine
  starts a new one with the turn's words, everything the turn was told and the chat so far as one
  Genex notice. A launch or question the cut leg recorded is kept, on the new settings. Messages
  reach it in the order they were sent.
- **Not read.** Whatever a session took but did not read — a Stop (checked again before every
  resumed leg), a turn that ended first, a turn that had already asked its question or
  launched, a leg that failed or was stopped before it read its prompt (with anything an earlier
  cut-off leg forwarded to it) — is `coordinator_message_requeued` in the
  order it was sent, before the turn's `handled`, and gets a turn of its own, so a Stop still leaves
  every unread message an answer.
- **A turn that starts a Loop.** A turn whose session launches a Loop hands its workers on
  (`workers/carry.ts`): a Loop in the game folder takes the turn's pool over (its run's pool is the
  same pool re-scoped to the run, `run-pool.ts` `runPool`), so they keep going as the run's; for a
  Loop on a copy the launch waits for a writer in the game folder to end (`landWorkers`); any other
  still at work stops, a copy's work kept on its ref.
  A pool whose run was refused at its start, or whose launch failed, closes (`closeCarriedPool`). The launch takes the
  settings of the message the turn followed last (`details.followed`, `chat-dispatch.ts`
  `followedSettings`).
- **Delivered is final.** The turn it joined answers it: it never gets a processing event or a
  checkpoint of its own. Rewinding to it withdraws it from its bubble on (the files stay; the turn
  it joined keeps its end and `handled`), and rewinding the message it joined withdraws it too.
- **Restart.** `restore` requeues `steering` like `processing`, and `events.inbox` keeps both, and
  a message delivered into a turn still owed its answer. That message rides in the turn's replay
  (`steer.carried`, in its first prompt) instead of being asked again; one delivered into a
  finished turn, or into one a second restart cut off (never retried: `MESSAGE_ATTEMPTS`), stays
  settled with it. One that switched that turn (the Loop, another model) and all it read after it
  get turns of their own after the replay instead, which runs on the turn's own settings; a slash
  command it read stays read, never run twice. A turn that began before the replay reached its chat
  takes none of the replayed messages, and removing a replayed turn gives what it had read a turn of
  its own.

`steeredCall` knows only "the session that is the chat's current turn"; the run's lead answers
the chat through its own wake loop instead (below). What steer added to the seed never comes from a
module that shipped before it (`SteerDelivery` is `loop/steer-delivery.ts`, the build check is in
`live-chat.ts`; switches are `steer-switch.ts`, `turn-switch.ts`, `person-wrote.ts` and
`workers/carry.ts`).

## Live chat during a build

While a director run is going on the wake loop, its lead is the chat: a message sent meanwhile is
handed to it at once, and it answers in the chat. The line opens once `runDirector` has seated the
lead; a message sent while the run prepares its start waits for it (`live-chat.ts` `chatWaitsFor`)
and is then handed to the lead like any other. Stop (composer or Builds) stops a starting build. A waking
run's start says its lead takes the chat (`autopilot_started.liveChat`), and while it runs the
composer reads "Talk to the lead while it builds…" instead of "Sends when the build finishes…"
(renderer `chat/live-chat.ts`). What the lead does about a message shows as it does it: a worker
it redirects (`worker_steer`) is a line of its own, "Told “<the worker's task>”: <the first sentence
it was told>" (`[data-told-line]`), never a row folded among the turn's tool calls.

- **One session.** The lead is the chat's own contractor session, not a second one
  (`loop/director/lead-session.ts`, words in `lead-session-prompts.ts`). `runDirector` seats it
  (`leadSeat`, on a Resume too) on the chat's bookmark — its latest `contractor_session` — when its
  engine and game are the lead's (`continuesChat`); a lead model of its own on that engine is the
  session's model option. There is one session per chat: with no bookmark, or one on another
  engine, the lead opens a session that becomes the chat's. A fresh lead session — none to resume, one lost, a later turn with none — is asked
  its turn's own message, with Genex's notices beside it: the chat's latest 20 messages (`freshChat`),
  and for a lost one that it was lost and how the Loop began; reference stills reach a fresh session
  and the lead's first turn.
  The delegation names no `cwd` (the game folder), and its director grant's `root` is the game
  folder itself, with `chatSession` when it is the chat's; on a game Genex sees (`seenInWindow`) it
  carries the chat's own capture grant, so the lead has the window its chat's turns have. The host
  honours that grant (`#inPlaceRoot`) only for a writing lead whose root is this game's folder by
  name and real path, in this game's own open chat, for a run the host's records say is this game's,
  started in the chat the delegation and its grant name and going now; a grant it can't place leaves
  the session unattended. Its lock is the game folder: the chat's own
  turns wait for the lead's turn there, and a lead's turn refused because another session holds it
  (`DelegationRefusal.FolderBusy`, the error's `code`) is asked again after each wait until it is
  free; a Stop during the wait ends it as a failed turn rather than the run's crash (`wake.ts`
  `waitsForFolder`). The host keeps a `chatSession` lead's session as the chat's `contractor` after
  each turn; the harness writes its `contractor_session` when it changed (`bookmarkLead`).
  The lead builds with its own hands in the game folder, never read-only; workers take the parts
  that run side by side, a copy worker's work merged into the folder with `worker_mark used`. The
  journal carries the run, and `run_status` answers where it stands. A worker's work that conflicts
  with the folder comes back to the lead, the merge undone and the files named.
  After the close the chat goes on in it with its hands back
  ([after the build](#after-the-build-the-same-session)), and a Resume leads in it again.

- **The line.** `runDirector` opens `openLeadLine` (`loop/director/lead-line.ts`) once the run
  exists, so a message sent while it prepares reaches the lead's first message; it stays open
  through the wrap-up, and the run releases it at its close (a Stop's too). The wrap-up turn hears
  each message like any other turn and answers it: the lead is the chat's own session, so nothing it
  heard is answered a second time after the close. What no turn read goes back to the chat when the
  line is released, and the chat answers it then.
- **The hand-over.** The queue asks `leadDoor` (`loop/live-chat.ts`) for each message. The lead
  takes words or pictures from the run's own chat — no slash text or Studio chat — while its line
  is open and nothing older waits: the `run_steering` names the message's attachments artifact
  (`attachmentsArtifactOf`), from which the lead's loop reads its pictures as image blocks. Its
  receipt then carries `coordinator_message_delivered {into: <runId>, how: "lead"}` and a
  `run_steering {runId, text, sourceMessageId, attachmentsArtifact?, from?}`, the record a Resume
  reads it back from: the words as typed, never waiting, never
  processed, no turn or checkpoint of its own, and its bubble sits where it was delivered. A message that waited (sent while the run prepared) is handed the same
  way once `beforeProcess` (`chatWaitsFor`) answers with the lead's door. What the lead does not
  take waits for the close and is answered then, but holds nothing back: words sent after it
  still reach the lead, in order among themselves (`chatWaitsFor` answers null when a line opens
  or shuts, and the queue hands past it). The lead may so answer a later message before the chat
  answers the one that waited; each bubble sits where it was delivered.
- **Hearing it.** The lead reads the chat's words from its line (`LeadLine.unheard`), and only
  there ([what wakes a Loop's lead](harness-runtime.md#what-wakes-a-loops-lead)). A resting lead is
  woken at once, with their words alone as its message (`from: person`, the leading unheard messages
  of one sender joined as written, pictures as image blocks; Genex's untold lines beside them as a
  notice). A turn under way is handed them by its one watch (`director/news.ts` `watchTurn`), which
  calls `engine.steer {threadId, into: <runId>}` — the director's delegation carries `chatTurn:
  {messageId: <runId>}` on a waking run, which the host honours only for that run's director grant.
  Each message is a steer of its own, as written, with its pictures and its sender (Genex's `from:
  genex`); Claude Code reads them at its next step. Any other engine, on a turn with a session to
  resume — the first too, so a Codex lead is never deaf for a whole turn — not the wrap-up and not
  inside a director tool call (`toolsInFlight`, whose answer a cut would lose), is interrupted and
  resumed in the same session with those words alone (and, when it was cut before it read its own
  message, Genex's lines of that message beside them, never crashing the run); otherwise
  `interrupt: false` leaves the turn alone, as for a fresh lead's first turn, which has no session to
  resume yet. Words a turn did not read, or that a turn failed before working on, stay unheard on the
  line and open its next message. A cut is never a failed turn. A message is heard once a turn works
  on (or answers) the message that carried it, or reads it mid-turn (`LeadLine.heardThrough`), and is
  recorded heard (`run_steering_delivered {sourceMessageId, how: "lead"}`). That an ask to stop or
  finish is `wrap_up`, quoting their words, is said once: in `wrap_up`'s own description
  (`director/tool-specs.ts` `WRAP_UP_SPEC`).
- **Answering.** What the lead writes is planner text, mirrored as chat bubbles and streamed like
  any reply; the prompts ask it to answer the user directly and briefly, to write otherwise only
  when a part lands, the build can be looked at, something broke, the plan changed or the build is
  done, and say a question never stops or restarts a worker. After the close the same session goes
  on, those words in its history.
- **Close and Stop.** The chat waits for a run's close (`ActiveRun.closed`, `done`, set when its
  runner returns), not for the learning pass that follows: the chat answers during that pass, and
  a new build waits the pass out. A resumed run's
  report carries its earlier sessions' workers, rounds, verdicts and notes (`setup.ts`
  `loopRunReport`, from the last `run_finished`), its `judge_N`/`play_N` folders number on from the
  journal, and a session that kept no new round skips the pass (`run-dispatch.ts` `keptNewRounds`).
  Stop pauses the queue — a cancelled run takes no more messages — and hands over to the oldest
  queued message
  once the run has closed. What of the chat's the lead never heard when its run ended (a Stop, a
  limit, a crash — one while the run prepared too — or the close) goes back to the queue
  (`coordinator_message_requeued`, `LeadLine.release`) before `run_finished`, so Stop hands over to
  it too and it waits again; one handed as the line was released goes back at once. A lead's
  delivered message settles in the chat's state when its run closes. The chat answers what went
  back, and its own `resume_run` records the words anew, so a later run of the run never tells
  a message its lead heard or gave back. An app quit gives nothing back: a message the lead never
  heard stays with its run, the chat does not answer it on its own, and a Resume tells it to the
  resumed lead. Stop during the learning pass is the run's own (`ActiveRun.stopped`): the chat's
  next message does not set the pass going again, and a new build that waited for the pass does not
  start.

## After the build: the same session

Once a Loop run whose journal seated a lead (`director.lead.chatSession` is a boolean: the chat's own
session, or a lead of its own) has closed — finished or paused — the chat's own session answers the
chat's next message with the run's controls (`loop/after-loop-run.ts`, words in
`after-loop-run-prompts.ts`), on the message's engine or, when it names none, the lead's, when that
engine holds a session (`afterLeadLoopRun`). A run under way, the classic pipeline, the long turn, a
run with no journal and an engine without sessions (Ollama) get a plain chat turn: the chat's own
session, or the local tool loop, with no run controls.

- **Where it runs.** `afterLeadLoopRun` resolves the turn once (`AfterLoopRun.engine`, `.model`), and
  the turn's record and options both take it: the message's engine, else the lead's; the model the
  message names, else on the lead's engine the lead's (`plannerModel`), so the same session goes
  on on the same model, and a Resume's lead continues it (`continuesChat`). The lead's model is
  borrowed only on the lead's engine, and a throttled chat turn never falls back to another engine
  (`delegated-turn.ts`).
- **Its hands back.** It is an ordinary chat turn (`runDelegatedTurn`) resuming the chat's
  bookmark in the game folder, no longer read-only: the person's words as they wrote them, and no
  note of the build, which the session led itself; what it keeps of the run are its tools.
  After a finished run requested work is its own, done in the game folder like any chat change
  (preview health pass and all), or a new Loop (below).
- **The run's controls, live.** The delegation carries `runControls {runId, messageId}`; the host
  honours it only for the chat's own session (`honouredRunControls`: never a director, builder,
  read-only session or build worktree) and adds `run_status` (`RunControl`, `runControlTools`) to
  its host tools, answered by `conversation.runControl`, for the run named — one that is not the
  chat's latest is refused ("The run changed"). The session asking is not one of the run's workers
  in `run_status`.
- **Resuming a paused run.** After a paused Loop that worked in the game folder (`AfterLoopRun.inPlace`;
  a web game's Loop an earlier Genex paused is refused on Resume, so none is offered after it), on
  the lead's engine (`AfterLoopRun.onLeadEngine`),
  `resume_run` is bridged in as a recorded tool
  (`interviewTools`, beside the Loop's start), without its `runId`: only the instruction (`text`)
  is taken (`resumeAsked`), so it resumes the run it answers after. The session's reply ends
  first, then the chat does it (`resumeAfterReply`) through the host's `run.control` `resume_run`, which
  records the instruction as a `run_steering` of that message and resumes the journal; a reply that
  ended early after recording it still resumes, and says so. The chat then holds its next message
  until run-dispatch.ts has reserved the run, or holds it already (resumed meanwhile from Builds)
  (`untilReserved`, at most `RESUME_RESERVED_WITHIN_MS`), so a message sent during or just after that reply waits for the
  run or reaches its lead instead of being answered as after a paused run again. Stop in that
  window keeps the run paused and says so: `handleRunStart`, which clears a thread's Stop as it
  reserves, asks `resumeStopped` first. The resumed run seats this same session as its lead
  (`leadSeat`), so the build stays one conversation. A refusal is said in the chat; a question
  alone resumes nothing; Stop during the reply resumes nothing. A turn on another engine is offered
  no resume: it moves the chat's bookmark to that engine, so a later Resume from Builds seats a fresh
  lead (or the lead's own session from before the pause).
- **More work after a finished run.** A finished build is never started again. The chat's own
  session is handed `start_autopilot` as every chat turn is (`delegated-turn.ts` `launches`): it
  makes a contained change itself and, for more than a reply holds, starts a new Loop from the game
  folder as it is now (`chat-dispatch.ts` `launchOrSayWhy`), a run of its own on the Builds graph.
  **Keep building** sends the finished build's open gaps as an ordinary message
  (`keep-building.ts` `keepBuildingAsk`), which the session answers the same way. After the long
  turn, the classic pipeline, a gauntlet or a run with no journal the chat's turn is a plain one
  with the same Loop start; an engine without sessions (Ollama) is handed none, and answers and
  edits. The finished run's own journal decides whether its Loop led in place (`director.open`),
  whatever the folder reads as now; the folder's kind only when there is no journal.

## Sending and rewinding

The composer shows a sent message at once and passes its bubble id as `clientId`; main hands it
to the queue as `messageId` (message-queue capability, or before the harness has reported its
capabilities: waiting for them at launch would leave a first message's bubble beside its row), so
the durable row replaces the bubble exactly (`renderer/chat/pending-sends.ts`). A send never reads the whole log unless it may go to
plan review, and `listAllEvents` returns only ids at or below one taken when the pass starts, so
the renderer's single cursor cannot skip a row committed to a thread it already read.

Rewinding a game chat to a message is a projection, never a truncation (`shared/chat-rewind.ts`).
Any handled or delivered message can be the target, and a bubble with no queue record (older
chats, a note to a build) by its own event id. `rewindChat` refuses while the chat has a send or
a plan being written, or, with no build running, a turn, delegation or completion, and while a
message is `processing` or `steering`. A running build is stopped first as the composer's Stop
does (plus `run_stop`), without resuming the queue; the rewind waits up to two minutes for it to
close (`run.settled`, its jobs ended, nothing of the chat or the project in flight; the limit and
clock are the `rewindBuildStop` test seam), keeps the files, and resumes the queue afterwards, or as soon as the
rewind fails. `resumeAutopilot` and every send wait for a chat being rewound. It
withdraws everything from the message's first `coordinator_message_processing` (a delivered or
queue-less message: its bubble) through the head, plus the earlier rows of that message and of
input sent after it, and every row of a plan review reaching into that range. Rows in the range
that settle something begun before it stay (`keep`): queue records of messages that stay, the
`turn_ended` of a turn begun before it, the lifecycle of a build started before it, the answer
to a question asked before it, a job's `job_ended` whose start stays, and the `job_started` of a
job with no end yet (a rewind stops only a build's jobs; another job goes on, and withdrawn it
would run with no line and no Stop), and likewise a worker's `worker_finished` whose start stays
and the `worker_started` of a worker still working. Builds started after it leave the chat with it, so routing
(`latestRun` over `events.list`) and the run's controls, the lead, plan review
(`continuingRun`), a graph note's steer and the files a chat names no longer reach them; the Builds panel still has them. Queue holds, build
observations, bookkeeping and the `conversation_rewound` marker stay. The
ranges are indexed in thread metadata `rewinds`, which main applies to the harness's
`events.list`/`events.messages`, `chatPage` and the `chatState` fold, so every harness version and
every agent-edited file reads the shortened conversation; the renderer also reads the markers.
Resumed sessions keep their id and remember the withdrawn turns, so metadata `contractor` is
cleared, and the harness view drops session
ids recorded before the rewind (run mirrors' always, rewound or not). Held follow-ups are removed
through the queue and return to the composer with the message.

Before each processed message main saves the game folder: `events.append` starts the checkpoint
and `turn.begin` waits for it (30 s at most; a late one is not kept), so the queue lock is never
held, and the folder after each answer is saved too. First, the game's plugin steps that ask to run
for each message (`checkpoint.before` hooks with `messages: true`) save the engine's state into the
folder within that wait, less 5 s kept for the snapshot; Plan mode, a lock not given or no time left
skips them, and the folder is saved whatever they answered ([plugins](plugins.md#before-each-chat-message)).
The same steps run before the snapshot taken after each answer, so what an answer changed only in
the engine lands inside its own pair ([plugins](plugins.md#before-each-chat-message)). `chat-checkpoints.ts` reads the folder
through a private index with executable Git configuration disabled, first copied from the
repository's with its times (read before the copy, rounded down to the second, so the copy is
never dated later than its content), so a same-size edit in the second Git last read the file is
still seen (Git compares file times to the second). It preserves raw file
bytes instead of running clean/smudge filters, including LFS. Chat links also read stored blobs
without downloading or converting LFS pointers. It never captures `.env` or `.env.*`, packages, build output or nested repositories,
and leaves out files over 50 MB and the largest ones past 1 GB of new content; each checkpoint
records what it left out, and a restore never touches those paths. Leaving them out is never
silent: a checkpoint that skips a new set of files for their size appends the host-only
`checkpoint_skipped` (`by: checkpoint`, each file's size), the confirmation names the changed ones
(`tooLargeFiles`), and a restore that left some appends it with `by: rewind`. Each report is also
noted for the thread (`unsaved-files.ts`, memory only): its next delegated session with host tools
reads them after the cut-off notice (`delegation-prompts.ts` `unsavedFilesNotice`) until one settles. It commits as the studio on
`refs/studio/chat/<thread>/before|after/<message>` with hooks off, without moving HEAD, branches
or the user's index. Restoring changes the working tree only, and only while HEAD is the
checkpoint's parent. The pre-rewind folder is saved on `.../rewound/<id>`; a restore that fails
partway, or a rewind that fails after it, is put back from there. A rewind that put files back
records that `<id>` as `rewindId` on its marker, and its chat line offers **Bring back newer
version** (`studio:chat.rewind.undo`, `ChatRewindService.undo`) while it is the chat's newest
rewind, no message was sent after it and it was not taken (`undoRewindRefusal`):
`ChatCheckpoints.restoreSaved` saves the present on a `rewound/` ref of its own, then restores that
copy under the restore steps, only while HEAD is still its parent, and the host appends
`conversation_rewind_undone`. The conversation stays rewound. Paths the restored ignore rules
cover are never deleted, a folder still holding anything never saved is not replaced by a file,
and reference pictures only withdrawn messages added are removed. Paths changed outside the
chat's answers (between an `after` and the next `before`) are named in the confirmation; when a
later answer left no checkpoint the confirmation says it cannot tell, and the switch starts off.
The preview's `files` is `unavailable` with a reason when they cannot come back: `build-running`,
`joined-answer`, `build-changed` (a build after the message landed, or moved HEAD), or the
checkpoint's `no-checkpoint`, `history-changed` and `too-large` (every changed file too large to
save, named in `tooLargeFiles`; the rewind records them as `checkpoint_skipped` by `rewind` even
when only the chat goes back); `stopsBuild` says a build is
stopped first. The host restores nothing then: it ignores the request for a running or landed
build, a joined message and a message with no checkpoint (no queue record, or none kept), and a
checkpoint that no longer applies refuses it.
The person may free a game's space (`studio:storage.free`, `core/storage-space.ts`), which also
deletes Genex's folders for older builds (`substrate/storage-folders.ts`): every
`refs/studio/chat/**` of the game and the `refs/studio/runs/<run>/**` of runs that ended (but the
game's newest ended run) go in one
`update-ref` transaction, Genex's own copies under its scratch folder whose folder is gone are
forgotten (never `worktree prune`: a worktree of the person's on an unmounted drive keeps its
commits), then `repack -A -d` and `prune` remove what nothing else reaches and is older than an
hour (reflogs stay): like git's own `gc`, the grace keeps objects a save point, a checkpoint or the
person's own command has just written. The space it reports matches: `clearableBytes` is what a
clear removes now (with copies an earlier clear left once they are old enough), `recentBytes` what
is younger than the hour and goes at a later clear. It is refused while a contractor builds
in the game or a run of it is going, clears nothing in a folder inside another repository or in a
linked worktree, and runs in `ChatCheckpoints.exclusive`, which resets the private index afterwards.
The ref roots are `REWIND_REFS` and `RUN_REFS` in `shared/game-history.ts`.
After the rewind takes effect (the thread index is written), the marker and the harness notice
are best effort and never undo it.

## Provider patterns consulted

[Codex App Server](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn) separates
thread resume, turn start, steering with an expected turn id, and interruption.
[Claude SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
supports queued messages, while [session resume](https://code.claude.com/docs/en/agent-sdk/sessions)
restores a specific native session.

Our `codex exec` and Claude SDK transports remain in use. The chat's own turn takes messages
through Claude Code's streaming input, read at the next tool result — never a token stream
steered mid-sentence; the app still owns the durable queue. A build worker's turn is aborted and
resumed (`engine.interrupt`), with the instruction read first in the same session, and so is a
chat session on Codex: `turn/steer` exists only in Codex's experimental App Server, which also
lacks the `--ignore-user-config` isolation `exec` relies on. Native session recovery can require a
fresh session if the provider no longer has the old one; the saved conversation/run snapshot then
restores context.

Validation covers the real harness/substrate with scripted Codex and Claude adapters, held
workers, ordered follow-ups, editing/removal and restart replay, Stop-to-next-message handoff,
retained plans, conversational continuation, duplicate starts, addressed instructions and graceful
finish (`chat-queue-stop.test.ts`: replay on boot, Stop while a plan is written or a message still
sends, Stop's hand-over to queued input, a stale Plan flag). `chat-steer.test.ts` covers the chat's turn: a message
read mid-turn and recorded where, the Codex interrupt-and-resume fallback, the first-prompt path,
Stop, Rewind and restart replay; engine conformance covers the Claude input and Codex resume.
`director-wake-loop-run.test.ts` (L1–L10) covers live chat: answered by the lead within one wake while
the run is going, steered into a turn natively and by interrupt (the first turn of a lead continuing
the chat's session too, told a stop is `wrap_up`), Stop's hand-over, the long turn's
queue, the chat freed before the learning pass, a crash's hand-back
before the close — each answered after by the chat's own session — and Stop during the pass; `harness-incidents.test.ts` (LC rows) covers what a resumed lead is told, the
tool-call guard, owed words, the wake cap, the release races, a picture among messages and a
first turn cut for the words (LC12–LC14).
`director-one-session.test.ts` (S1–S13) covers one session: the chat's session leading its run
from the game folder, building in the worktree it leads, and answering after the close in the same session with the run's
controls (Claude and Codex), a chat session that cannot be resumed, a merge
conflict given to a worker, a conflict worker that leaves markers, the studio's hands for a lead
(its uncommitted edits committed as its work, the game folder played from a worktree), showing, landing and changing the game
after a finished run, a paused run a question leaves alone and an instruction resumes with
the same lead, a message sent during that resuming reply held for the resumed run, Stop in that
window keeping it paused, a message naming no engine or another engine — the chat's own
session there with the run's controls (S10) — and after a finished run a Loop the session starts
as a new run and a question that starts nothing (S12, S13);
`after-loop-run.test.ts` (A1–A14) which runs the chat's own session answers after and on which
engine and model, its note, its grant, its recorded resume (hostile rows too), the hold and Stop,
and the Loop's start beside them; `chat-feedback.test.ts` one row per run control;
`lead-sessions-host.test.ts` covers the lead's grant, lock and bookmark on the host, hostile roots
and links too, and the run's controls (only for the chat's own session, the asker's own hold, a
dirty folder, another run); `harness-incidents.test.ts`
OS1–OS6 the markers a conflict worker leaves, a lead's uncommitted edits committed as its work, a first turn refused while the
lead's lock is held, and a landing over the game folder's uncommitted changes (named, blamed on
nobody, a merge of the user's own under way never undone), and a run started again after a close
of its own that a loop crash left open (RO3, RO3b); RO5c–RO5d a message after a build whose lead
was a session of its own (a question, no lead seated) and RO6 a command's result; NC1–NC5 one
session answering every message (a classic paused build, a lead of its own, another engine,
Ollama, and a message sent while a Loop prepares, handed to the lead alone); the always-launch rows
every chat turn on the person's words handed the Loop's start, and no direct engine. The Electron
build smoke exercises Send during an active build and graph preservation, without paid model calls.

### Intake approval before a run exists

Every chat turn goes to an ordinary contractor session in the game folder (its brief, tools,
capture and host tools) with the Loop's start, `start_autopilot` (`loop/start-autopilot.ts`),
bridged in as a tool it may call or not (`delegated-turn.ts` `launches`): never in a run's turn,
and never on words Genex wrote itself (`from: genex`: a command's result, the cover step, a
plugin's words in the chat), except its word after the person's held Loop. An engine without sessions is handed none: the tool lives
outside `tools/`, so the direct engines' tool loop never lists it. The tool's description says
what a build is, the whole making of the game, and when one starts: as the agent sets to making the
game or a change beyond a quick fix, instead of doing that work in its reply, going on with a paused
build (`resume_run`) and starting a new one only when needed; it starts from the folder as the reply
leaves it. When to call it is the agent's own decision. It answers, researches, writes plans or makes
a quick fix itself, or starts a build, and the chat never says a Loop started unless that call
answered. A recorded question is asked (after the preview health pass when game sources
changed); a recorded launch starts from the folder as the session left it; a turn that records
neither is reported as a chat build. A non-launching turn that changed game sources takes the preview health pass and a
`build_observation`; one that only wrote docs/ or Markdown (a plan, research notes) takes neither
(`game.contentStamp` `split`: both stamps from one walk). Nor does any turn on a game that is no web
page (`holdsWebGame` in `loop/web-game.ts`): one linked to an Unreal project (`engine` on its
`game.list` descriptor), which instead saves and snapshots the editor work it left unsaved
([plugins](plugins.md#a-games-engine)), one whose facts hold no `web-game` at its root
([project facts](plugins.md#project-facts); an older descriptor's `web: false`), or one with no kind
yet (no facts: nothing to look at until its first message picks one). The pass goes by the game as the turn ends, read from
`game.list` again, so the turn that links the game through `unreal__new-game` takes none either; a
host that cannot answer leaves the descriptor the turn started with. A session's capture tool and
contract check go by the folder's facts (`servedAsWeb` in `loop/folder-facts.ts`: a web game at the
root, or no kind yet; never a folder of a kind Genex can't name): a Godot folder gets none of the
web's. Its context (`chatContext`) names the folder, never what it holds, and plugin tools,
guidance and connectors go by the game's facts ([scope by facts](plugins.md#scope-by-facts)): no web-only skills, and the Unreal
editor's tools only for a game that holds an Unreal project. A game with no kind yet, while an
engine plugin offers a kind (`plugins.tools`'s `kinds`), is handed `ask_user` beside the kind tools;
a recorded question is asked, and the next turn resumes the same session, which calls
`unreal__new-game` for Unreal. A build it starts there before the game has its kind
(`start_autopilot` recorded, no question) waits once (`kindsBeforeLaunch`): the same session is told
to make the kind first (`kindFirstNotice`), goes on with that kind's tools, and its launch then
starts the build; started on a game with no kind, a build takes the web starter, which no call of
its own can change. A chat turn whose game's served facts changed (a port, or files it
wrote) goes on by itself in the same session, with the tools for the new kind
(`continueOnNewFacts`, [plugins](plugins.md#scope-by-facts)), told Genex's one line of the
project's new kind (`factsReadyNotice`); when the new kind's plugins hook
`health` (an Unreal project linked or switched), it first waits until nothing is pending. A delegation that gave
a game with no kind its kind by files it wrote tells the app the game changed when it ends. The health pass waits on the page's own readiness (`preview.ready`
with `gesture: false`, so the user's window is never clicked): up to the project's boot budget
(15 s by default) for a page that signals readiness, the old short grace for one that signals
nothing, and the old settle only when the host cannot answer.
`build_observation` keeps the delegation's duration, turns and usage and that answer (`ready`:
ready, ms, pageMs, timedOut, via, phase, reason); the turn's reply carries the same usage marked
`usage_source: delegation`, so field rows and the evals count that call once. A project's first ready preview on a thread after
a chat build writes `preview_ready` (`{project, runId?, ms, via}`, `ms` from the build's hand-off),
which the [evals](evals.md) read as time to first preview. `buildInterviewBrief`, the write-less
interview of older harnesses, stays exported because a seed upgrade keeps an edited
`delegated-turn.ts`.

A follow-up such as “nice recommendations, keep going” is handed the Loop's start as every chat
turn is (`intake-continuation.test.ts`); no text match takes it away. While a run is under way a
follow-up goes to its lead; after the run the chat's own session has the Loop's start again, for a
new run, and nothing commissions a duplicate run while one owns the project.

A chat asks with `ask_user` when it is handed it (a game with no kind yet, while a plugin on offers one). The question card answers on one press of an answer button (⌘↩ presses the recommended one), and the composer takes custom text. The selected answer remains an ordinary durable user message; reference images are not duplicated in the chat context. No worker or native provider turn waits while the question is open. Routine decisions, repairs and failure reports never become answer forms. Handoff/session bookkeeping is recorded as `contractor_handoff` diagnostics rather than assistant prose.
