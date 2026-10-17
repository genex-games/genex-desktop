/**
 * A web build put on the stage from anywhere: a result card's Play, Play on the Builds tab, a
 * review's Play. In a folder with more than one Live view (a web game and an Unreal project), the
 * stage then shows the Web game view, whichever tab was chosen before.
 */
export const WEB_BUILD_SHOWN_EVENT = "studio:web-build-shown";

/** Tells the stage a web build of `project` is going on it, before Live is shown. */
export function webBuildShown(project: string): void {
  window.dispatchEvent(new CustomEvent<{ project: string }>(WEB_BUILD_SHOWN_EVENT, { detail: { project } }));
}
