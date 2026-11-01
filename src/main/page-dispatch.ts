/**
 * Fire the same events the game would get from a human, even if Chromium will not focus us.
 *
 * The page half of the preview's input dispatch, as source text: preview.ts evaluates it inside
 * the game page with `executeJavaScript`, and the conformance suite evaluates the same string
 * against a fake page (tests/conformance/page-shim.test.ts).
 */
export const PAGE_DISPATCH = `(payload) => {
  const canvas = document.querySelector("canvas");
  const mouseTarget = canvas || document;
  /* Per EVENT TYPE, not per page: a hidden, unfocused window takes native keys and clicks and
     drops native mouse moves entirely, so one proven keydown used to silence every look this
     page would ever be sent. A type nobody has heard natively is still delivered here. */
  const heard = payload.native ? (window.__studioTrustedTypes || {}) : {};
  /* A real mouseup makes the browser raise a trusted click of its own, and a real keydown of a
     printable key a trusted keypress: a synthetic copy of a DERIVED event is a duplicate as soon
     as the event it derives from was heard. The proof is the source type, not the derived one,
     because the browser's click lands after this dispatch, not before it. */
  const provenBy = { click: "mouseup", dblclick: "mouseup", pointerdown: "mousedown", pointerup: "mouseup", pointermove: "mousemove", keypress: "keydown" };
  for (const ev of payload.dom || []) {
    /* The look is the exception, and it is not a copy: a hidden window's native mousemove, when it
       arrives at all, carries no pointer-lock movement, and the shim aims this one at the locked
       element. Hearing a trusted mousemove is not proof that this one is a duplicate. */
    if (ev.kind === "mouse" && ev.type === "mousemove" && window.__studioClock && typeof window.__studioClock.mouseMove === "function") {
      window.__studioClock.mouseMove(ev.movementX || 0, ev.movementY || 0, ev.x, ev.y);
      continue;
    }
    if (heard[ev.type] || heard[provenBy[ev.type]]) continue;
    if (ev.kind === "key") {
      const init = { key: ev.key, code: ev.code, keyCode: ev.keyCode, which: ev.keyCode, bubbles: true, cancelable: true };
      // Once: dispatched on the focused element (or the document) it bubbles to window too.
      (document.activeElement || document).dispatchEvent(new KeyboardEvent(ev.type, init));
    } else if (ev.kind === "mouse") {
      const init = {
        clientX: ev.x,
        clientY: ev.y,
        screenX: ev.x,
        screenY: ev.y,
        movementX: ev.movementX || 0,
        movementY: ev.movementY || 0,
        button: ev.button || 0,
        buttons: ev.buttons || 0,
        detail: ev.detail || 1,
        bubbles: true,
        cancelable: true,
        view: window,
      };
      mouseTarget.dispatchEvent(new MouseEvent(ev.type, init));
      const pointerType =
        ev.type === "mousedown" ? "pointerdown" : ev.type === "mouseup" ? "pointerup" : "pointermove";
      if (typeof PointerEvent === "function") {
        mouseTarget.dispatchEvent(new PointerEvent(pointerType, { ...init, pointerId: 1, pointerType: "mouse" }));
      }
    } else if (ev.kind === "wheel") {
      mouseTarget.dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: ev.dx || 0,
          deltaY: ev.dy || 0,
          clientX: ev.x,
          clientY: ev.y,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }
  return true;
}`;
