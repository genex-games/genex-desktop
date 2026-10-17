/** The actions plugin.json declares, named once for the backend and the steps card. Wire values: never rename. */
export const RobloxAction = {
  Status: "status",
  ToolbarStatus: "toolbar-status",
  Steps: "steps",
  Setup: "setup",
  UndoSetup: "undo-setup",
  RestartStudio: "restart-studio",
  DoItForMe: "do-it-for-me",
  GetStudio: "get-studio",
  CancelGetStudio: "cancel-get-studio",
  OpenStudio: "open-studio",
  QuitStudio: "quit-studio",
  Places: "places",
  UsePlace: "use-place",
  Create: "create",
  AddLuauChecks: "add-luau-checks",
  PublishUpdate: "publish-update",
  FirstPublish: "first-publish",
} as const;
export type RobloxAction = (typeof RobloxAction)[keyof typeof RobloxAction];
