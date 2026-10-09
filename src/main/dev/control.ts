import { setTimeout as sleep } from "node:timers/promises";
import type { WebContents } from "electron";
import { errorMessage } from "../../shared/errors.ts";
import { type InspectParams, inspectScript } from "./inspect-dom.ts";
import { DevErrorCode, DevError, DevMethod, type Operation } from "./protocol.ts";

/** The Chrome DevTools Protocol version the control attaches with. */
const CDP_VERSION = "1.3";
/** Let React finish the initial takeover and the final camera adoption before sampling. */
const DRAG_START_SETTLE_MS = 32;
const DRAG_RELEASE_SETTLE_MS = 180;
const GRAPH_DRAG_POINT_Y = 0.93;
/** CDP modifier bits. */
const CDP_MODIFIER: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
/** Windows virtual key codes of the named keys the control presses; a character uses its own. */
const VIRTUAL_KEY: Record<string, number> = {
  Enter: 13,
  Escape: 27,
  Tab: 9,
  Backspace: 8,
  ArrowDown: 40,
  ArrowUp: 38,
  ArrowLeft: 37,
  ArrowRight: 39,
  PageUp: 33,
  PageDown: 34,
  Home: 36,
  End: 35,
};
/** Where a scroll with no selector turns the wheel: inside the studio's content, clear of the title bar. */
const DEFAULT_SCROLL_POINT = { x: 40, y: 80 };

type ActionOf<M extends Operation["method"]> = Extract<Operation, { method: M }>;

