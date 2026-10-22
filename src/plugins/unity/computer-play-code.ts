/** Fixed host-owned C# for play operations Pipeline does not expose as commands. No agent code enters these snippets. */
export const PlayCode = {
  InputAvailable: `
#if ENABLE_INPUT_SYSTEM
return new { available = true };
#else
var installed = System.Type.GetType("UnityEngine.InputSystem.InputSystem, Unity.InputSystem") != null;
return new { available = false, reason = installed
  ? "Input System is installed but inactive. Set Project Settings > Player > Active Input Handling to Input System Package or Both. Legacy input injection is not supported."
  : "This project needs com.unity.inputsystem and Active Input Handling set to Input System Package or Both. Legacy input injection is not supported." };
#endif`,
  Background: "return UnityEngine.Application.runInBackground;",
  State: `var player = UnityEngine.GameObject.FindWithTag("Player");
var transform = player == null ? null : player.transform;
return new { gameSeconds = UnityEngine.Time.timeAsDouble, frame = UnityEngine.Time.frameCount,
  player = transform == null ? null : new { name = player.name,
    location = new { x = transform.position.x, y = transform.position.y, z = transform.position.z },
    rotation = new { x = transform.eulerAngles.x, y = transform.eulerAngles.y, z = transform.eulerAngles.z } } };`,
} as const;

/** Restores only the runtime background setting this session changed, without writing project settings. */
export const restoreBackgroundCode = (before: boolean): string =>
  `UnityEngine.Application.runInBackground = ${before}; return true;`;

/** Queues relative motion for the next player update; manually flushing would consume delta before the game reads it. */
export function mouseMotionCode(dx: number, dy: number, wheel: number): string {
  return `var mouse = UnityEngine.InputSystem.Mouse.current;
if (mouse == null) throw new System.InvalidOperationException("No mouse device is present.");
UnityEngine.InputSystem.InputSystem.QueueDeltaStateEvent(mouse.delta, new UnityEngine.Vector2(${dx}f, ${-dy}f));
UnityEngine.InputSystem.InputSystem.QueueDeltaStateEvent(mouse.scroll, new UnityEngine.Vector2(0f, ${wheel * 120}f));
return true;`;
}

/** Queues a whole combo in one event per device so modifiers compose and player code sees frame-edge presses. */
export function inputButtonsCode(keys: readonly string[], buttons: readonly string[], pressed: boolean): string {
  const events = [
    ...(keys.length
      ? [
          deviceEvent(
            "keyboard",
            "Keyboard",
            keys.map((key) => `[UnityEngine.InputSystem.Key.${key}]`),
            pressed,
          ),
        ]
      : []),
    ...(buttons.length
      ? [
          deviceEvent(
            "mouse",
            "Mouse",
            buttons.map((button) => `.${button}`),
            pressed,
          ),
        ]
      : []),
  ];
  return `${events.join("\n")}\nreturn true;`;
}

function deviceEvent(name: string, device: string, controls: string[], pressed: boolean): string {
  const writes = controls
    .map(
      (control) =>
        `UnityEngine.InputSystem.InputControlExtensions.WriteValueIntoEvent(${name}${control}, ${pressed ? "1f" : "0f"}, inputEvent);`,
    )
    .join("\n");
  return `var ${name} = UnityEngine.InputSystem.${device}.current;
if (${name} == null) throw new System.InvalidOperationException("No ${name} device is present.");
using (UnityEngine.InputSystem.LowLevel.StateEvent.From(${name}, out var inputEvent)) {
  ${writes}
  UnityEngine.InputSystem.InputSystem.QueueEvent(inputEvent);
}`;
}

/** A stopped game's fallback release flushes pending events when no player frame can consume them. */
export const FLUSH_INPUT_CODE = "UnityEngine.InputSystem.InputSystem.Update(); return true;";
