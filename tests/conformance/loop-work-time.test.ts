/**
 * The time a person asks a Loop to work ("work 3h on that"): the chat's session names it when it
 * starts the Loop, the run carries it, and on the Loop's own clock its lead cannot finish before that
 * much work is done; a turn that ends with nothing at work is woken to go on; once the time is up the
 * lead is told and its next turn is the last; a pause keeps the time worked for the resume. A lead
 * whose own word closed the Loop once ran 2 h 20 min of three hours asked, three times (sword duel).
 * Also: a lead's own pause call is answered before Genex ends its session, so the engine never
 * answers it as the person's refusal.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { startAutopilot } from "../../src/harness-seed/loop/start-autopilot.ts";
import { MAX_IDLE_KEEPS } from "../../src/harness-seed/loop/director/work-time.ts";
import { PAUSE_CALLS_MS, PAUSE_END_MS } from "../../src/harness-seed/loop/director/open/contract.ts";
import { OPEN_WORDS } from "../../src/harness-seed/loop/director/open/prompts.ts";
import { MESSAGE as OPEN_END } from "../../src/harness-seed/loop/director/open/finish.ts";
import { chatContext } from "../../src/harness-seed/loop/chat-session.ts";
import { askedMinutes, MAX_WORK_MINUTES, spanWords } from "../../src/harness-seed/loop/work-time.ts";
import { WORK_WORDS } from "../../src/harness-seed/loop/work-time-prompts.ts";
import { LOOP_WORDS } from "../../src/harness-seed/loop/director/wake-prompts.ts";
import { gameRepo, type LoopHost, type LoopTurn, loopHost } from "../helpers/loop-host.ts";
import { copyProject, Project } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const MINUTE = 60_000;
/** No Loop here may hang the suite: each is over in a few seconds when it works. */
const TEST_TIMEOUT = { timeout: 60_000 };
const GODOT = [{ id: "godot-project", path: "." }];
const SUMMARY = "The duel's run and roll animations step instead of sliding.";

let runs = 0;

/** The run's budgets as `start_autopilot` writes them for the person's words. */
function launchBudgets(args: Record<string, unknown>): Record<string, unknown> {
  const outcome = startAutopilot.execute({ goal: "keep working on the animations", ...args }, {
    engine: "claude-code",
  } as never) as { details: { run: { budgets?: Record<string, unknown> } } };
  return outcome.details.run.budgets ?? {};
}

/** A Loop's host on a Godot game, the person having asked for `hours` of work. */
async function timedHost(turns: LoopTurn[], hours = 1): Promise<LoopHost> {
  const dir = await gameRepo(await copyProject(Project.GodotGame, await tmpDir("work-time-")));
  runs += 1;
  return loopHost({
    dir,
    facts: GODOT,
    turns,
    run: { runId: `run-timed-${runs}`, budgets: launchBudgets({ hours }) },
  });
}

/** The journal the Loop keeps, as its artifact holds it. */
const journalOf = (host: LoopHost) =>
  host.artifacts.get(`autopilot_${host.run.runId}`) as {
    run: { budgets: Record<string, unknown> };
    director: { worked: number };
  };

describe("the time the person asks for, as the chat's session names it", () => {
  it("is their hours and minutes together, in whole minutes, at most a day; anything else names none", () => {
    assert.equal(askedMinutes({ hours: 3 }), 180);
    assert.equal(askedMinutes({ hours: "1.5" }), 90, "a bridge may send the number as text");
    assert.equal(askedMinutes({ hours: 1, minutes: 30 }), 90);
    assert.equal(askedMinutes({ minutes: 45 }), 45);
    assert.equal(askedMinutes({ hours: 100 }), MAX_WORK_MINUTES);
    for (const hours of [undefined, null, 0, -2, "abc", "", 0.001])
      assert.equal(askedMinutes({ hours }), null, String(hours));
  });

  it("rides on the launch's budgets only when named, saying the time ends it", () => {
    assert.deepEqual(launchBudgets({ hours: 3 }), {
      workMinutes: 180,
      workFromMs: 0,
      completionPolicy: "duration",
    });
    assert.deepEqual(launchBudgets({}), {});
  });

  it("reads as a person reads it", () => {
    assert.equal(spanWords(3 * 60 * MINUTE), "3 h");
    assert.equal(spanWords(140 * MINUTE), "2 h 20 min");
    assert.equal(spanWords(40 * MINUTE + 20_000), "40 min");
    assert.equal(spanWords(-MINUTE), "0 min");
  });
});

