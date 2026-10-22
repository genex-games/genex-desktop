/** Whether this Mac has a network connection, as the browser knows it, and news of it coming back. */
import { useEffect, useRef, useSyncExternalStore } from "react";

const listen = (changed: () => void): (() => void) => {
  window.addEventListener("online", changed);
  window.addEventListener("offline", changed);
  return () => {
    window.removeEventListener("online", changed);
    window.removeEventListener("offline", changed);
  };
};

/**
 * Whether the Mac is online. False means no network at all; true can still mean a server that does
 * not answer, which reads as an ordinary failure.
 */
export const useOnline = (): boolean =>
  useSyncExternalStore(
    listen,
    () => navigator.onLine,
    () => true,
  );

/** Run `onBack` each time the connection comes back; the latest `onBack` runs, without listening again. */
export function useBackOnline(onBack: () => void): void {
  const latest = useRef(onBack);
  latest.current = onBack;
  useEffect(() => {
    const back = () => latest.current();
    window.addEventListener("online", back);
    return () => window.removeEventListener("online", back);
  }, []);
}