export class DesktopControl {
  #attached = new WeakSet<WebContents>();
  async cdp(wc: WebContents, method: string, params?: Record<string, unknown>) {
    if (wc.isDestroyed()) throw new DevError(DevErrorCode.UnsupportedSurface, "selected webContents is destroyed");
    if (!this.#attached.has(wc)) {
      if (wc.debugger.isAttached()) throw new DevError(DevErrorCode.Busy, "debugger is owned by another tool");
      wc.debugger.attach(CDP_VERSION);
      this.#attached.add(wc);
    }
    if (!wc.debugger.isAttached())
      throw new DevError(DevErrorCode.DebuggerDetached, "restart the owned session after debugger attachment loss");
    try {
      return await wc.debugger.sendCommand(method, params);
    } catch (e) {
      const code = wc.debugger.isAttached() ? DevErrorCode.UnsupportedSurface : DevErrorCode.DebuggerDetached;
      throw new DevError(code, errorMessage(e));
    }
  }
  async inspect(wc: WebContents, params: InspectParams) {
    const value = await wc.executeJavaScript(inspectScript(params));
    if (value.error) throw new DevError(value.error);
    return value;
  }
  async click(wc: WebContents, params: { selector: string; scope?: string }) {
    const { x, y } = await this.inspect(wc, params);
    await this.cdp(wc, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.cdp(wc, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await this.cdp(wc, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    return { dispatched: true, x, y };
  }
  async key(wc: WebContents, params: { key: string; code: string; modifiers?: string[] }) {
    const modifiers = (params.modifiers ?? []).reduce((n, k) => n | (CDP_MODIFIER[k] ?? 0), 0);
    const windowsVirtualKeyCode =
      VIRTUAL_KEY[params.key] ?? (params.key.length === 1 ? params.key.toUpperCase().charCodeAt(0) : 0);
    const p = { key: params.key, code: params.code, modifiers, windowsVirtualKeyCode };
    await this.cdp(wc, "Input.dispatchKeyEvent", {
      ...p,
      type: "keyDown",
      ...(params.key === "Enter" ? { text: "\r" } : {}),
    });
    await this.cdp(wc, "Input.dispatchKeyEvent", { ...p, type: "keyUp" });
    return { dispatched: true };
  }
  async action(wc: WebContents, op: Operation) {
    switch (op.method) {
      case DevMethod.Snapshot:
        return this.inspect(wc, { ...op.params, snapshot: true });
      case DevMethod.Click:
        return this.click(wc, op.params);
      case DevMethod.GraphDrag:
        return this.#graphDrag(wc, op.params);
      case DevMethod.Key:
        return this.key(wc, op.params);
      case DevMethod.Type:
        return this.#type(wc, op);
      case DevMethod.Select:
        return this.#select(wc, op);
      case DevMethod.Scroll:
        return this.#scroll(wc, op);
      default:
        throw new DevError(DevErrorCode.UnsupportedSurface);
    }
  }
  async #graphDrag(wc: WebContents, params: ActionOf<typeof DevMethod.GraphDrag>["params"]) {
    const selector = "[data-stage-graph] [data-zoom]";
    const point = await this.inspect(wc, { selector, pointY: GRAPH_DRAG_POINT_Y });
    const sample = async () => (await this.inspect(wc, { performanceOnly: true })).performance;
    const before = await sample();
    const send = (type: string, x: number, buttons: number) =>
      this.cdp(wc, "Input.dispatchMouseEvent", {
        type,
        x,
        y: point.y,
        button: "left",
        buttons,
        clickCount: 1,
      });
    await send("mousePressed", point.x, 1);
    let started: unknown;
    let midpoint: unknown;
    const begin = performance.now();
    try {
      for (let step = 1; step <= params.steps; step++) {
        await sleep(Math.max(0, begin + (step * params.durationMs) / params.steps - performance.now()));
        await send("mouseMoved", point.x + (params.distanceX * step) / params.steps, 1);
        if (step === 2) {
          await sleep(DRAG_START_SETTLE_MS);
          started = await sample();
        }
        if (step === Math.floor(params.steps / 2)) midpoint = await sample();
      }
      const beforeRelease = await sample();
      await send("mouseReleased", point.x + params.distanceX, 0);
      await sleep(DRAG_RELEASE_SETTLE_MS);
      return { before, started, midpoint, beforeRelease, after: await sample(), elapsedMs: performance.now() - begin };
    } finally {
      await send("mouseReleased", point.x + params.distanceX, 0);
    }
  }
  async #type(wc: WebContents, op: ActionOf<typeof DevMethod.Type>) {
    const info = await this.inspect(wc, op.params);
    if (!["INPUT", "TEXTAREA"].includes(info.tag))
      throw new DevError(DevErrorCode.InvalidSelector, "type requires an input/textarea");
    await this.click(wc, op.params);
    if (op.params.replace)
      await this.cdp(wc, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        modifiers: CDP_MODIFIER.Meta,
        commands: ["selectAll"],
      });
    await this.cdp(wc, "Input.insertText", { text: op.params.text });
    return { dispatched: true };
  }
  async #select(wc: WebContents, op: ActionOf<typeof DevMethod.Select>) {
    const info = await this.inspect(wc, op.params);
    if (info.tag !== "SELECT") throw new DevError(DevErrorCode.InvalidSelector, "select requires a native select");
    const index = info.options.findIndex(
      (o: { value: string; disabled: boolean }) => o.value === op.params.value && !o.disabled,
    );
    if (index < 0) throw new DevError(DevErrorCode.MissingPrerequisite, "select value is unavailable");
    // Route DOM keyboard focus without opening macOS's native popup; real keys change selection.
    await this.inspect(wc, { ...op.params, focus: true });
    const key = index < info.index ? "ArrowUp" : "ArrowDown";
    for (let i = 0; i < Math.abs(index - info.index); i++) await this.key(wc, { key, code: key });
    const current = await this.inspect(wc, op.params);
    if (current.value !== op.params.value)
      throw new DevError(DevErrorCode.UnsupportedSurface, "Chromium keyboard selection did not reach requested value");
    return { dispatched: true, value: current.value };
  }
  async #scroll(wc: WebContents, op: ActionOf<typeof DevMethod.Scroll>) {
    const point = op.params.selector ? await this.inspect(wc, op.params) : DEFAULT_SCROLL_POINT;
    await this.cdp(wc, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX: op.params.deltaX,
      deltaY: op.params.deltaY,
    });
    return { dispatched: true };
  }
}
