/**
 * THE PHONE PASS: the same URL in a separate 390x844 @3x touch context. It asks one question: does a
 * canvas still draw at phone dimensions? Not layout, not touch controls. A screenshot that never came
 * back says nothing about the game, and a page that answered 5xx says the ORIGIN failed (a serving
 * incident must not read as "no canvas at phone size"), so both are `unknown`; only a canvas
 * captured FLAT, or no canvas at all, is a fail. `l3.phone_viewport` is an L3 row: it flags for a
 * human and never gates.
 *
 * A driver with no phone context (`openPhone` absent) records that the pass could not run.
 */
import fs from "node:fs";
import path from "node:path";
import { SECOND_MS } from "../../../../src/shared/duration.ts";
import { CheckResult, ProbeRow } from "../../vocabulary.ts";
import { CanvasState, type PhonePage, type ProbeBrowser } from "../driver.ts";
import { type DegeneracyReport, degeneracyReport, downsampleFrame } from "../frames.ts";
import { decodePng } from "../png.ts";
import type { Check } from "../types.ts";
import { ANALYSIS_HEIGHT, ANALYSIS_WIDTH } from "./directions.ts";
import { machineRow } from "./row.ts";

/** The phone the pass emulates. */
export const PHONE_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 3 } as const;
/** How long the pass waits for a canvas, polling at this interval. */
export const PHONE_CANVAS_WAIT_MS = 45 * SECOND_MS;
export const PHONE_POLL_MS = 1.5 * SECOND_MS;
/** How long the page runs after the tap before its canvas is captured. */
export const PHONE_SETTLE_MS = 8 * SECOND_MS;
/** Where the phone frame is written inside the evidence folder. */
export const PHONE_FRAME_FILE = "phone.png";
const HTTP_ERROR_MIN = 400;

export type { PhonePage } from "../driver.ts";

/** What the phone pass saw. */
export interface MobileObservation {
  ran: boolean;
  viewport: typeof PHONE_VIEWPORT;
  httpStatus: number | null;
  canvasFound: boolean;
  /** `null` when no canvas image came back. */
  degeneracy: DegeneracyReport | null;
  errors: number;
  frame: string | null;
  note: string;
}

/** A pass that did not run, and why. */
export function mobileNotRun(note: string): MobileObservation {
  return {
    ran: false,
    viewport: PHONE_VIEWPORT,
    httpStatus: null,
    canvasFound: false,
    degeneracy: null,
    errors: 0,
    frame: null,
    note,
  };
}

/**
 * Poll for a canvas with real patience: a slow boot is not "no canvas at phone size". A capture that
 * failed means a canvas exists that could not be read, which is not the same as no canvas.
 */
async function waitForCanvas(page: PhonePage, sleep: (ms: number) => Promise<void>): Promise<CanvasState> {
  const deadline = page.elapsedMs() + PHONE_CANVAS_WAIT_MS;
  let failed = false;
  while (page.elapsedMs() < deadline) {
    const shot = await page.captureCanvas();
    if (shot.state === CanvasState.Image) return CanvasState.Image;
    if (shot.state === CanvasState.Failed) failed = true;
    await sleep(PHONE_POLL_MS);
  }
  return failed ? CanvasState.Failed : CanvasState.NoCanvas;
}

/** The canvas's degeneracy and its bytes, or `null` when no image came back or it did not decode. */
async function captureDegeneracy(page: PhonePage): Promise<{ report: DegeneracyReport; png: Uint8Array } | null> {
  const shot = await page.captureCanvas();
  if (shot.state !== CanvasState.Image) return null;
  try {
    const raw = downsampleFrame(decodePng(shot.capture.png), ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
    return { report: degeneracyReport(raw), png: shot.capture.png };
  } catch {
    return null;
  }
}

/** Run the phone pass: open, wait for a canvas, tap the centre, let it run, capture. */
export async function mobilePhase(
  browser: ProbeBrowser,
  url: string,
  initScript: string,
  deps: { sleep: (ms: number) => Promise<void>; evidenceDir: string | null },
): Promise<MobileObservation> {
  if (!browser.openPhone) return mobileNotRun("the driver has no phone context, so the phone pass could not run");
  const page = await browser.openPhone(url, initScript);
  const canvas = await waitForCanvas(page, deps.sleep);
  const x = PHONE_VIEWPORT.width / 2;
  const y = PHONE_VIEWPORT.height / 2;
  if (page.tap) await page.tap(x, y);
  else await page.clickAt(x, y);
  await deps.sleep(PHONE_SETTLE_MS);
  const shot = canvas === CanvasState.NoCanvas ? null : await captureDegeneracy(page);
  let frame: string | null = null;
  if (shot && deps.evidenceDir) {
    frame = path.join(deps.evidenceDir, PHONE_FRAME_FILE);
    fs.writeFileSync(frame, shot.png);
  }
  const events = page.events();
  return {
    ran: true,
    viewport: PHONE_VIEWPORT,
    httpStatus: events.documentStatus,
    canvasFound: canvas !== CanvasState.NoCanvas,
    degeneracy: shot?.report ?? null,
    errors: events.pageErrors.length,
    frame,
    note: "Loaded in a separate 390x844 @3x touch context. This asks only whether a canvas still draws at phone dimensions; it does not judge layout or controls.",
  };
}

/** `l3.phone_viewport`. */
export function phoneViewportRow(m: MobileObservation): Check {
  const id = ProbeRow.L3PhoneViewport;
  if (!m.ran) return machineRow(id, CheckResult.Unknown, `The phone pass did not run: ${m.note}.`, m);
  if (m.httpStatus === null || m.httpStatus >= HTTP_ERROR_MIN) {
    const status = m.httpStatus ?? "no response";
    return machineRow(
      id,
      CheckResult.Unknown,
      `The phone pass could not load the page (HTTP ${status}), so nothing about the phone viewport was measured. An origin failure, not a game failure.`,
      m,
    );
  }
  if (!m.canvasFound) return machineRow(id, CheckResult.Fail, "No canvas appeared at phone dimensions.", m);
  if (!m.degeneracy) {
    return machineRow(
      id,
      CheckResult.Unknown,
      "A canvas exists at 390x844 but could not be captured, so whether it draws is unmeasured rather than failed.",
      m,
    );
  }
  if (m.degeneracy.degenerate) {
    return machineRow(
      id,
      CheckResult.Fail,
      `A canvas exists at 390x844 but did not draw: ${m.degeneracy.reasons.join("; ")}.`,
      m,
    );
  }
  return machineRow(
    id,
    CheckResult.Pass,
    `A canvas drew non-degenerate pixels at 390x844 @3x (${m.degeneracy.distinctColors} distinct colours). A render check only: it says nothing about touch controls or layout.`,
    m,
  );
}
