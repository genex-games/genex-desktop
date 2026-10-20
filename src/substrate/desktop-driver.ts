/**
 * What the studio needs from a desktop driver: the plug between the desktop target
 * (`main/core/desktop-target.ts`) and whatever moves the real pointer — cua-driver on this Mac or
 * PC (`cua-driver-client.ts`), or the computer server inside a VM. Coordinates are the driver's own
 * screen space (points on macOS); the target scales the model's screenshot pixels to it.
 *
 * Electron-free; tests satisfy it with a plain object.
 */
import path from "node:path";

/** An app on the desktop, as the driver names it. */
export interface DesktopApp {
  name: string;
  /**
   * The app's identifier, when the driver knows it: its bundle identifier on macOS, its
   * executable's name on Windows ({@link windowsAppId}).
   */
  bundleId: string | null;
  pid: number | null;
}

/**
 * A Windows app's identifier: its executable's file name in lower case (`robloxplayerbeta.exe`), as
 * Windows names a process and engine manifests name an app; Windows reads file names in any case.
 */
export function windowsAppId(exe: string): string {
  return path.win32.basename(exe).toLowerCase();
}

/** What has the keyboard: the app in front, and whether the focused field is a secure (password) one. */
export interface DesktopFocus {
  app: DesktopApp | null;
  secure: boolean;
}

/** A picture of the whole screen, and the screen's size in the driver's coordinate space. */
export interface DesktopShot {
  image: Buffer;
  mime: "image/png" | "image/jpeg";
  /** The picture's own pixels. */
  width: number;
  height: number;
  /** The screen in the driver's coordinates (points), which pointer actions use. */
  screen: { width: number; height: number };
}

/** A mouse button the driver presses. */
export type DesktopButton = "left" | "right" | "middle";

/** Keys as the driver spells them: `cmd`, `shift`, `return`, `a`. */
export type DesktopKeys = string[];

/** One element of a web page the model may act on: its ref, what it is, and what it is called. */
export interface WebElement {
  ref: string;
  role: string;
  name: string;
  /** Whether text can be typed into it. */
  editable: boolean;
  /** Whether it asks for a secret by what the page's DOM says of it (a password input), whatever its name. */
  secret: boolean;
}

/** A web page as read: where it is, its text with element refs, the elements, and its picture. */
export interface WebSnapshot {
  title: string;
  url: string;
  text: string;
  elements: WebElement[];
  shot: Buffer | null;
}

/**
 * Web pages by their structure, in a separate, clean browser the driver launches on first use and
 * closes with its connection — never the person's own browser or profile.
 */
export interface DesktopWeb {
  /** Whether the browser has been opened yet. */
  opened(): boolean;
  /** Open the browser if it is not yet, and say which app it runs as. */
  browser(): Promise<DesktopApp>;
  navigate(url: string): Promise<void>;
  snapshot(options: { query?: string; picture: boolean }): Promise<WebSnapshot>;
  /** Click an element; its role decides how (a link is followed, a control pressed). */
  click(ref: string, role: string): Promise<void>;
  type(ref: string, text: string, submit: boolean): Promise<void>;
}

/** The driver: one connection, held for a session and closed when it ends. */
export interface DesktopDriver {
  screenshot(): Promise<DesktopShot>;
  focus(): Promise<DesktopFocus>;
  /** The app under a screen point, so a click is checked against the app it lands in. */
  appAt?(x: number, y: number): Promise<DesktopApp | null>;
  move(x: number, y: number): Promise<void>;
  click(x: number, y: number, options: { button: DesktopButton; count: number; modifiers: DesktopKeys }): Promise<void>;
  mouse(x: number, y: number, options: { button: DesktopButton; down: boolean }): Promise<void>;
  drag(from: { x: number; y: number }, to: { x: number; y: number }, button: DesktopButton): Promise<void>;
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>;
  type(text: string): Promise<void>;
  /** A key or chord pressed and let go: `["cmd", "s"]`. */
  press(keys: DesktopKeys): Promise<void>;
  /** Keys held down or let go, where the driver can (a game on the desktop that reads held keys). */
  keys?(keys: DesktopKeys, down: boolean): Promise<void>;
  /** Web pages by their structure, where the driver can. */
  web?: DesktopWeb;
  /** The accessibility tree of the app in front, as the driver reports it. */
  accessibility(): Promise<unknown>;
  close(): Promise<void>;
}
