interface FrameHost {
  request(callback: (time: number) => void): number;
  cancel(id: number): void;
}

/** How early a capped frame may come and still count: a display's frames are not exactly even. */
const PACE_SLACK_MS = 2;
const MS_PER_SECOND = 1000;

/**
 * Suspend an unobserved preview's native frames without losing the game's queued callbacks, and
 * pace them to at most `setMaxFps` frames a second while a cap is set: a frame that comes too soon
 * is passed over and the callback waits for the next one. Every callback of one frame shares its
 * time, so a frame is let through, or held, whole.
 */
export function animationGate(host: FrameHost) {
  let visible = true;
  let next = 0;
  let minIntervalMs = 0;
  let frameAt = Number.NEGATIVE_INFINITY;
  const due = (time: number): boolean => {
    if (minIntervalMs === 0 || time === frameAt) return true;
    if (time - frameAt < minIntervalMs - PACE_SLACK_MS) return false;
    frameAt = time;
    return true;
  };
  const pending = new Map<number, { callback: (time: number) => void; native: number | null; generation: number }>();
  const arm = (id: number) => {
    const entry = pending.get(id);
    if (!entry || !visible || entry.native !== null) return;
    const generation = ++entry.generation;
    entry.native = host.request((time) => {
      if (!visible || pending.get(id) !== entry || generation !== entry.generation) return;
      if (!due(time)) {
        entry.native = null;
        arm(id);
        return;
      }
      pending.delete(id);
      entry.callback(time);
    });
  };
  return {
    request(callback: (time: number) => void): number {
      const id = ++next;
      pending.set(id, { callback, native: null, generation: 0 });
      arm(id);
      return id;
    },
    cancel(id: number): void {
      const entry = pending.get(id);
      if (entry?.native !== null && entry?.native !== undefined) host.cancel(entry.native);
      pending.delete(id);
    },
    /** At most this many frames a second; 0 (or less) lifts the cap. */
    setMaxFps(fps: number): void {
      minIntervalMs = fps > 0 ? MS_PER_SECOND / fps : 0;
    },
    setVisible(value: boolean): void {
      if (visible === value) return;
      visible = value;
      for (const [id, entry] of pending) {
        if (visible) arm(id);
        else {
          if (entry.native !== null) host.cancel(entry.native);
          entry.native = null;
        }
      }
    },
  };
}