describe("a Loop the person gave a time", () => {
  it(
    "tells its lead the time first, refuses its finish before the time is worked, and closes on it after",
    TEST_TIMEOUT,
    async () => {
      const answers: unknown[] = [];
      const host = await timedHost([
        async ({ host, tool }) => {
          host.pass(20 * MINUTE);
          answers.push(await tool("finish", { summary: SUMMARY }));
          return undefined;
        },
        async ({ host, tool }) => {
          host.pass(41 * MINUTE);
          answers.push(await tool("finish", { summary: SUMMARY }));
          return undefined;
        },
      ]);
      const report = await host.start();
      const [first, second] = host.prompts();
      // Flipped (SC-4): the first line is the goal and its bounds (LOOP_WORDS.started), then the time asked.
      assert.equal(first, `${LOOP_WORDS.started(String(host.run.goal))}\n${WORK_WORDS.asked("1 h", "1 h")}`);
      assert.equal(answers[0], WORK_WORDS.tooSoon("1 h", "20 min", "40 min"));
      // The refused turn ended with nothing at work: the lead was woken to go on, not closed.
      assert.equal(second, WORK_WORDS.keepWorking("1 h", "20 min", "40 min"));
      assert.match(String(answers[1]), /^The Loop is closed on your word/);
      // Its summary is told the time it really worked: 61 min, and what Genex's own waits took.
      assert.match(String(answers[1]), / The Loop worked 1 h \d+ min of the 1 h the person asked for: say how long/);
      assert.equal(report.victory, true);
      assert.equal(host.leadCalls().length, 2);
    },
  );

  it("an untimed Loop's lead hears no time and closes on its first finish, as before", TEST_TIMEOUT, async () => {
    const answers: unknown[] = [];
    const dir = await gameRepo(await copyProject(Project.GodotGame, await tmpDir("work-time-")));
    const host = loopHost({
      dir,
      facts: GODOT,
      run: { runId: `run-untimed-${++runs}`, budgets: launchBudgets({}) },
      turns: [
        async ({ tool }) => {
          answers.push(await tool("finish", { summary: SUMMARY }));
          return undefined;
        },
      ],
    });
    const report = await host.start();
    // Flipped (SC-4): the goal's line carries its bounds (LOOP_WORDS.started).
    assert.equal(host.prompts()[0], LOOP_WORDS.started(String(host.run.goal)));
    assert.doesNotMatch(String(answers[0]), /worked/);
    assert.equal(report.victory, true);
  });

  it("the person's Finish ends it before its time", TEST_TIMEOUT, async () => {
    const answers: unknown[] = [];
    const host = await timedHost([
      async ({ host, tool }) => {
        host.pass(10 * MINUTE);
        host.inbox.finishing = true;
        answers.push(await tool("finish", { summary: SUMMARY }));
        return undefined;
      },
    ]);
    const report = await host.start();
    assert.ok(String(answers[0]).startsWith(OPEN_WORDS.personFinished), String(answers[0]));
    assert.equal(report.stoppedBecause, OPEN_END.personFinished);
  });

  it(
    `a lead woken to go on that does nothing ${MAX_IDLE_KEEPS} times in a row pauses its Loop as any idle Loop`,
    TEST_TIMEOUT,
    async () => {
      const host = await timedHost([
        async ({ host }) => {
          host.pass(5 * MINUTE);
          return undefined;
        },
      ]);
      const report = await host.start();
      const prompts = host.prompts();
      assert.equal(prompts.length, 1 + MAX_IDLE_KEEPS, prompts.join("\n---\n"));
      for (const woken of prompts.slice(1))
        assert.match(woken, /^Your turn ended with nothing at work, but the person/);
      assert.equal(report.executionStatus, "paused");
      assert.equal(report.stoppedBecause, OPEN_END.nothingAtWork);
    },
  );

  it(
    "once its time is up while the lead works, the lead is told at its next step and its next turn is the last",
    TEST_TIMEOUT,
    async () => {
      const answers: unknown[] = [];
      const host = await timedHost([
        async ({ host }) => {
          host.pass(61 * MINUTE);
          await host.until(() => host.steered.some((one) => one.text.includes("are up")));
          return undefined;
        },
        async ({ tool }) => {
          answers.push(await tool("finish", { summary: SUMMARY }));
          return undefined;
        },
      ]);
      host.steerTakes = true;
      const report = await host.start();
      const told = host.steered.find((one) => one.text.includes("are up"));
      assert.equal(told?.text, WORK_WORDS.timeUp("1 h", "1 h 1 min"));
      assert.equal(told?.interrupt, false, "Genex's line never cuts the turn short");
      assert.equal(host.prompts()[1], WORK_WORDS.wrapUp("1 h", "1 h 1 min"));
      assert.match(String(answers[0]), /^The Loop is closed on your word/);
      assert.equal(report.victory, true);
    },
  );

  it("its lead's turn ending after the time is up without a finish closes it, saying why", TEST_TIMEOUT, async () => {
    const host = await timedHost([
      async ({ host }) => {
        host.pass(61 * MINUTE);
        return undefined;
      },
    ]);
    const report = await host.start();
    assert.equal(host.leadCalls().length, 2, "the turn after the time is up is the last");
    assert.equal(report.stoppedBecause, OPEN_END.timeUp);
    assert.equal(report.executionStatus, "completed");
  });

  it(
    "a pause keeps the time worked: the resume says what is left and refuses a finish until then",
    TEST_TIMEOUT,
    async () => {
      const answers: unknown[] = [];
      const why = "I need the person to sign in to the store.";
      const host = await timedHost([
        async ({ host, tool }) => {
          host.pass(30 * MINUTE);
          await tool("pause", { why });
          return undefined;
        },
        async ({ tool }) => {
          answers.push(await tool("finish", { summary: SUMMARY }));
          return { ok: false, stopReason: "aborted" };
        },
      ]);
      const paused = await host.start();
      assert.equal(paused.executionStatus, "paused");
      const worked = journalOf(host).director.worked;
      assert.ok(worked >= 30 * MINUTE && worked < 31 * MINUTE, `worked ${worked}`);

      // The app closed meanwhile: an hour passes that the run did not work.
      host.pass(60 * MINUTE);
      host.run.budgets = journalOf(host).run.budgets;
      await host.start({ resume: true });
      const resumed = host.prompts()[1] ?? "";
      assert.ok(resumed.includes(WORK_WORDS.asked("1 h", spanWords(60 * MINUTE - worked))), resumed);
      assert.match(
        String(answers[0]),
        /^Not finished: the person asked for 1 h of work, and the Loop has worked 3[01] min, so (29|30) min is left\./,
      );
    },
  );

  it("a resume once its time is spent goes on with none: its finish closes it", TEST_TIMEOUT, async () => {
    const answers: unknown[] = [];
    const host = await timedHost([
      async ({ host, tool }) => {
        host.pass(30 * MINUTE);
        await tool("pause", { why: "I need the person to sign in." });
        return undefined;
      },
      async ({ tool }) => {
        answers.push(await tool("finish", { summary: SUMMARY }));
        return undefined;
      },
    ]);
    await host.start();
    const journal = journalOf(host);
    journal.director.worked = 2 * 60 * MINUTE;
    host.run.budgets = journal.run.budgets;
    const report = await host.start({ resume: true });
    assert.ok(!String(host.prompts()[1]).includes("The person asked for"), String(host.prompts()[1]));
    assert.match(String(answers[0]), /^The Loop is closed on your word/);
    assert.equal(report.victory, true);
  });

  it(
    `a lead that answers each wake with a finish Genex refuses is woken ${MAX_IDLE_KEEPS} times, then its Loop pauses`,
    TEST_TIMEOUT,
    async () => {
      // A refused finish is no work: the lead was woken until the time ran out, a full turn each time.
      const finishing: LoopTurn = async ({ host, tool }) => {
        host.pass(MINUTE);
        await tool("finish", { summary: SUMMARY });
        return undefined;
      };
      const host = await timedHost(Array.from({ length: 10 }, () => finishing));
      const report = await host.start();
      assert.equal(host.prompts().length, 1 + MAX_IDLE_KEEPS, host.prompts().join("\n---\n"));
      assert.equal(report.executionStatus, "paused");
      assert.equal(report.stoppedBecause, OPEN_END.nothingAtWork);
    },
  );

  it(
    "a save point of an unchanged folder is no work either: the lead is woken twice, then its Loop pauses",
    TEST_TIMEOUT,
    async () => {
      const saving: LoopTurn = async ({ host, tool }) => {
        host.pass(MINUTE);
        await tool("save_point", { label: "Done", summary: "Nothing left to do." });
        await tool("finish", { summary: SUMMARY });
        return undefined;
      };
      const host = await timedHost(Array.from({ length: 10 }, () => saving));
      const report = await host.start();
      assert.equal(host.prompts().length, 1 + MAX_IDLE_KEEPS, host.prompts().join("\n---\n"));
      assert.equal(report.executionStatus, "paused");
    },
  );

  it(
    "a lead that commits its own work each turn keeps working: what the folder holds moved",
    TEST_TIMEOUT,
    async () => {
      let turns = 0;
      const committing: LoopTurn = async ({ host, tool }) => {
        turns += 1;
        host.pass(15 * MINUTE);
        await writeFile(path.join(host.dir, `part-${turns}.txt`), `part ${turns}\n`);
        await host.git("add", "-A");
        await host.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", `part ${turns}`);
        if (turns === 5) await tool("finish", { summary: SUMMARY });
        return undefined;
      };
      const host = await timedHost(Array.from({ length: 5 }, () => committing));
      const report = await host.start();
      assert.equal(host.leadCalls().length, 5, "woken after each turn of committed work");
      assert.equal(report.victory, true, "and closed on its finish once the hour was worked");
    },
  );

  it("a failed turn's wrap-up, its last, lets its lead claim the goal before the time", TEST_TIMEOUT, async () => {
    const answers: unknown[] = [];
    const host = await timedHost([
      async ({ host }) => {
        host.pass(10 * MINUTE);
        return { ok: false, stopReason: "error", errorText: "the provider broke" };
      },
      async ({ tool }) => {
        answers.push(await tool("finish", { summary: SUMMARY }));
        return undefined;
      },
    ]);
    const report = await host.start();
    assert.equal(host.leadCalls().length, 2);
    assert.match(String(answers[0]), /^The Loop is closed on your word/);
    assert.equal(report.victory, true);
  });

  it(
    "a session opened fresh late in the run hears the time left then, not at the Loop's start",
    TEST_TIMEOUT,
    async () => {
      const host = await timedHost([
        async ({ host }) => {
          host.pass(40 * MINUTE);
          return undefined;
        },
        async ({ params }) => {
          if (params.resume) throw new Error(`No conversation found with session ID: ${String(params.resume)}`);
          return undefined;
        },
        async ({ host, tool }) => {
          host.pass(30 * MINUTE);
          await tool("finish", { summary: SUMMARY });
          return undefined;
        },
      ]);
      await host.start();
      const fresh = host.leadCalls()[2];
      assert.equal(fresh?.resume, undefined, "a fresh session");
      const told = ((fresh?.notices ?? []) as string[]).join("\n");
      assert.match(told, /The person asked for 1 h of work: (19|20) min of it is left\./);
      assert.ok(!told.includes(WORK_WORDS.asked("1 h", "1 h")), told);
    },
  );

  it("a resume never hands its lead the time lines of the session before its pause", TEST_TIMEOUT, async () => {
    const host = await timedHost([
      async ({ host, tool }) => {
        host.pass(61 * MINUTE);
        // Genex says the time is up; the lead never reads it, and pauses.
        await host.until(() => host.steered.some((one) => one.text.includes("are up")));
        await tool("pause", { why: "I need the person to sign in." });
        return undefined;
      },
    ]);
    const paused = await host.start();
    assert.equal(paused.executionStatus, "paused");
    host.run.budgets = journalOf(host).run.budgets;
    await host.start({ resume: true });
    const resumed = JSON.stringify(host.leadCalls()[1] ?? {});
    assert.ok(!resumed.includes("are up"), resumed);
    assert.ok(!resumed.includes("Wrap up now"), resumed);
  });
});

