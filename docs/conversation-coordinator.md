# Conversation and build lifecycle

A game chat message is input to the game's conversation: the chat's own session answers it, leads
a build it launches, and goes on after the build with the run's controls. It is not a request to
create a run. A separate read-only coordinator answers only where no lead of the chat's own led
([the coordinator, a fallback](#the-coordinator-a-fallback)). Studio's app-wide chat bypasses both
and uses tool-free model completion with conversation and recorded Studio activity. Historical game
runs in an older Studio thread must not bind a new Studio question to that game's coordinator.

The failure this addresses: with Autopilot enabled — the switch the user now reads as
**Loop** (the redesigned composer groups it under Mode), while the harness keeps the word (`start_autopilot`, `AutopilotCommission`,
`autopilot_<runId>`) — every follow-up re-entered the intake interview with `start_autopilot`
available. The existing run and a new run could then share a thread, cancellation flag, live
project, and graph: a request to wait for the remaining workers could start a second run.

## Ownership

- The harness owns run identity, the plan, worktrees, scheduling, deadline and cancellation.
  It reserves one run per thread/project synchronously, before planning or any model request.
- The chat owns conversation: the harness's queue (`loop/message-queue.ts`) and the chat's own
  session. Messages are persisted before acknowledgement and queued in order per chat. A
  follow-up sent while the chat's own response works joins that response
  ([steer](#steering-the-chats-turn)); one sent while a run's lead works goes to that lead
  ([live chat](#live-chat-during-a-build)); any other, or one that cannot join, waits for the
  current response and for the build to close — the run itself, never the learning pass after it;
  other chats remain independent. The transcript
  shows follow-ups in muted bubbles below the current work: Sending… until the response reads
  them, or Queued with Remove while they wait (the harness keeps edit/hold for older clients).
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
- The chat's bookmark is its own session: worker and coordinator sessions never overwrite it. A
  delegation that names a run, coordinator, director or build worktree `cwd` never writes metadata
  `contractor`, and the harness view always drops the session ids run sessions mirror into the
  chat (`payload.runId`), so a follow-up never resumes a director, scout or builder that carries
  such a marker. Two run delegations carry none and are still recorded as the chat's session: the
  classic integrator without an integration worktree and a base build with no project folder. One
  run delegation is the chat's on purpose: a waking run's lead whose director grant says
  `chatSession` sits in the game folder and continues the chat's own session, so the host keeps its
  session as `contractor` and the harness writes its `contractor_session`
  ([one session](#live-chat-during-a-build)). `run_status` reads the builders' capability facts
  (plugins, account state, connectors); its recorded conversation revision remains separate from
  planning and applied execution revisions.
- After a run its lead led, the chat goes on in that same session with its hands back
  ([after the build](#after-the-build-the-same-session)): it answers, after a finished run does
  requested work itself (Loop off, or a contained change with Loop on) or, with Loop on, reopens the
  same run for more work, until the ask is checked (a new run only when asked to start over; the
  [coordinator](#the-coordinator-a-fallback)'s `continue_build` reopens one it answers for too), resumes a paused one with the latest instruction, and shows or
  lands the build. Questions alone do not restart builders. Sending a message needs no Keep going
  button.
  Optional **Resume** also keeps the journal; a run interrupted by a quit or a crash is repaired
  at boot as paused, keyed on its journal artifact rather than on `mode`, so a director run is
  resumable too. A resumed
  director run goes on from its journal with the working time it had left — never a fresh
  budget (only a finished run reopened with Loop gets one), and time spent paused
  does not count (a run whose worked time used its working time
  gets only its wrap-up) — with the workers, the defects nobody owns and the news from before the
  pause in its lead's first digest
  ([the full journal](agent/architecture.md#the-run-director-workers-and-judging)). Starting a
  second run while one owns the project is rejected independently of any model prompt or UI
  state.

## Controls and delivery

The run's controls are host-owned tools (`shared/coordinator.ts` `CoordinatorTool`, answered in
`main/core/conversation.ts`) whichever session calls them: the coordinator all of them, the chat's
own session after its run the ones it keeps (`RunControl`, named from `CoordinatorTool`). The
host records each call it answers, so the chat shows the session's own mirror of one as no second
row, and a resume the session only recorded shows once, when the chat does it
(`renderer/chat-entries.ts` `recordedByHost`). `run_status` reads the run's durable progress (a
director's wakes, `director_continued`, and a steer's hand-overs, `run_steering_delivered`, are not
progress and stay off its list). `steer_run` records an instruction addressed to
that run, optionally to a facet. Only these instructions and explicit gallery feedback reach
worker briefs; chat questions do not. Delivery has two speeds, and both are recorded as
`run_steering_delivered`: this means placed in front of a worker, not successfully implemented.
Unaddressed guidance waits for the next brief (stage `next brief`). An instruction addressed to a
worker, a `worker_steer now=yes`, and any steer to a single session (which has no boundary)
interrupt that worktree's build turn — the host verb `engine.interrupt {cwd}` aborts the turn,
the engine hands back its session id, and the loop resumes that same session with the steer in
front of everything (`facet_steered`) — and are recorded with stage `now`, so the answer the
coordinator gives an addressed steer says the worker's turn is interrupted rather than promising
the next iteration boundary. Messages during planning or base creation remain in the same inbox.
Delivery and wrap-up are read from the log (`loop/run-inbox.ts`): a resumed session of the same
run hands over only steers with no `run_steering_delivered` yet, and a `finish` counts only after
the run's latest `run_registered` (`finishRequested`, the app's copy in `shared/coordinator.ts`).
A resumed run never inherits an earlier wrap-up, and `finish_run` after Resume is recorded again.
Its director's first message (its first `worker_wait` on the long turn, `directorLoop: "turn"`) still says
every earlier steer once, since the run may have opened a fresh session that never heard them —
all but the chat's messages a run's lead heard or gave back ([live chat](#live-chat-during-a-build));
on the wake loop they open that message's digest, read from the journal (THE USER SAYS: the newest
20, each cut at 2,000 characters, with a count of those left out).

`finish_run` is distinct from Stop: it lets in-flight facet attempts finish, prevents new facet
rounds, then merges, performs an integration attempt and validation, and displays accepted
work. It does not promise the result passes all checks. Stop remains explicit cancellation.
`resume_run` can only resume a paused journal and cannot create a replacement run; a finished
run is reopened by the harness itself once a Loop message's reply recorded `reopen_run` or the
coordinator's `continue_build`, never through it
([reopening a finished run](#after-the-build-the-same-session)).

In a director run (a session-capable engine's Autopilot, including managed Bonsai) the workers are the
director's, not the plan's: `steer_run` without a facet wakes a resting director at once and opens
its next digest word for word (THE USER SAYS; a director in the middle of a turn hears it when that
turn ends, and `run_status` lists it meanwhile — a chat message handed to a waking lead reaches that
turn itself), and the director forwards what applies with
`worker_steer`; a
facet-addressed instruction needs a plan facet, and since the lead's mandatory `plan` records
its workers on the journal there is one: an instruction naming a planned worker is accepted and
routed to that worker, interrupting its build turn (`inbox.addressed()`, `routeUserSteers`), and
one naming a worker that is not building right now reaches the director as "USER SAYS about
<id> … it is yours to act on" rather than being dropped. It is rejected only before `plan` has
been called, or for an id the plan does not have. `finish_run`
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
opens no session; a chat turn stopped while it prepared starts no builder. A Stop still settling
after `STOP_RETRY_MS` can be pressed again.
There is no global sidebar Stop control or confirmation sheet. Escape remains scoped to the
composer and a chat-only turn. Wrapping up uses `finish_run` through `studio:run.finish`, which
refuses a run that is no longer running. A worker the director stops
mid-round keeps its work: the round is committed to its own ref,
`refs/studio/runs/<runId>/attempts/<facet>/<n>-stopped` (a ref, never a branch — the game's
`git branch` and `git tag` lists stay the user's), its worktree is left standing, and it is
neither judged nor rolled back; the reason names the director, never the user.

"Run the project" after a run: `show_build` puts a build in the
user's window — `live` (the game folder), `integration` (the run's merged head, from
`run_finished.integrationHead` or the journal, loaded from a worktree of its own) or a commit —
for a running, finished or paused run alike; `land_build` merges the integration head (or a
commit) into the game folder and shows it, for a finished or paused run only (a running run
lands through `finish_run`). Either loads Live only for a message the person sent that is still
unanswered (the host's note, whatever id the harness names) and only while Live, holding that
game, is out of their sight: such a message cannot tell "show me" from "change the title", and a
chat's own session once showed its edit into the Live the person watched. Otherwise the build is offered to
Live's Reload by commit, and a landing lands and offers the game folder. Both refuse plainly: no integration branch yet, a dirty game folder,
a contractor building in it — never the chat's own session that asks, which holds the folder only
while it waits for the answer (`landBuild` `asker`) — or a repository inside the game the studio
was never given consent to version. A finished run is never "inactive" for these two.

The run and chat have separate status lanes. Chat completion cannot clear a worker's status.
Send and Stop share one composer slot: a sendable draft shows Send, otherwise active work shows
Stop. Selecting Auto in Mode is not cancellation. **Plan mode** (Add) is an explicit one-message choice
and resets after submission and when work starts. In the permissions pill's Plan, a build the chat's
session records waits for the plan's approval, and `continue_build`, `resume_run` and `land_build`
do not run ([permissions](tool-permissions.md)).
Active/paused work bypasses stale review flags. Planning and revision preserve the original request, recent conversation, previous proposed or
approved plan, and saved run state. Explicit approval is still required before executing a newly
requested plan; sending a revision never approves it.

## Steering the chat's turn

A message sent while the chat's own turn works — the chat's own session (a Loop chat's, and after a
run it led, too) or a run's coordinator, whichever answers the chat — is delivered into that
turn instead of waiting for it to end. The queue decides what joins, the host how the session takes it, and the log
records where it was read. Build steering (`steer_run`, `worker_steer`, the director's inbox) is
unchanged: while a run of this chat or its game is starting or running nothing is steered into a
chat turn; messages go to the run's lead ([live chat](#live-chat-during-a-build)) or wait.

- **What joins.** The runner of the processed message gets a steer handle (`loop/message-queue.ts`
  `SteerHandle`). When its turn will be answered by a session (`steer.expect`, from
  `chat-dispatch.ts` before the turn is set up, by the message's engine or, when it names none, its
  run's), a message sent meanwhile joins it if nothing older waits, no build runs and `steersInto`
  allows it: same engine and model, the same intake commission (mode, hours, roles, plan review,
  effort — a different one would be dropped by joining), no new mood board, no slash
  text. Its receipt then carries `coordinator_message_steering {messageId, into}`, so it shows as
  Sending…, never Queued first. What joins before the session starts goes into its first prompt
  (`steer.open`; `coordinator_message_delivered`, `how: "prompt"`); what joins while it runs is
  handed to it. Studio's chat, local models without sessions and a message that cannot join wait as
  Queued with Remove; a runner that never starts a session returns what joined to the queue.
- **Read mid-turn.** `engine.steer {threadId, into, messages}` (`main/core/chat-steer.ts`) finds the
  delegation whose `chatTurn` is `into`, waiting up to `FIND_SESSION_MS` for it to register — never
  a build worktree, the director, a playtester or a candidate. An engine with `steersMidTurn` takes
  it: Claude Code keeps the SDK input open (an async-iterable prompt,
  `substrate/engines/claude-steer.ts`) and pushes the message with `priority: "next"`,
  `origin: {kind: "human"}` and a uuid. The CLI folds it in at the next tool result, or runs it as a
  follow-up turn of the same session when it arrives during the final answer. Its
  `command_lifecycle` `started` frame is the moment it was read: the engine emits `steer_delivered`,
  and the host appends `coordinator_message_delivered {how: "native"}` in stream order among the
  turn's mirrored rows, which is where the chat shows the bubble (`delivery-order.ts`). This needs a
  CLI that advertises `msg_lifecycle_v1` in its init capabilities (2.1.281 does); the input stays
  open until a result has answered everything read, so a late message is never cut off, and one
  taken but never started closes it after `STEER_STALL_MS`, reported as not delivered.
- **Interrupt and resume.** Any other session — Codex (`codex exec` closes stdin at spawn),
  Bonsai, an older Claude Code, and every Loop chat (a message folded in at its question's or
  launch's tool result would be answered by a turn that had already decided) — is interrupted
  (`steered`, never read as a Stop). `loop/chat-steer.ts` `steeredCall` appends
  `coordinator_message_delivered {how: "interrupt"}` and resumes the same session with
  `steeredTurnPrompt` in front; a session cut before it read its prompt gets that prompt again
  with the messages after it. Messages reach it in the order they were sent.
- **Not read.** Whatever a session took but did not read — a Stop (checked again before every
  resumed leg), a turn that ended first, a Loop chat that had already asked its question or
  launched, a leg that failed or was stopped before it read its prompt (with anything an earlier
  cut-off leg forwarded to it) — is `coordinator_message_requeued` in the order it was sent,
  before the turn's `handled`, and gets a turn of its own, so Stop still hands over to the oldest
  waiting message.
- **Delivered is final.** The turn it joined answers it: it never gets a processing event or a
  checkpoint of its own. Rewinding to it withdraws it from its bubble on (the files stay; the turn
  it joined keeps its end and `handled`), and rewinding the message it joined withdraws it too. When
  a coordinator's turn continues the build (`continue_build`), the builder gets the latest request
  for the message plus whatever was steered in that the coordinator did not restate; a build it
  reopens gets them as its ask, a replay's carried messages too (`reopenRequest`), and the
  message's pictures only as the coordinator's words for them. The builder turn never answers a
  question the chat's own session asked (`followupOf`, `turn-loop.ts` `plainChat`), so it inherits
  no Loop and no launch tool from one.
- **Restart.** `restore` requeues `steering` like `processing`, and `events.inbox` keeps both, and
  a message delivered into a turn still owed its answer. That message rides in the turn's replay
  (`steer.carried`, in its first prompt) instead of being asked again; one delivered into a
  finished turn, or into one a second restart cut off (never retried: `MESSAGE_ATTEMPTS`), stays
  settled with it. A turn that began before the replay reached its chat takes none of the replayed
  messages, and removing a replayed turn gives what it had read a turn of its own.

`steeredCall` knows only "the session that is the chat's current turn"; the run's lead answers
the chat through its own wake loop instead (below). What steer added to the seed never comes from a
module that shipped before it (`SteerDelivery` is `loop/steer-delivery.ts`, the build check is in
`live-chat.ts`): a seed upgrade keeps the agent's edited `message-queue.ts` or `studio-state.ts`, and
the harness still loads with them ([seed upgrades](harness-runtime.md)).

## Live chat during a build

While a director run is going on the wake loop, its lead is the chat: a message sent meanwhile is
handed to it at once, and it answers in the chat. The long turn (`directorLoop: "turn"`,
`STUDIO_DIRECTOR_LOOP=turn`), the classic pipeline and a kept `director.ts` from before live chat
open no line, and their messages wait for the run to close as before. A waking run's start
says so (`autopilot_started.liveChat`) when the chat's queue hands messages to it (main.ts tells
`live-chat-served.ts` `serveLiveChat` which queue it wired; a kept older `message-queue.ts` lacks
`SERVES_LIVE_CHAT`), and while it runs the composer reads "Talk to the lead while
it builds…" instead of "Sends when the build finishes…" (renderer `chat/live-chat.ts`).

- **One session.** The lead is the chat's own contractor session, not a second one
  (`loop/director/lead-session.ts`, words in `lead-session-prompts.ts`). `runDirector` seats it
  (`leadSeat`, on a Resume too) on the chat's bookmark — its latest `contractor_session`, which a
  chat turn now records with its model — when its engine, game and model are the lead's
  (`continuesChat`; a bookmark without a model counts as the same). With no bookmark the lead opens
  a session that becomes the chat's; with one on another engine or model it keeps a session of its
  own (on a Resume, the journal's when `director.lead.chatSession` is false) and leaves the
  bookmark alone. A fresh lead session — none to resume, one lost, a later turn with none — is told
  the chat's latest 20 messages first (`freshChat`), then its brief and the digest; reference stills
  reach a fresh session and the lead's first turn.
  The delegation names no `cwd` (the game folder), is `readOnly`, and its director grant's `root` is
  the integration worktree, with `chatSession` when it is the chat's. The host honours that grant
  (`#leadRoot`) only for a `readOnly` delegation in this game's live folder, and only for a root
  whose real path is below its run's own folder — `scratch/autopilot/<runId>/`, a real directory,
  never a link to another run's — in the same repository (`--git-common-dir`), of a run the host's
  records say is this game's: started (`run_registered`, `run_started`) in a chat of this game and
  in no other game's, since `snapshot.worktree` can put any game's worktree under any run id. The
  engine, the window, capture, computer and reads get that checked real path, never the name the
  harness sent; a lead reads only that worktree of the run's folder, beside the game folder and the
  run's own artifacts. Its lock is that worktree, not the game folder, so the chat's other turns
  there and Make it live go on while it thinks; a turn refused because the lock is held
  (`DelegationRefusal.FolderBusy`, the error's `code`) is asked again after a wait, and a first turn
  refused for good ends as a failed turn rather than the run's crash (`wake.ts` `askSession`). The
  host keeps a `chatSession` lead's session as the chat's `contractor` after each turn; the harness
  writes its `contractor_session` when it changed (`bookmarkLead`). Claude Code reads without
  Write, Edit or Bash; Codex, which can always write where it is started, runs from a scratch
  folder of its own (its one writable root, with the bridge) and resumes the chat's session there
  by id, which Codex finds wherever it starts; a local (Bonsai) session resumes in the same folder
  or starts fresh.
  The lead builds with its own hands in the integration worktree it leads, by its full path, and
  commits there (`syncHead` adopts its commits before each run tool); workers take the parts that
  run side by side. It keeps no `.studio/DIRECTOR.md` (`prepareLoopRun({ oneSession })`
  restores none, `keepMemory` keeps none; an older run's file stays in its artifacts): the
  journal and its digests carry the run. The brief, the build card, the fresh start, the resume
  note, a worker from before a pause, `worker_start`'s answer and `integrate`'s description speak
  to that lead when `run.lead` is set (`LEAD_BRIEF` and the other lead words in
  `lead-session-prompts.ts`), and to a director with its own hands otherwise; the playbook names
  both seats, and `longTurnRules` gives the long turn's director its hands back. A merge conflict
  goes to a worker (`director/conflict-worker.ts` `resolveByWorker`): a single `merge-<id>` from
  the integration branch, owning the conflicted files, with the merge opened in its worktree before
  its session (`mergeFirst`, keyed by a symbol a model's JSON cannot carry); the studio commits the
  merge when it stops, and the lead integrates that worker. A session that leaves a conflict hunk
  in any file it was to resolve (`markersLeft`) — done, unfinished or stopped — commits nothing:
  the merge is aborted, the worker fails naming the files, and `integrate` refuses it
  (`unresolvedOf`). Changes no worker made in the integration worktree (a game that builds in
  place) are set aside for a lead before a merge or a playtest of integration (`setAsideStrays`: a
  commit over the integration head on `refs/studio/runs/<runId>/set-aside/<stamp>`, then a reset),
  and the answer says what was kept where. For a lead a single worker starts on a fork that does
  not run (its repair; a loop worker is still refused), a playtest of the game folder plays a
  worktree at its commit, and a merged build that does not run is answered in the lead's words.
  After the close the chat goes on in it with its hands back
  ([after the build](#after-the-build-the-same-session)), and a Resume leads in it again.

- **The line.** `runDirector` opens `openLeadLine` (`loop/director/lead-line.ts`) once the run
  exists, so a message sent while it prepares reaches the lead's first message; the wake loop
  shuts it when the wrap-up begins, and the run releases it at its close (a Stop's too).
- **The hand-over.** The queue asks `leadDoor` (`loop/live-chat.ts`) for each message. The lead
  takes words from the run's own chat — no pictures, slash text or Studio chat — while
  its line is open and nothing older waits. Its receipt then carries `coordinator_message_delivered
  {into: <runId>, how: "lead"}` and a `run_steering {runId, text, sourceMessageId}` the lead's
  inbox reads: never Queued, never processed, no turn or checkpoint of its own, and its bubble sits
  where it was delivered. A message that waited (sent while the run prepared) is handed the same
  way once `beforeProcess` (`chatWaitsFor`) answers with the lead's door. What the lead does not
  take waits for the close and is answered then, but holds nothing back: words sent after it
  still reach the lead, in order among themselves (`chatWaitsFor` answers null when a line opens
  or shuts, and the queue hands past it). The lead may so answer a later message before the chat
  answers the picture; each bubble sits where it was delivered.
- **Hearing it.** A resting lead is woken at once (a user wake, never debounced) with THE USER
  SAYS. A turn under way hears it in that turn: the wake loop takes the words off the inbox and
  calls `engine.steer {threadId, into: <runId>}` — the director's delegation carries `chatTurn:
  {messageId: <runId>}` on a waking run, which the host honours only for that run's director
  grant. Claude Code reads it at its next step (`midTurnUserSays`); any other engine, on a later
  turn with a session to resume, not the wrap-up and not inside a director tool call
  (`toolsInFlight`, whose answer a cut would lose), is interrupted and resumed in the same session
  with a user wake that says it was cut and asks it to finish what it was doing (a turn cut before
  it read its message is asked it again, the words after it); otherwise `interrupt: false` leaves
  the turn alone. Words a turn did not read, or that a turn failed before working on, open its
  next message (`wake.owed`). A cut is never a failed turn. A message is heard once a turn works on
  (or answers) the message that told it, or reads it mid-turn (`LeadLine.heardThrough`, counted
  after the inbox is read), and is recorded heard (`run_steering_delivered {sourceMessageId, how:
  "lead"}`). The chat's wakes never count in the hourly wake cap.
- **Answering.** What the lead writes is planner text, mirrored as chat bubbles and streamed like
  any reply; the prompts ask it to answer the user directly and briefly, to write otherwise only
  when a part lands, the build can be looked at, something broke, the plan changed or the build is
  done, and say a question never stops or restarts a worker. After the close the same session goes
  on, those words in its history; a coordinator (the fallback) reads them in its prompt.
- **Close and Stop.** The chat waits for a run's close (`ActiveRun.closed`, `done`, set when its
  runner returns), not for the learning pass that follows: the chat answers during that pass (a
  coordinator's `continue_build` is taken for a finished run), and a new build or a reopen — the
  chat's own session's or the coordinator's — waits the pass out. A resumed or reopened run's
  report carries its earlier sessions' workers, rounds, verdicts and notes (`setup.ts`
  `loopRunReport`, from the last `run_finished`), its `judge_N`/`play_N` folders number on from the
  journal, and a session that kept no new round skips the pass (`run-dispatch.ts` `keptNewRounds`).
  Stop pauses the queue — a cancelled run takes no more messages — and hands over to the oldest
  queued message
  once the run has closed. What the lead never heard when its run ended (a Stop, a limit, a
  crash — one while the run prepared too — or the close) goes back to the queue
  (`coordinator_message_requeued`, `LeadLine.release`) before `run_finished`, so Stop hands over to
  it too and it stays Queued; one handed as the line was released goes back at once. A lead's
  delivered message settles in the chat's state when its run closes. The chat answers what went
  back, and its own `resume_run` records the words anew, so a later run of the run never tells
  a message its lead heard or gave back. An app quit gives nothing back: a message the lead never
  heard stays with its run, the chat does not answer it on its own, and a Resume tells it to the
  resumed lead. Stop during the learning pass is the run's own (`ActiveRun.stopped`): the chat's
  next message does not set the pass going again, and a new build or a reopen that waited for the
  pass does not start.
- **Seed upgrades.** Live chat's names come from its own modules (`loop/live-chat.ts`,
  `director/lead-line.ts`, `director/live-prompts.ts`), frozen against `seed-exports-pre-live.json`;
  one session's from `director/lead-session.ts`, `director/lead-session-prompts.ts` and
  `director/conflict-worker.ts`, frozen against `seed-exports-pre-one-session.json`. A run seats
  a lead only when every part it depends on serves one (`director.ts` `seatsLead`: each part —
  `git.ts` too, whose `snapshotCommit` sets strays aside — exports `SERVES_LEAD`, which a kept copy
  from before one session lacks); otherwise a director with its own
  hands leads, and a kept `director.ts` from before it seats none, so every part answers it in
  those words.

## After the build: the same session

Once a run its lead led as the chat's own session has closed — finished or paused — the chat's
next message goes to that same session, not to a coordinator (`loop/after-loop-run.ts`, words in
`after-loop-run-prompts.ts`). `chat-dispatch.ts` sends it there when the run is closed, its journal
says the lead was the chat's (`director.lead.chatSession`), and the message is on the lead's engine
(`roleEngine(run, planner)`) or names none, and that engine holds a session (`afterLeadLoopRun`). A
message on another engine is another session's; it and anything else are
[the coordinator's](#the-coordinator-a-fallback).

- **Where it runs.** `afterLeadLoopRun` resolves the turn once (`AfterLoopRun.engine`, `.model`), and
  the turn's record and options both take it: the lead's engine, also for a message that names no
  engine; the model the message names, else the lead's (`plannerModel`), so the same session goes
  on on the same model and a Resume's lead still continues it (`continuesChat` compares the
  bookmark's model). The lead's model is borrowed only on the lead's engine. A Loop that came with
  the message does not move the turn to its planner (`turn-loop.ts` `turnModel`), and a throttled
  turn never falls back to another engine (`delegated-turn.ts` `fallsBack`).
- **Its hands back.** It is an ordinary chat turn (`runDelegatedTurn`) resuming the chat's
  bookmark in the game folder, no longer read-only: each of its turns, while that run is the
  chat's latest, opens with a note in place of "pick up where you left off" (`afterLoopRunNote`) — the
  build is over, how it ended, what it keeps.
  After a finished run with Loop off (Auto) requested work is its own, done in the game folder
  like any chat change (preview health pass and all): no `continue_build`, no builder follow-up, no
  new run. With Loop on it goes to the same run, reopened (below).
- **The run's controls, live.** The delegation carries `runControls {runId, messageId}`; the host
  honours it only for the chat's own session (`honouredRunControls`: never a director, builder,
  scout, playtester, coordinator, read-only session or build worktree) and adds `run_status`,
  `show_build` and `land_build` (`RunControl`, `runControlTools`) to its host tools, answered by
  `conversation.runControl` as the coordinator's are, for the run named — one that is not the
  chat's latest is refused ("The run changed"). The session asking is not one of the run's workers
  in `run_status`, nor a contractor building in the folder it lands into; a dirty folder is refused.
- **Resuming a paused run.** After a paused run `resume_run` is bridged in as a recorded tool
  (`interviewTools`, like a Loop chat's launch), without its `runId`: only the instruction (`text`)
  is taken (`resumeAsked`), so it resumes the run it answers after. The session's reply ends
  first, then the chat does it (`resumeAfterReply`) through the host's own `resume_run`, which
  records the instruction as a `run_steering` of that message and resumes the journal; a reply that
  ended early after recording it still resumes, and says so. The chat then holds its next message
  until run-dispatch.ts has reserved the run (`untilReserved`, at most
  `RESUME_RESERVED_WITHIN_MS`), so a message sent during or just after that reply waits for the
  run or reaches its lead instead of being answered as after a paused run again. Stop in that
  window keeps the run paused and says so: `handleRunStart`, which clears a thread's Stop as it
  reserves, asks `resumeStopped` first. The resumed run seats this same session as its lead
  (`leadSeat`), so the build stays one conversation. A refusal is said in the chat; a question
  alone resumes nothing; Stop during the reply resumes nothing.
- **Reopening a finished run.** A message the person sends with Loop on after a finished run
  keeps its commission when the chat's own session, or the coordinator
  ([below](#the-coordinator-a-fallback)), may reopen it (`reopen-run.ts` `keepsCommission`); every
  other message for a run drops it, so a paused run's is answered as with Loop off. Words the chat
  writes itself (an `origin`: a command's result) drop theirs once a run exists, before the answering session is chosen, and
  their run is never `reopenable`, so a question's Loop they would inherit reopens nothing either
  (`chat-dispatch.ts` `chatWrote`); the renderer gives a command's result the chat's Loop only while
  no build is the chat's (`loop-setting.ts` `reportCommissions`), a typed message after a finished
  one too (`loopCommissions`). The session is handed `reopen_run {text}` first, then the Loop's
  launch tool and `ask_user` (`sessionTools`); after any other run no launch tool is bridged. Its
  note words the rules (`reopenRules`, `loop/reopen-run-prompts.ts`): Loop allows the build to go
  on and never orders it. A contained change (a fix, a tweak, one feature) is the session's own edit,
  and its report ends "Small change — made directly, no build." (`delegated-turn.ts` `reportBuild`);
  more work records `reopen_run` once, last, editing nothing; a question is answered and reopens
  nothing; only an explicit start over calls the launch tool, which launches a new run from the
  folder; an unclear ask is a question with the session's estimate in each choice. A question recorded beside it wins, and a reopen beats a launch. Once the reply
  ends the chat reopens (`reopenAfterReply`): it reads the journal, waits out the finished run's
  learning pass, then refuses — "The build was not reopened: …" — on a Stop since (it stays
  finished), a run under way, no journal, or a log whose latest run is not this one finished
  (`finishedClose`; the journal is not asked, since a rewound reopen leaves it paused on withdrawn
  work). Otherwise it rewrites the journal (`director/reopen.ts` `reopenedJournal`). The run takes
  the Loop's time as a launch gives it, never the finished build's, always as a `goal` commission
  (`reopenBudgets`: the hours held to the run limits, or ∞ the day's ceiling until satisfied): it
  works until the ask is checked and the lead may finish then. The ask goes on the run as `asks`,
  the latest first, and the lead, judges and playtester read it ahead of the commission, winning
  where they conflict (`goal-prompts.ts` `workingGoal`); `goal` stays what the Builds graph shows.
  It takes the message's picks as a launch from it takes them (`reopenedRun`): the
  finished run's stamps (`model`, `roles`, `rolesApplied`, `builderEngine`, `judgeEngine`,
  `judgeModel`, `effort`, `preferences`, `readiness`) dropped, `model-roles.ts` `withRoles` resolves
  the model the session answers on, the Loop's roles (`reopenAsked`: the message's commission, or
  the question's it answers) and the message's effort and preferences (`chat-dispatch.ts`
  `commissionedWith`, as `intakeRun`); engine and plan are kept, and the planner is the session's
  model, else the finished planner, else `default` — never the builders'. The coordinator's reopen
  has no picks: every model stays the build's own. The run drops `director.clock`,
  `director.wake`, the last health pass, its verified checkpoints (`firstVerifiedCheckpoint`,
  `latestVerifiedCheckpoint`) and progress review (`softReviewAt`), records `goals: null`, and takes
  `integrationHead` from the log's close and the mark `director.reopened {at, finishedHead}`. The
  chat records the ask (the session's `text`, else the message) as that message's `run_steering`
  once per close for the same words — a replayed message finds the one its first answer recorded
  since the close it reopens, never a lead's hand-over record (one with a `how`); restated words are
  recorded anew — clears the mood board, says until
  when the build goes on, and starts the same run through `handleRunStart` as a resume (`keepStop`)
  whose inbox reads from the record just before the ask (`RunStart.reopen.after`, from
  `askTheBuild`), so a steer from before it, an ask a Stop left behind too, is never told.
  Its outcomes are the ask's: `director/journal.ts` `restoreLoopRun` reads `goals: null` as waiting
  for the next plan (a journal with no `goals` key, from before outcomes were kept, takes its
  plan's) and saves keep it null until set, so a Resume before the lead plans never makes the old
  plan's parts its outcomes (nor does a kept older `journal.ts`: `director/reopen.ts`
  `outcomesAwaitPlan` sets those aside); a goal commission with none refuses `worker_start`
  (`director/workers.ts` `goalRefusal`), a reopened ∞ lead's first digest says to plan first
  (`reopenClosing(goal)`), and the first plan taken posts its card and freezes its outcomes — a
  refused plan sets none.
  The run keeps its runId, plan, workers and defects nobody owns; this same session leads it
  (`leadSeat`; after the coordinator's reopen, the lead a Resume would seat); it forks from the
  game folder as it is now when the finished build is in it, else from the finished build
  (`reopenCommits`); its first digest reads THE BUILD GOES ON AT, the earlier workers are the
  finished build's, and new workers join the same Builds graph. The renderer counts its time from
  the reopen (`RunExecution.openedAt`), forgets the first close until the next one (`forgetClose`,
  `reopenAfterClose`), and the earlier result card offers no Resume (`superseded`). A reopen that
  crashes still writes its own close (`closeFailedRun` counts only this session's), and a resumed
  or reopened run whose loop dies while the app lives on is closed by the reborn loop
  (`boot-notice.ts` `runsIn`: a run registered or started again after a close is open again — unless
  the reborn loop runs it again itself, `runsItAgain`). A
  quit after it registers but before the run saves its journal is repaired at boot as finished
  (the journal still says "done"); after the save, as paused.
- **Seed upgrades.** Its names come from its own modules (`after-loop-run.ts`,
  `after-loop-run-prompts.ts`), frozen against `seed-exports-pre-after-loop-run.json`. The chat asks
  before it relies on its parts (`chat-dispatch.ts` `ownSessionAfterLoopRun`): the runner
  (`turn-loop.ts`), the chat turn (`delegated-turn.ts`) and its brief (`chat-session.ts`) each export
  `SERVES_AFTER_LOOP_RUN`, which a kept copy from before lacks, and then the coordinator answers, as
  before. A kept `run-dispatch.ts` never asks `resumeStopped`: the chat still holds for the run.
  The reopen's names come from `reopen-run.ts`, `reopen-run-prompts.ts`, `director/reopen.ts` and
  `director/reopen-prompts.ts`, frozen against `seed-exports-pre-reopen.json`, which also freezes
  the older `coordinator.ts` and `coordinator-prompts.ts`. The chat's own session offers it only
  when the runner, the chat turn, the note (`after-loop-run-prompts.ts`) and the run's start
  (`run-dispatch.ts`) export `SERVES_REOPEN` (`ownSessionReopens`), the coordinator only when
  `coordinator.ts`, `coordinator-prompts.ts` and `run-dispatch.ts` do (`coordinatorReopens`); else
  a Loop message after a finished run is answered as with Loop off. Kept run parts (`setup.ts`,
  `wake.ts`, `journal.ts`, `director.ts`) need no mark: they read the rewritten journal's missing
  clock and wake state as a new run's, a kept `setup.ts` forks from the finished build, and they
  word the reopen as a resume.

## The coordinator, a fallback

The coordinator (`loop/coordinator.ts`, words in `coordinator-prompts.ts`) answers a message about
a run no lead of the chat's own led, once that run has closed: the long turn
(`directorLoop: "turn"`), the classic pipeline, a kept older seed whose run seats no lead, a lead
that was a session of its own (the chat's bookmark on another engine or model), a message to a model
without sessions, a message on another engine than the lead's, and a kept runner, chat turn or brief
that does not serve the same session. The long turn's removal does not take it
([harness runtime](harness-runtime.md)).

Codex and Claude coordinators use a stable scratch directory and a separate persisted native
session per chat/provider (`coordinator_<engine>`). They read project context and call every
host-owned control tool; they cannot write worker files. To the user the coordinator is this
game's chat, never "Studio". It receives the builders' capability facts instead of instructions
for tools it cannot call, so it distinguishes builder access from its own run controls. It gets
the saved plan, progress and conversation, with what a run's lead said in the chat. Requested
work on a paused run uses `resume_run`, recording the latest instruction before the saved journal
resumes; requested work after completion uses `continue_build` (the host's answer,
`main/core/conversation.ts`, names no run either way). Unless a Loop reopens the build (below), the
chat's own session (its bookmark) takes that work in the same chat turn (`followupAsk`) without
another intake or timed run. A completion-only engine answers through the same tools in bounded
rounds.

With Loop on after a finished build whose journal seated a lead (`director.lead.chatSession` is a
boolean: a lead of its own, or the chat's own session when the message went to another engine or a
kept after-run part left it to the coordinator), the message keeps its Loop when its coordinator
answers in a session and the coordinator's parts serve it (`chat-dispatch.ts` `coordinatorReopens`;
`reopen-run.ts` `finishedLoopRun`, model null). Its prompt carries `coordinatorReopenRules`
(`reopen-run-prompts.ts`): `continue_build` with `build: false` hands a contained change to one
builder turn; otherwise it reopens the same build for the Loop's time with the
models it was built with — the one clock it may set going again; a question continues nothing;
the stills it was shown go in `continue_build`'s words, as the build reads its ask as text.
Once the reply ends, a recorded `continue_build` (`run_followup_requested`) reopens the same run
through `reopenAfterReply` ([reopening a finished run](#after-the-build-the-same-session))
instead of a builder turn; its ask is the request plus what was steered into the turn and not
restated. A finished build no Loop can go on from — no lead seated (the long turn, a kept pre-lead
director, the classic pipeline, a gauntlet, no journal), a coordinator on a model without sessions,
or a kept older part (the own session's or the coordinator's) — is answered as with Loop off, and
the chat says so once per finished build while the loop lives (`firstLoopUnused`,
`MESSAGE.loopUnused`). A game built in Unreal is not one of these: a Loop message the person sends
after its finished run goes to no run, as [before a run exists](#intake-approval-before-a-run-exists),
and the session's launch starts the next Unreal Loop (`chat-dispatch.ts` `startsNextUnrealLoop`).
Mode still offers Loop after any finished build. Not solved, an owner
decision: a chat whose finished build cannot be continued (the classic pipeline or a gauntlet, as
on a local model without sessions) has no way to start another timed build there, since "Start a
new build" was removed.

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
(`latestRun` over `events.list`) and the coordinator's run tools, the lead, plan review
(`continuingRun`), a graph note's steer and the files a chat names no longer reach them; the Builds panel still has them. Queue holds, build
observations, bookkeeping and the `conversation_rewound` marker stay. The
ranges are indexed in thread metadata `rewinds`, which main applies to the harness's
`events.list`/`events.messages`, `chatPage` and the `chatState` fold, so every harness version and
every agent-edited file reads the shortened conversation; the renderer also reads the markers.
Resumed sessions keep their id and remember the withdrawn turns, so metadata `contractor` is
cleared, `coordinator_<engine>` artifacts get a null session, and the harness view drops session
ids recorded before the rewind (run mirrors' always, rewound or not). Held follow-ups are removed
through the queue and return to the composer with the message. The harness `rewind` action
(capability `rewind`) only resets the in-memory Loop mood board.

Before each processed message main saves the game folder: `events.append` starts the checkpoint
and `turn.begin` waits for it (30 s at most; a late one is not kept), so the queue lock is never
held, and the folder after each answer is saved too. `chat-checkpoints.ts` reads the folder
through a private index with executable Git configuration disabled. It preserves raw file
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
partway, or a rewind that fails after it, is put back from there. Paths the restored ignore rules
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
The person may clear Rewind history (`studio:game.history.clear`, `core/history-space.ts`): every
`refs/studio/chat/**` of the game and the `refs/studio/runs/<run>/**` of runs that ended go in one
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
After the rewind takes effect (the thread index is written), clearing coordinator sessions,
the marker and the harness notice are best effort and never undo it.

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
retained plans, conversational continuation, duplicate starts, coordinator session recovery,
addressed instructions and graceful finish. `chat-steer.test.ts` covers the chat's turn: a message
read mid-turn and recorded where, the Codex interrupt-and-resume fallback, the first-prompt path,
Stop, Rewind and restart replay; engine conformance covers the Claude input and Codex resume.
`director-wake-loop-run.test.ts` (L1–L8) covers live chat: answered by the lead within one wake while
the run is going, steered into a turn natively and by interrupt, Stop's hand-over, the long turn's
queue (and its coordinator after), the chat freed before the learning pass, a crash's hand-back
before the close — each answered after by the chat's own session — and Stop during the pass; `harness-incidents.test.ts` (LC rows) covers what a resumed lead is told, the
tool-call guard, owed words, the wake cap, the release races and a picture among messages.
`director-one-session.test.ts` (S1–S13) covers one session: the chat's session leading its run
read-only in the game folder and answering after the close in the same session with the run's
controls and no coordinator (Claude and Codex), a chat session that cannot be resumed, a merge
conflict given to a worker, a conflict worker that leaves markers, the studio's hands for a lead
(strays set aside, the game folder played from a worktree), showing, landing and changing the game
after a finished run, a paused run a question leaves alone and an instruction resumes with
the same lead, a message sent during that resuming reply held for the resumed run, Stop in that
window keeping it paused, and a message naming no engine or another engine (S7b, S10b: with Loop
on too; S10c: the coordinator on another engine continuing with Loop 2 h reopens the same run, the
chat's session leading on the build's engine), and a finished run reopened with Loop on — one
run, a fresh budget, the same lead, no steer from before the ask, forking from the folder as
changed since — beside a start over that launches a new run and a question that reopens nothing
(S11–S13);
`after-loop-run.test.ts` (A1–A14) which runs the chat's own session answers after and on which
engine and model, its note, its grant, its recorded resume (hostile rows too), the hold and Stop,
and the reopen's tools, rules, recording (the Loop's roles too), fallback and model;
`reopen-run.test.ts` (R1–R12) the reopen's budgets and policy, eligibility, the message's picks
(R3; R11 against a start over from the same message), journal rewrite, refusals, learning-pass
wait, rewound reopen, a replay's ask and cursor once per close (R8, R8b), the queue-to-run path,
a command's result (R9c) and the coordinator's reopen (R12); `director-journal.test.ts` (K18–K28)
the reopened run's clock, fork, journal read-back, words and worker ids, and its outcomes: set by
its plan for the ask, the finished run's never gating a build reopened with hours, asked of its
plan again by a Resume before it plans; the art director's review and once-only turned-back finish
are per commission (K28); `command-report.test.ts` and `composer-model.test.ts` a
command's result's Loop (`reportCommissions`); `chat-feedback.test.ts` one row per run control;
`lead-sessions-host.test.ts` covers the lead's grant, lock and bookmark on the host, hostile roots
and links too, and the run's controls (only for the chat's own session, the asker's own hold, a
dirty folder, another run); `harness-incidents.test.ts`
OS1–OS6 the markers a conflict worker leaves, strays set aside, a first turn refused while the
lead's lock is held, and a landing over the game folder's uncommitted changes (named, blamed on
nobody, a merge of the user's own under way never undone), and a run started again after a close of its own (a crashed reopen still
closes, and a loop crash under it too, RO3; its inbox from the ask on, RO2 after a replay and
beside a lead's record of the same words); RO1 a reopened build's outcomes, RO4 its picks, RO5–RO5e
the coordinator's reopen (Loop off, a question, no lead seated, a model without sessions) and RO6 a
command's result. The Electron build smoke exercises Send during an active build, graph
preservation, and a finished chat's Mode back on its own Loop, with no new-build choice, without
paid model calls.

### Intake approval before a run exists

Before a run exists, a Loop message goes to an ordinary contractor session in the game folder
(the Auto chat's brief, tools, capture and host tools) with the launch tool (`start_autopilot`,
or `start_unattended_run`) and `ask_user` bridged in. It answers, researches, writes plans or
edits the game itself and launches a build only when the ask is to build or substantially change
the game (`loop/launch-prompts.ts`): Loop grants a build budget, not an obligation. A wish for speed
does not make a new game a contained change. Before it launches, the session must know what the
game is and how it should look, from the conversation, attached stills or the game in the folder;
when either is missing it asks one `ask_user` question with a recommended answer, even when the user
asks for speed, and launches after the answer (the question the write-less interviewer used to
ask). The direct engines' briefing (`turn-prompts.ts`) carries the same rule. A recorded
question is asked (after the preview health pass when game sources changed); a recorded launch
starts from the folder as the session left it; a turn that records neither is reported like an
Auto chat build. A non-launching turn that changed game sources takes the preview health pass and a
`build_observation`; one that only wrote docs/ or Markdown (a plan, research notes) takes neither
(`game.contentStamp` `split`: both stamps from one walk). Nor does any turn on a game that is no web
page (`holdsWebGame` in `loop/web-game.ts`): one linked to an Unreal project (`engine` on its
`game.list` descriptor), which instead saves and snapshots the editor work it left unsaved
([plugins](plugins.md#a-games-engine)), one whose facts hold no `web-game` at its root
([project facts](plugins.md#project-facts); an older descriptor's `web: false`), or one with no kind
yet (no facts: nothing to look at until its first message picks one). The pass goes by the game as the turn ends, read from
`game.list` again, so the turn that links the game through `unreal__new-game` takes none either; a
host that cannot answer leaves the descriptor the turn started with. A brief's rules, capture tool,
contract check and checkpoint line go by the folder's facts (`servedAsWeb` in `loop/folder-facts.ts`:
a web game at the root, or no kind yet; never a folder of a kind Genex can't name): a Godot folder
gets none of the web's. An Unreal game's brief swaps the web template's rules for the
Unreal ones (`loop/unreal-prompts.ts`), with no capture tool, window or web checkpoint line, and plugin
tools, guidance and connectors by the game's facts ([scope by facts](plugins.md#scope-by-facts)): no
web-only skills, and the Unreal editor's tools only for a game that holds an Unreal project. A game with
no kind yet, on any fresh brief until it has one, while an engine plugin offers a kind (`plugins.tools`'s `kinds`), is
briefed to ask Web or that engine first, unless the message names one, with `ask_user` bridged in even with Loop off,
and Unreal offered by what the plugin's `engine-status` says this computer has; the recorded
question is asked like a Loop chat's, and the next turn resumes the same session, which calls
`unreal__new-game` for Unreal. A chat turn whose game's served facts changed (a port, or files it
wrote) goes on by itself in the same session, with the tools and a fresh brief writer for the new
kind (`continueOnNewFacts`, [plugins](plugins.md#scope-by-facts)); one that linked an Unreal
project, or switched its link to another, first waits for Unreal to open it. A delegation that gave
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

A follow-up such as “nice recommendations, keep going” retains the explicitly selected
Autopilot/Loop mode and its launch tool when no run exists. Text matching alone must not strip
launch authority from an unfinished Loop chat. Once a run exists, a follow-up carries no launch
tool — the chat's own session after the run, or the coordinator — except beside the chat's own
session's reopen of a finished run, for an explicit start over
([reopening a finished run](#after-the-build-the-same-session)), and never commissions a
duplicate run.

The Loop chat uses `ask_user` for necessary questions. The question panel requires **Send answer**, or focuses the composer for custom text. The selected answer remains an ordinary durable user message, and commission settings are restored from the question artifact for that reply; reference images are not duplicated in the chat context. No worker or native provider turn waits while the question is open. Routine decisions, repairs and failure reports never become answer forms. Handoff/session bookkeeping is recorded as `contractor_handoff` diagnostics rather than assistant prose.
