/**
 * A file dragged from the Finder onto the studio window, for `file.drag`: the control's own sample
 * file (never a path the request names) and the Chrome DevTools drag events each stage sends.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DevDragFile, DevDragStage } from "./protocol.ts";

/** CDP's drag operation mask for copy, what the Finder offers for a file. */
const DRAG_COPY = 1;
/** Where Leave takes the drag before cancelling it: off every drop target. */
const WINDOW_CORNER = { x: 0, y: 0 };

/** A 96 px picture: a red circle beside a blue square on white, small enough to read at a glance. */
const SAMPLE_PICTURE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAA80lEQVR42u3awRGDIBRFUZvRxtK2HViEWZsoEhQyH88dKjijC+UNq5INCAABAgQIECBAgAQIECBAgAABAiRAgAABAgQIECABAhQCaJ4mQBuOnPNEoEyaYqbxtdQ4LYAKaAqYQgJdpPmJKR7QjTo5RsGAbtc5NYoEVEknbRQGqKpOwghQF0ANdI6MAMUHaqazawQoOFBjnW8jQIAAAQIEqAzoLzofRp4grxggQIAAAfI1D8gfRb9c+wVyqwHIzaq7eesO+yALs6cszGwUrVzrZyfdbYAAAQIECBAgQIAECBAgQIAAAQIkQIAAAQIECBAgATrrDfcOJx6qfz94AAAAAElFTkSuQmCC";

/** Each sample: its file name, type and bytes. */
const SAMPLES: Record<DevDragFile, { name: string; mimeType: string; bytes: () => Buffer }> = {
  [DevDragFile.Picture]: {
    name: "sample-picture.png",
    mimeType: "image/png",
    bytes: () => Buffer.from(SAMPLE_PICTURE_PNG, "base64"),
  },
  [DevDragFile.Text]: {
    name: "sample-notes.txt",
    mimeType: "text/plain",
    bytes: () => Buffer.from("Notes about the game.\n"),
  },
};

/** Write the sample into the control's own folder and answer its path and type. */
export async function writeDragSample(dir: string, file: DevDragFile): Promise<{ file: string; mimeType: string }> {
  const sample = SAMPLES[file];
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, sample.name);
  await writeFile(target, sample.bytes());
  return { file: target, mimeType: sample.mimeType };
}

/**
 * The `Input.dispatchDragEvent` calls of a stage at a point: Over enters and hovers (the drop
 * feedback stays up to be captured), Drop enters, hovers and lets go, Leave moves the drag off to
 * the window's corner and cancels it there (a cancel alone tells the page nothing).
 */
export function fileDragEvents(
  stage: DevDragStage,
  point: { x: number; y: number },
  file: string,
): Array<Record<string, unknown>> {
  const data = { items: [], files: [file], dragOperationsMask: DRAG_COPY };
  const event = (type: string, at = point) => ({ type, x: at.x, y: at.y, data });
  if (stage === DevDragStage.Leave) return [event("dragOver", WINDOW_CORNER), event("dragCancel", WINDOW_CORNER)];
  const hover = [event("dragEnter"), event("dragOver")];
  return stage === DevDragStage.Drop ? [...hover, event("drop")] : hover;
}
