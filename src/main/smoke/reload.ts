interface ReloadableContents {
  reload(): void;
  once(event: "did-finish-load", listener: () => void): unknown;
  removeListener(event: "did-finish-load", listener: () => void): unknown;
}

const MESSAGE = { timeout: "Smoke window reload timed out" } as const;

/** Reload the smoke window and wait for its new document, within the caller's deadline. */
export function reloadAndWait(contents: ReloadableContents, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      contents.removeListener("did-finish-load", loaded);
    };
    const loaded = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(MESSAGE.timeout));
    }, timeoutMs);
    contents.once("did-finish-load", loaded);
    try {
      contents.reload();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
