/**
 * A small real Mac app that stands in for a game built in an engine: a fixture launch's native
 * games and the native launch tests install and run it. It draws a Metal view in the game's colour
 * with its name and how many times it was played (a save it keeps in its own Application Support),
 * plays silence through the audio engine, quits when its window closes or on SIGTERM, and with
 * `--probe` reports what its sandbox lets it do as JSON lines and exits. It is compiled here with
 * the Xcode toolchain and ad-hoc signed, never committed: a Mac developer's machine has Xcode.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MINUTE_MS } from "../../shared/duration.ts";

const exec = promisify(execFile);

/** How long one compile of the app may take. */
const COMPILE_TIMEOUT_MS = 3 * MINUTE_MS;
/** The oldest macOS the app runs on. */
const MIN_MACOS = "13.0";
/** The architectures a universal build carries, as the compiler names them. */
const UNIVERSAL = ["arm64", "x86_64"] as const;
/** The executable inside the bundle. */
const EXECUTABLE = "FixtureGame";

/** The app's whole program. */
const SOURCE = String.raw`import Cocoa
import MetalKit
import AVFoundation
import GameController

func report(_ step: String, _ fields: [String: Any] = [:]) {
  var row = fields
  row["step"] = step
  if let data = try? JSONSerialization.data(withJSONObject: row), let line = String(data: data, encoding: .utf8) {
    print(line)
    fflush(stdout)
  }
}

let info = Bundle.main.infoDictionary ?? [:]
let title = (info["CFBundleName"] as? String) ?? "Game"
let hue = CGFloat((info["GenexFixtureHue"] as? NSNumber)?.doubleValue ?? 210) / 360
let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(title)

/** One more play in the game's own save, or the error that kept it from being written. */
func countPlay() -> Result<Int, Error> {
  let file = support.appendingPathComponent("plays.txt")
  do {
    try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
    let plays = (Int((try? String(contentsOf: file, encoding: .utf8)) ?? "") ?? 0) + 1
    try Data(String(plays).utf8).write(to: file, options: [.atomic])
    return .success(plays)
  } catch {
    return .failure(error)
  }
}

func probe() {
  report("home", ["home": NSHomeDirectory(), "support": support.path])
  switch countPlay() {
  case .success(let plays): report("save", ["plays": plays])
  case .failure(let error): report("save", ["error": String(describing: error)])
  }
  let defaults = UserDefaults.standard
  let before = defaults.integer(forKey: "plays")
  defaults.set(before + 1, forKey: "plays")
  report("defaults", ["before": before, "synced": defaults.synchronize()])
  let executable = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("written.txt")
  let wroteInstall = executable.map { (try? Data("x".utf8).write(to: $0)) != nil } ?? false
  report("install", ["written": wroteInstall])
  let library = "/Users/" + NSUserName() + "/Library"
  report("user-library", ["listed": (try? FileManager.default.contentsOfDirectory(atPath: library)) != nil])
  let done = DispatchSemaphore(value: 0)
  var request = URLRequest(url: URL(string: "https://example.com/")!)
  request.timeoutInterval = 3
  URLSession.shared.dataTask(with: request) { _, response, error in
    report("network", ["reached": response != nil, "refused": error != nil])
    done.signal()
  }.resume()
  _ = done.wait(timeout: .now() + 5)
  report("done")
}

final class Painter: NSObject, MTKViewDelegate {
  let queue: MTLCommandQueue
  var frame = 0
  init(device: MTLDevice) { queue = device.makeCommandQueue()! }
  func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}
  func draw(in view: MTKView) {
    frame += 1
    let colour = NSColor(hue: hue, saturation: 0.55, brightness: 0.3 + 0.08 * CGFloat(sin(Double(frame) / 50)), alpha: 1)
      .usingColorSpace(.deviceRGB) ?? .black
    view.clearColor = MTLClearColor(red: Double(colour.redComponent), green: Double(colour.greenComponent), blue: Double(colour.blueComponent), alpha: 1)
    guard let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
      let buffer = queue.makeCommandBuffer(), let encoder = buffer.makeRenderCommandEncoder(descriptor: pass)
    else { return }
    encoder.endEncoding()
    buffer.present(drawable)
    buffer.commit()
  }
}

final class Game: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  var painter: Painter?
  let engine = AVAudioEngine()
  var stop: DispatchSourceSignal?

  func applicationDidFinishLaunching(_ note: Notification) {
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 540), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = title
    window.contentMinSize = NSSize(width: 640, height: 360)
    let content = window.contentView!
    if let device = MTLCreateSystemDefaultDevice() {
      let view = MTKView(frame: content.bounds, device: device)
      view.autoresizingMask = [.width, .height]
      let painter = Painter(device: device)
      self.painter = painter
      view.delegate = painter
      content.addSubview(view)
    }
    var lines = [title]
    switch countPlay() {
    case .success(let plays): lines.append(plays == 1 ? "First play" : "Played \(plays) times")
    case .failure: lines.append("Saves are off")
    }
    let label = NSTextField(labelWithString: lines.joined(separator: "\n"))
    label.font = .systemFont(ofSize: 34, weight: .semibold)
    label.textColor = .white
    label.alignment = .center
    label.maximumNumberOfLines = 2
    label.sizeToFit()
    label.frame.origin = NSPoint(x: (content.bounds.width - label.frame.width) / 2, y: (content.bounds.height - label.frame.height) / 2)
    label.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
    content.addSubview(label)
    window.setContentSize(NSSize(width: 960, height: 540))
    window.center()
    window.makeKeyAndOrderFront(nil)
    let silence = AVAudioSourceNode { _, _, _, buffers -> OSStatus in
      for buffer in UnsafeMutableAudioBufferListPointer(buffers) { memset(buffer.mData, 0, Int(buffer.mDataByteSize)) }
      return noErr
    }
    engine.attach(silence)
    engine.connect(silence, to: engine.mainMixerNode, format: engine.outputNode.inputFormat(forBus: 0))
    engine.mainMixerNode.outputVolume = 0
    let audio = (try? engine.start()) != nil
    signal(SIGTERM, SIG_IGN)
    let stop = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    stop.setEventHandler { NSApp.terminate(nil) }
    stop.resume()
    self.stop = stop
    report("ready", ["audio": audio, "controllers": GCController.controllers().count])
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}

if CommandLine.arguments.contains("--probe") {
  probe()
  exit(0)
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let game = Game()
app.delegate = game
app.run()
`;