describe("a lead's own pause", () => {
  it(
    "is answered before Genex ends its session, which waits for the lead to end its turn itself",
    TEST_TIMEOUT,
    async () => {
      let abortsAtAnswer = -1;
      let answer: unknown;
      let pausing = false;
      const why = "I need the person to pick the door's colour.";
      const host = await timedHost([
        async ({ host, tool }) => {
          // A minute's work first, so the pause's journal save has something new to write.
          host.pass(MINUTE);
          pausing = true;
          answer = await tool("pause", { why });
          abortsAtAnswer = host.rec.paramsOf("engine.abort").length;
          return undefined;
        },
      ]);
      // The pause call's own journal save is slow: Genex's watch looks at the turn the whole while,
      // well past the lead's time to end its turn.
      const call = host.rec.ctx.call;
      let slowed = false;
      host.rec.ctx.call = async (method: string, params?: Record<string, unknown>) => {
        if (method === "artifact.write" && pausing && !slowed) {
          slowed = true;
          const from = host.now();
          await host.until(() => host.now() - from > 2 * PAUSE_END_MS);
        }
        return call(method, params);
      };
      const report = await host.start();
      assert.ok(slowed, "the pause call's save was slowed");
      assert.equal(answer, OPEN_WORDS.pausing);
      assert.equal(abortsAtAnswer, 0, "no abort while the lead's pause answered");
      assert.equal(host.rec.paramsOf("engine.abort").length, 0, "the lead ended its turn itself: nothing to end");
      assert.equal(report.executionStatus, "paused");
      assert.equal(report.stoppedBecause, why);
    },
  );

  it(
    "a lead that works on after its pause has its session ended once its time to end the turn is over",
    TEST_TIMEOUT,
    async () => {
      let early = -1;
      let ended = false;
      const host = await timedHost([
        async ({ host, tool }) => {
          await tool("pause", { why: "I need the person to sign in." });
          const from = host.now();
          // Genex looks at the turn for a while inside the lead's time to end it.
          await host.until(() => host.now() - from >= PAUSE_END_MS / 2);
          early = host.rec.paramsOf("engine.abort").length;
          host.pass(PAUSE_END_MS);
          ended = await host.until(() => host.rec.paramsOf("engine.abort").length > 0);
          return { ok: false, stopReason: "aborted" };
        },
      ]);
      const report = await host.start();
      assert.equal(early, 0, "not inside the lead's time to end its turn");
      assert.ok(ended, "Genex ended the session that worked on");
      assert.equal(report.executionStatus, "paused");
    },
  );

  it(
    "a pause whose own save never answers still has its session ended, after the calls' longer while",
    TEST_TIMEOUT,
    async () => {
      let held = false;
      let stuck = true;
      let early = -1;
      let ended = false;
      let pauseAnswered = false;
      let endedUnderCall = false;
      const aborts = (host: LoopHost) => host.rec.paramsOf("engine.abort").length;
      const host = await timedHost([
        async ({ host, tool }) => {
          // A minute's work first, so the pause's journal save has something new to write.
          host.pass(MINUTE);
          held = true;
          const pausing = tool("pause", { why: "I need the person to sign in." }).then(() => {
            pauseAnswered = true;
          });
          const from = host.now();
          await host.until(() => host.now() - from >= 2 * PAUSE_END_MS);
          early = aborts(host);
          host.pass(PAUSE_CALLS_MS);
          ended = await host.until(() => aborts(host) > 0);
          endedUnderCall = ended && !pauseAnswered;
          stuck = false;
          await pausing;
          return { ok: false, stopReason: "aborted" };
        },
      ]);
      // The pause's own journal save never answers until the test lets it.
      const call = host.rec.ctx.call;
      host.rec.ctx.call = async (method: string, params?: Record<string, unknown>) => {
        if (method === "artifact.write" && held) await host.until(() => !stuck);
        return call(method, params);
      };
      const report = await host.start();
      assert.equal(early, 0, "a slow pause call is answered first");
      assert.ok(endedUnderCall, "one that never answers is not waited for forever");
      assert.equal(report.executionStatus, "paused");
    },
  );

  it(
    "a call of Genex's tools that never answers holds the end of a paused lead's session off for a while, never forever",
    TEST_TIMEOUT,
    async () => {
      let held = false;
      let stuck = true;
      let early = -1;
      let ended = false;
      let noteAnswered = false;
      let endedUnderCall = false;
      const aborts = (host: LoopHost) => host.rec.paramsOf("engine.abort").length;
      const host = await timedHost([
        async ({ host, tool }) => {
          await tool("pause", { why: "I need the person to sign in." });
          held = true;
          const note = tool("note", { text: "The door stays red." }).then(() => {
            noteAnswered = true;
          });
          const from = host.now();
          await host.until(() => host.now() - from >= 2 * PAUSE_END_MS);
          early = aborts(host);
          host.pass(PAUSE_CALLS_MS);
          ended = await host.until(() => aborts(host) > 0);
          endedUnderCall = ended && !noteAnswered;
          stuck = false;
          await note;
          return { ok: false, stopReason: "aborted" };
        },
      ]);
      // The note's journal save never answers until the test lets it.
      const call = host.rec.ctx.call;
      host.rec.ctx.call = async (method: string, params?: Record<string, unknown>) => {
        if (method === "artifact.write" && held) await host.until(() => !stuck);
        return call(method, params);
      };
      const report = await host.start();
      assert.equal(early, 0, "past the lead's time to end its turn, but a call still answers");
      assert.ok(ended, "Genex ended the session once the call had held it long enough");
      assert.ok(endedUnderCall, "with the call still unanswered");
      assert.equal(report.executionStatus, "paused");
    },
  );
});

describe("whose no a tool's answer is", () => {
  it("every session is told that an engine's 'user doesn't want' answer is a cut-off, never the person's refusal", () => {
    const context = chatContext({ folderLabel: "duel", appLanguage: null });
    assert.match(context, /user doesn't want to take this action[^.]*means Genex or your engine cut the call off/);
    assert.match(context, /never tell them they declined it/);
  });
});
