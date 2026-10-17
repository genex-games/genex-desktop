/**
 * Every part a Loop on a project of any kind depends on, read by namespace (`SERVES_OPEN_LOOP`): a
 * seed upgrade keeps a part the agent edited before such Loops, which can't lead one. A module of its
 * own, so the chat's launch (chat-dispatch.ts) and the run's start (run-dispatch.ts), parts an agent
 * may have kept, read one list: the launch says it before any promise, the start for every other way in.
 * The run's start reads the list itself, so the chat's launch adds the start (`SERVES_OPEN_LOOP` on
 * run-dispatch.ts, which it already reads by namespace): a kept older start would run the web method.
 */
import * as builtinHookParts from "./builtin-hooks.ts";
import * as directorParts from "./director.ts";
import * as openContractParts from "./director/open/contract.ts";
import { servesOpenLoop } from "./director/open/contract.ts";
import * as setupParts from "./director/setup.ts";
import * as wakeParts from "./director/wake.ts";
import * as wakeScheduleParts from "./director/wake-schedule.ts";
import * as studioStateParts from "./studio-state.ts";

/** Every part an open Loop depends on. */
const OPEN_LOOP_PARTS = [
  directorParts,
  setupParts,
  wakeParts,
  wakeScheduleParts,
  openContractParts,
  builtinHookParts,
  studioStateParts,
];

/** Whether this harness's parts can lead a Loop on a project that isn't a web game. */
export function openLoopServed(): boolean {
  return servesOpenLoop(OPEN_LOOP_PARTS);
}
