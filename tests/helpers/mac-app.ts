/**
 * A minimal Mac app made with macOS's own tools, for the native installer's tests: a bundle whose
 * program is `/usr/bin/true`, with an Info.plist, signed ad hoc as a published game is. Mac only.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { WINDOWED_KEY } from "../../src/main/play/native-unpack.ts";

const exec = promisify(execFile);

/** What a test app carries beyond its program and Info.plist. */
export interface MacAppOptions {
  unsigned?: boolean;
  intelOnly?: boolean;
  windowed?: boolean;
  /** Files under `Contents/Resources`, by name: sealed by the signature like any resource. */
  resources?: Readonly<Record<string, string | Uint8Array>>;
}

/** A minimal app: `/usr/bin/true` as its program (both processors), signed ad hoc unless `unsigned`. */
export async function makeApp(dir: string, title: string, options: MacAppOptions = {}): Promise<string> {
  const app = path.join(dir, `${title}.app`);
  await mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
  const program = path.join(app, "Contents", "MacOS", "Game");
  if (options.intelOnly) await exec("/usr/bin/lipo", ["/usr/bin/true", "-thin", "x86_64", "-output", program]);
  else await cp("/usr/bin/true", program);
  const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Game</string><key>CFBundleIdentifier</key><string>com.googlecode.iterm2</string><key>CFBundleName</key><string>${title}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`;
  await writeFile(path.join(app, "Contents", "Info.plist"), plist);
  for (const [name, data] of Object.entries(options.resources ?? {})) {
    await mkdir(path.join(app, "Contents", "Resources"), { recursive: true });
    await writeFile(path.join(app, "Contents", "Resources", name), data);
  }
  // What the agent does for a game that should open in a window: one key in its Info.plist.
  if (options.windowed)
    await exec("/usr/bin/plutil", ["-insert", WINDOWED_KEY, "-bool", "YES", path.join(app, "Contents", "Info.plist")]);
  if (options.unsigned) await exec("/usr/bin/codesign", ["--remove-signature", program]);
  else await exec("/usr/bin/codesign", ["--sign", "-", "--force", "--deep", app]);
  return app;
}
