/**
 * The two JavaScript for Automation scripts `app_look` runs through `osascript -l JavaScript -e`
 * (`app-look.ts`). They are constants: a window's values reach them only as arguments, read by
 * `run(argv)`, never spliced into their text. Both only read; neither sends input to any app.
 */

/** The most elements of one window's tree `app_look` reads and shows. */
export const APP_LOOK_MAX_NODES = 300;
/** The deepest level of a window's tree it reads and shows (the window is level 0). */
export const APP_LOOK_MAX_DEPTH = 10;

/**
 * The app windows on screen, front to back, as JSON: `[{id, app, bundleId, pid, title, bounds,
 * layer, onScreen}]`. Core Graphics' window list (on-screen only, without the desktop); a title
 * reads empty for another app's window until Genex has Screen Recording.
 */
export const WINDOW_LIST_SCRIPT = `ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function bundleOf(pid) {
  try {
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    return app.isNil() ? "" : ObjC.unwrap(app.bundleIdentifier) || "";
  } catch (error) {
    return "";
  }
}
function run() {
  const onScreenOnly = 1;
  const withoutDesktop = 16;
  const info = $.CGWindowListCopyWindowInfo(onScreenOnly | withoutDesktop, 0);
  const list = ObjC.deepUnwrap(ObjC.castRefToObject(info)) || [];
  return JSON.stringify(
    list.map((w) => ({
      id: w.kCGWindowNumber,
      app: w.kCGWindowOwnerName || "",
      bundleId: bundleOf(w.kCGWindowOwnerPID),
      pid: w.kCGWindowOwnerPID,
      title: w.kCGWindowName || "",
      bounds: {
        x: (w.kCGWindowBounds || {}).X,
        y: (w.kCGWindowBounds || {}).Y,
        width: (w.kCGWindowBounds || {}).Width,
        height: (w.kCGWindowBounds || {}).Height,
      },
      layer: w.kCGWindowLayer,
      onScreen: w.kCGWindowIsOnscreen !== false,
    })),
  );
}`;

/**
 * One window's accessibility tree, as JSON `{nodes: [{d, role, title, value, description}]}` in
 * walk order. Arguments: the owner's pid, the window's title, then its x, y, width and height.
 * System Events finds the process by its pid, the window by its title, else by its position and
 * size, else its first; it reads each element's role, title or name, value and description, one
 * node past the cap so a longer tree reads as cut.
 */
export const AX_TREE_SCRIPT = `function run(argv) {
  const pid = Number(argv[0]);
  const title = String(argv[1] || "");
  const bounds = argv.slice(2, 6).map(Number);
  const maxNodes = ${APP_LOOK_MAX_NODES + 1};
  const maxDepth = ${APP_LOOK_MAX_DEPTH};
  const events = Application("System Events");
  const found = events.processes.whose({ unixId: pid })();
  if (!found.length) return JSON.stringify({ nodes: [] });
  const windows = found[0].windows();
  const read = (element, name) => {
    try {
      const value = element[name]();
      return value === null || value === undefined ? "" : String(value);
    } catch (error) {
      return "";
    }
  };
  const placed = (w) => {
    try {
      const at = w.position();
      const size = w.size();
      return at[0] === bounds[0] && at[1] === bounds[1] && size[0] === bounds[2] && size[1] === bounds[3];
    } catch (error) {
      return false;
    }
  };
  const window = windows.find((w) => title !== "" && read(w, "name") === title) || windows.find(placed) || windows[0];
  if (!window) return JSON.stringify({ nodes: [] });
  const nodes = [];
  const walk = (element, depth) => {
    if (nodes.length >= maxNodes || depth > maxDepth) return;
    nodes.push({
      d: depth,
      role: read(element, "role"),
      title: read(element, "title") || read(element, "name"),
      value: read(element, "value"),
      description: read(element, "description"),
    });
    let children = [];
    try {
      children = element.uiElements();
    } catch (error) {
      children = [];
    }
    for (const child of children) {
      if (nodes.length >= maxNodes) return;
      walk(child, depth + 1);
    }
  };
  walk(window, 0);
  return JSON.stringify({ nodes });
}`;
