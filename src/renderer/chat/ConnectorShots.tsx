/**
 * The pictures a connector step answered with, read from the game's captures folder: up to three
 * play views under a work group's heading (88×55, the build card's size), and the others small in
 * their own row. A picture opens beside the chat. Each is read once it comes near the view and
 * kept for a while, so a transcript that remounts its rows does not ask main again.
 */
import { type JSX, useContext, useEffect, useRef, useState } from "react";
import { ChatFilesScope } from "../chat-files.ts";
import { openBeside } from "../open-beside.ts";
import { useAsyncEffect } from "../use-async-effect.ts";
import { CHAT_SHOT_WORDS } from "../words.ts";

/** How many pictures stay in memory before the oldest is forgotten. */
const SHOT_CACHE_MAX = 24;
/** How far outside the view a picture starts loading. */
const LOAD_MARGIN = "150px";
const shots = new Map<string, string>();

function remember(key: string, src: string): void {
  shots.set(key, src);
  const oldest = shots.size > SHOT_CACHE_MAX ? shots.keys().next().value : undefined;
  if (oldest !== undefined) shots.delete(oldest);
}

/** A capture's picture, read from the chat's game once its element nears the view. */
function useShot(path: string) {
  const threadId = useContext(ChatFilesScope);
  const key = `${threadId}\n${path}`;
  const host = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(false);
  const [src, setSrc] = useState<string | null>(() => shots.get(key) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNear(true);
        observer.disconnect();
      },
      { rootMargin: LOAD_MARGIN },
    );
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useAsyncEffect(
    (alive) => {
      const cached = shots.get(key);
      if (cached) setSrc(cached);
      if (cached || !near || !threadId) return;
      void window.studio.readGameFile(threadId, path).then(
        (file) => {
          if (!alive()) return;
          if (file.kind === "image" && file.src) {
            remember(key, file.src);
            setSrc(file.src);
          } else setFailed(true);
        },
        () => {
          if (alive()) setFailed(true);
        },
      );
      return undefined;
    },
    [key, near, threadId, path],
  );
  return { host, src, failed };
}

/** One picture as a button that opens it beside the chat. */
function Shot({ path, label, className }: { path: string; label: string; className: string }): JSX.Element {
  const { host, src, failed } = useShot(path);
  return (
    <button
      ref={host}
      type="button"
      data-chat-shot={path}
      aria-label={label}
      title={CHAT_SHOT_WORDS.opensBeside}
      onClick={() => openBeside({ kind: "file", path })}
      className={`chat-shot ${failed ? "hatch" : "bg-inset"} ${className}`}
    >
      {src && <img src={src} alt="" draggable={false} className="h-full w-full object-cover" />}
    </button>
  );
}

/** A work group's play views, under its heading. */
export function ShotStrip({ paths }: { paths: readonly string[] }): JSX.Element {
  return (
    <div data-work-shots className="mt-2 flex min-w-0 flex-wrap gap-2">
      {paths.map((path, index) => (
        <Shot
          key={path}
          path={path}
          label={CHAT_SHOT_WORDS.playView(index + 1)}
          className="h-[55px] w-[88px] rounded-[10px]"
        />
      ))}
    </div>
  );
}

/** A step's own pictures, small at the end of its row; nothing when it has none. */
export function RowShots({ paths }: { paths: readonly string[] }): JSX.Element | null {
  if (!paths.length) return null;
  return (
    <span className="relative z-[1] flex shrink-0 gap-1">
      {paths.map((path) => (
        <Shot key={path} path={path} label={CHAT_SHOT_WORDS.screenshot} className="h-6 w-[38px] rounded-[6px]" />
      ))}
    </span>
  );
}
