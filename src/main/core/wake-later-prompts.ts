/** What `wake_later` says to a model: its description, its answers and the words that wake the chat (`wake-later.ts`). Model-facing text. */
import type { LiveToolSpec } from "../../shared/engine-requests.ts";
import { JobTool } from "../../shared/jobs.ts";
import { ProjectTool } from "../../shared/project-tools.ts";

/** `wake_later`, for the shortest and longest timer in seconds (`wake-later.ts` owns both). */
export function wakeLaterTool(minSeconds: number, maxSeconds: number): LiveToolSpec {
  return {
    name: ProjectTool.WakeLater,
    description: `Wake yourself later instead of waiting inside your turn. When something outside you takes a while (a download or an install in a launcher, an app starting, a render you can't run as a job), don't wait for it with sleep, a wait action or a loop of checks: while your turn runs, the person's messages wait for your next step. Set this timer, tell the person in one line what you are waiting for, and end your turn. Genex starts your next turn when it is due, with your note, and the person's messages are answered at once meanwhile. Pick the time the thing really takes (a download of many GB: minutes, not seconds), from ${minSeconds} s to ${maxSeconds} s. One timer per chat: a new one replaces it, and seconds 0 cancels it. To wait for something a command can check (a file or folder appearing), ${JobTool.Start} with a command that loops until it is true wakes you when it ends, with no turns in between.`,
    parameters: {
      type: "object",
      properties: {
        seconds: {
          type: "number",
          description: `How long from now, in seconds: ${minSeconds} to ${maxSeconds}. 0 cancels the chat's timer.`,
        },
        note: {
          type: "string",
          description:
            "What to check when it wakes you, in one line, e.g. Is the Unreal download in the Epic Games Launcher done?",
        },
      },
      required: ["seconds"],
    },
  };
}

/** How a time the agent asked for was changed to fit: none, the shortest or the longest a timer can be. */
export const WakeLaterFit = { Asked: "asked", Shortest: "shortest", Longest: "longest" } as const;
export type WakeLaterFit = (typeof WakeLaterFit)[keyof typeof WakeLaterFit];

const FIT_WORDS = {
  [WakeLaterFit.Asked]: "",
  [WakeLaterFit.Shortest]: ", the shortest it can be",
  [WakeLaterFit.Longest]: ", the longest it can be",
} as const satisfies Record<WakeLaterFit, string>;

/** What `wake_later` answers. */
export const WAKE_LATER_ANSWER = {
  set: (seconds: number, fit: WakeLaterFit, replaced: boolean) =>
    `Genex wakes this chat in ${seconds} s${FIT_WORDS[fit]}, with your note${replaced ? ", in place of the timer set before" : ""}. End your turn now: tell the person in one line what you are waiting for. If they write first, you answer them, and this timer still wakes you unless you set a new one or cancel it with seconds 0.`,
  cancelled: "Cancelled this chat's wake_later timer: nothing wakes it now.",
  noneToCancel: "No timer was set for this chat, so there was nothing to cancel.",
  noSeconds: (minSeconds: number, maxSeconds: number) =>
    `Give seconds: how long from now, ${minSeconds} to ${maxSeconds} (0 cancels the chat's timer).`,
  noChat: "This session has no chat to wake, so no timer was set.",
} as const;

/** A note as a sentence: a full stop added when it ends without one. */
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/** The words that wake the chat when its timer is due: how long ago it was set, and the agent's note. */
export const WAKE_LATER_PROMPT = {
  due: (secondsAgo: number, note: string) =>
    `The ${ProjectTool.WakeLater} timer you set ${secondsAgo} s ago is due.${note ? ` Your note: ${sentence(note)}` : ""} Check it now. If it isn't done yet, set ${ProjectTool.WakeLater} again (longer if it will take a while) and end your turn; once it is, tell the person in one short line and go on with what you told them you would do.`,
} as const;