/** What the app is built as. */
export interface FixtureAppSpec {
  /** Its name: the bundle's, the window's and the save folder's. */
  title: string;
  bundleId: string;
  /** The hue it draws in, 0–360. */
  hue: number;
  version: string;
  /** `universal` carries both processors; otherwise one. */
  arch: "arm64" | "x86_64" | "universal";
  /** Data to carry in `Contents/Resources`, signed with the rest (a game's levels, to give it a size). */
  data?: { name: string; bytes: Uint8Array };
}

/** The Info.plist of the app `spec` describes. */
function infoPlist(spec: FixtureAppSpec): string {
  const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const entries: Array<[string, string]> = [
    ["CFBundleExecutable", `<string>${EXECUTABLE}</string>`],
    ["CFBundleIdentifier", `<string>${xml(spec.bundleId)}</string>`],
    ["CFBundleName", `<string>${xml(spec.title)}</string>`],
    ["CFBundlePackageType", "<string>APPL</string>"],
    ["CFBundleShortVersionString", `<string>${xml(spec.version)}</string>`],
    ["CFBundleVersion", `<string>${xml(spec.version)}</string>`],
    ["LSMinimumSystemVersion", `<string>${MIN_MACOS}</string>`],
    ["NSHighResolutionCapable", "<true/>"],
    ["GenexFixtureHue", `<integer>${Math.round(spec.hue) % 360}</integer>`],
  ];
  const body = entries.map(([key, value]) => `<key>${key}</key>${value}`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${body}
</dict></plist>
`;
}

/** Whether this machine can build the app: a Mac with the Xcode toolchain's Swift compiler. */
export async function canBuildFixtureApp(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  return exec("/usr/bin/xcrun", ["--find", "swiftc"], { timeout: COMPILE_TIMEOUT_MS }).then(
    () => true,
    () => false,
  );
}

/** Compile the program for `arch` into `output`. */
async function compile(source: string, arch: string, output: string): Promise<void> {
  await exec("/usr/bin/xcrun", ["swiftc", "-O", "-target", `${arch}-apple-macos${MIN_MACOS}`, "-o", output, source], {
    timeout: COMPILE_TIMEOUT_MS,
  });
}

/** The compiled executable for `arch` (`universal`: both, joined), kept in `cache` by the program's hash. */
async function executable(cache: string, arch: FixtureAppSpec["arch"]): Promise<string> {
  const hash = createHash("sha256").update(SOURCE).digest("hex").slice(0, 16);
  const built = path.join(cache, `${hash}-${arch}`);
  if (existsSync(built)) return built;
  await mkdir(cache, { recursive: true });
  const work = await mkdtemp(path.join(cache, ".build-"));
  try {
    const source = path.join(work, "main.swift");
    await writeFile(source, SOURCE);
    const arches = arch === "universal" ? [...UNIVERSAL] : [arch];
    const parts = arches.map((one) => path.join(work, `${EXECUTABLE}-${one}`));
    for (const [at, one] of arches.entries()) await compile(source, one, parts[at] ?? "");
    const joined = path.join(work, EXECUTABLE);
    if (parts.length === 1) await rename(parts[0] ?? "", joined);
    else await exec("/usr/bin/lipo", ["-create", ...parts, "-output", joined], { timeout: COMPILE_TIMEOUT_MS });
    await rename(joined, built);
    return built;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Build the app `spec` describes as `<dir>/<title>.app`, ad-hoc signed, and answer its path. The
 * compiled program is kept in `cache`, so a second app costs only its bundle and signature.
 */
export async function buildFixtureApp(spec: FixtureAppSpec, dir: string, cache: string): Promise<string> {
  const program = await executable(cache, spec.arch);
  const app = path.join(dir, `${spec.title}.app`);
  await rm(app, { recursive: true, force: true });
  await mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
  await cp(program, path.join(app, "Contents", "MacOS", EXECUTABLE));
  await writeFile(path.join(app, "Contents", "Info.plist"), infoPlist(spec));
  if (spec.data) {
    await mkdir(path.join(app, "Contents", "Resources"), { recursive: true });
    await writeFile(path.join(app, "Contents", "Resources", path.basename(spec.data.name)), spec.data.bytes);
  }
  await exec("/usr/bin/codesign", ["--sign", "-", "--force", "--deep", app], { timeout: COMPILE_TIMEOUT_MS });
  return app;
}
