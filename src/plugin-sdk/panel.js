// Include this in a prebuilt panel. No credential values or arbitrary IPC are exposed.
// The longest a panel may wait for one answer. A file picker gets all of it: the person takes their time.
const LONGEST_WAIT_MS = 1800000;
const waiting = new Map();
const contextListeners = new Set();
let seq = 0;
window.addEventListener("message", (event) => {
  if (event.source !== parent) return;
  if (event.data?.type === "studio-plugin-context-changed") {
    for (const listener of contextListeners) {
      try {
        listener();
      } catch {}
    }
    return;
  }
  if (event.data?.type !== "studio-plugin-result") return;
  const p = waiting.get(event.data.id);
  if (!p) return;
  waiting.delete(event.data.id);
  clearTimeout(p.timer);
  if (!event.data.error) return p.resolve(event.data.result);
  const error = new Error(event.data.error);
  // Only a code the SDK knows crosses: "cancelled" when the person declined Studio's confirmation.
  if (event.data.code === "cancelled") error.code = "cancelled";
  p.reject(error);
});
function call(method, name, args, options) {
  // A long setup action may extend its local wait; host validation, confirmations and
  // execution deadlines still apply. Timing out never means a remote job was cancelled.
  const timeoutMs = options?.timeoutMs ?? 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > LONGEST_WAIT_MS)
    return Promise.reject(new Error("Invalid panel wait duration"));
  const id = String(++seq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error("Studio request timed out. Inspect its status before retrying."));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    parent.postMessage({ type: "studio-plugin-request", id, method, name, args }, "*");
  });
}
window.studioPlugin = {
  onContextChanged(callback) {
    contextListeners.add(callback);
    return () => contextListeners.delete(callback);
  },
  call,
  // Studio's own file picker: the chosen file's path, or null when the person cancels.
  chooseFile(request) {
    return call("chooseFile", undefined, request, { timeoutMs: LONGEST_WAIT_MS });
  },
};
// In a dialog's card the panel's heading is the dialog's title and its frame is as tall as the
// panel, so the dialog scrolls once: the SDK tells the dialog both whenever they change, and the
// dialog's Back arrow presses the panel's own Back. The panel's heading and Back stay in its page.
// Its own scope: a panel's script shares the page's globals and may use any of these names.
(() => {
  const HEAD = "[data-panel-head]";
  const BACK = "[data-panel-back]";
  const ON_CARD = `:root[data-surface="card"]{overflow:hidden}:root[data-surface="card"] :is(${HEAD},${BACK}){display:none!important}`;
  let toldHead = "";
  let toldHeight = -1;
  const isShown = (node) => !node.closest("[hidden]") && !node.disabled;
  const shownOne = (selector) => [...document.querySelectorAll(selector)].find(isShown) ?? null;
  const lineOf = (node) => node?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  function tellDialog() {
    const head = shownOne(HEAD);
    const told = {
      type: "studio-plugin-head",
      title: lineOf(head?.querySelector("h1,h2,h3")),
      description: lineOf(head?.querySelector("p")) || null,
      back: Boolean(shownOne(BACK)),
    };
    const key = JSON.stringify(told);
    if (key !== toldHead) parent.postMessage(told, "*");
    toldHead = key;
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height !== toldHeight) parent.postMessage({ type: "studio-plugin-size", height }, "*");
    toldHeight = height;
  }
  function sitOnCard() {
    const style = document.createElement("style");
    style.textContent = ON_CARD;
    document.head.append(style);
    document.documentElement.dataset.surface = "card";
    let queued = false;
    const soon = () => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        tellDialog();
      }, 0);
    };
    const watched = { subtree: true, childList: true, characterData: true, attributes: true };
    new MutationObserver(soon).observe(document.body, { ...watched, attributeFilter: ["hidden", "disabled"] });
    if (typeof ResizeObserver === "function") new ResizeObserver(soon).observe(document.body);
    tellDialog();
  }
  if (typeof document === "undefined") return;
  window.addEventListener("message", (event) => {
    if (event.source === parent && event.data?.type === "studio-plugin-back") shownOne(BACK)?.click();
  });
  call("context")
    .then((context) => {
      if (context?.surface === "card") sitOnCard();
    })
    .catch(() => {});
})();
window.addEventListener("pagehide", () => {
  for (const p of waiting.values()) {
    clearTimeout(p.timer);
    p.reject(new Error("Panel closed"));
  }
  waiting.clear();
});
