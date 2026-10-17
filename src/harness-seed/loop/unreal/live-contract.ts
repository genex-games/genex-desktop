/**
 * The Unreal plugin's wire names as the Unreal Loop's harness calls and reads them: its harness
 * tools by their agent names, how a queued play-check ends, the shots a play takes, where the
 * project's Genex editor helper stands, and the kind of journal the older step machine wrote (a
 * Resume of one closes it). No behavior; `seed-contracts.test.ts` holds each value
 * to the plugin's own copy.
 */

/**
 * The Unreal plugin's Loop tools, by their agent names (the plugin's `LoopToolName`): the lead's run
 * calls `cpp-status` and `add-cpp-module` (the C++ module's own flow), and a C++ sub-agent checks
 * its code with `check-part`. Every other moment's editor work is the plugin's own step at Genex's
 * moments (`../hooks.ts`); the other names stay for an older copy of `restore.ts` an agent kept,
 * which imports them, and the list mirrors the plugin's whole, as `seed-contracts.test.ts` holds it.
 */
export const UnrealLoopTool = {
  CheckPart: "unreal__check-part",
  RunPart: "unreal__run-part",
  PartResult: "unreal__part-result",
  RollbackPart: "unreal__rollback-part",
  ReloadLevel: "unreal__reload-level",
  ExportReference: "unreal__export-reference",
  BlueprintGuide: "unreal__blueprint-guide",
  FindNodes: "unreal__find-nodes",
  CppStatus: "unreal__cpp-status",
  AddCppModule: "unreal__add-cpp-module",
  ReopenEditor: "unreal__reopen-editor",
  EditorState: "unreal__editor-state",
} as const;
export type UnrealLoopTool = (typeof UnrealLoopTool)[keyof typeof UnrealLoopTool];

/** A queued run's end, as the plugin's `part-result` names it (the plugin's `PartRunState`): a play-check's too. */
export const PartRunEnd = { Done: "done", Failed: "failed" } as const;
export type PartRunEnd = (typeof PartRunEnd)[keyof typeof PartRunEnd];

/**
 * The Unreal plugin's harness tools for a run in the open editor, by their agent names (the
 * plugin's `LiveLoopToolName`). No current module calls them by name (they run as the plugin's
 * steps at Genex's moments); they stay for an older copy of `restore.ts` an agent kept.
 */
export const UnrealLivePluginTool = {
  PlayCheck: "unreal__play-check",
  SaveAll: "unreal__save-all",
  LogErrors: "unreal__log-errors",
  EndEditor: "unreal__end-editor",
  UpdateHelper: "unreal__update-helper",
} as const;
export type UnrealLivePluginTool = (typeof UnrealLivePluginTool)[keyof typeof UnrealLivePluginTool];

/** A play-check's named shots (the plugin's `PlayCheckShot`): at rest where play starts, and after the drive. */
export const LiveCamera = { Spawn: "spawn", Ride: "ride" } as const;
export type LiveCamera = (typeof LiveCamera)[keyof typeof LiveCamera];

/** Where the project's Genex editor helper stands against the plugin's (the plugin's `HelperState`, on `editor-state`). */
export const EditorHelperState = {
  Current: "current",
  Outdated: "outdated",
  Newer: "newer",
  Missing: "missing",
} as const;
export type EditorHelperState = (typeof EditorHelperState)[keyof typeof EditorHelperState];

/** A play shot as the plugin hands it back: its name, the file the editor wrote, and its PNG bytes in base64. */
export type PlayShot = { name: string; file: string; data: string };

/** What the older step machine's journal was (`kind`): a Resume of such a run closes it with a plain line. */
export const LIVE_JOURNAL_KIND = "unreal-live";
