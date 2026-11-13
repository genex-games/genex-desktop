/**
 * The lanes thumbnails are made in (`panels/AssetThumbnail.tsx`): a lane runs a fixed number of
 * tasks at once and the rest in the order they were asked for, so a page of cards never starts
 * every read at the same moment.
 */

/** Run `task` in this lane; the promise is the task's own, kept or broken. */
export type Lane = <T>(task: () => Promise<T>) => Promise<T>;

/** A lane `width` tasks wide. A task that fails frees its place like one that ends. */
export function createLane(width: number): Lane {
  const waiting: Array<() => void> = [];
  let running = 0;
  const next = (): void => {
    if (running >= width) return;
    const start = waiting.shift();
    if (!start) return;
    running++;
    start();
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        // A task that throws before it returns a promise is a failure like any other.
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            running--;
            next();
          });
      });
      next();
    });
}
