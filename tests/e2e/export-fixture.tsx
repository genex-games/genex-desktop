/**
 * The chat header's export list for a Rust · wgpu game made for every destination, with the real
 * header, export hook and phone export sheet over a fake host API: the list offers what this build
 * exports (the browser folder and the phones; the Rust Mac app and desktop archives are not landed),
 * the phones are labelled untested on real devices, a phone opens the sheet, and its export answers
 * a receipt that says so, which the notice repeats. The host is a Mac or the Linux Studio
 * (`window.test.platform`). `run-export-ui.mjs` drives it.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { initializeAppearance, updateAppearance } from "../../src/renderer/appearance/store.ts";
import { useChatExport } from "../../src/renderer/chat/use-chat-export.ts";
import { ChatHeader } from "../../src/renderer/panels/ChatHeader.tsx";
import { ExportSheet } from "../../src/renderer/panels/ExportSheet.tsx";
import { SessionStatus } from "../../src/renderer/state/session.ts";
import { studio } from "../../src/renderer/state/studio.ts";
import type { GameProject } from "../../src/renderer/types.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { gpuQualificationOf } from "../../src/shared/game-export-contract.ts";
import { BuildTarget, type ExportResult, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { factsOfEngine } from "../../src/shared/project-facts.ts";

const NAME = "pond";
const POND: GameProject = {
  name: NAME,
  dir: `/Users/fixture/AI Games/${NAME}`,
  title: "Pond",
  createdAt: "2026-10-07T00:00:00.000Z",
  pathLabel: `~/AI Games/${NAME}`,
  library: true,
  facts: factsOfEngine(GameEngine.Web),
  shape: {
    entry: "index.html",
    main: "src/main",
    build: null,
    install: null,
    own: false,
    kind: ProjectKind.RustWgpu,
    serve: ".",
  },
  built: false,
  destinations: {
    stack: GameStack.RustWgpu,
    targets: [
      BuildTarget.Web,
      BuildTarget.Mac,
      BuildTarget.Windows,
      BuildTarget.Linux,
      BuildTarget.Ios,
      BuildTarget.Android,
    ],
  },
};

/** The artifact each destination's export makes. */
const ARTIFACT: Partial<Record<BuildTarget, string>> = {
  [BuildTarget.Mac]: "Pond.app",
  [BuildTarget.Windows]: "Pond-windows-x64.zip",
  [BuildTarget.Linux]: "pond-linux-x64.tar.gz",
  [BuildTarget.Ios]: "Pond.app",
  [BuildTarget.Android]: "Pond-debug.apk",
};

/** The receipt the core answers: the destination's artifact and the Rust stack's GPU qualification. */
async function exported(project: string, options?: { destination?: BuildTarget }): Promise<ExportResult> {
  const destination = options?.destination ?? BuildTarget.Web;
  const dir = `/Users/fixture/AI Games/.exports/${project}.${destination}`;
  const file = ARTIFACT[destination];
  const gpuQualification = gpuQualificationOf(GameStack.RustWgpu, destination);
  return {
    dir,
    files: 3,
    included: [],
    excluded: [],
    ...(file ? { destination, artifact: `${dir}/${file}` } : {}),
    ...(gpuQualification ? { gpuQualification } : {}),
  };
}

document.documentElement.dataset.platform = StudioPlatform.Mac;
const fake = fakeStudioApi({ exportGame: exported });
window.studio = fake.api;
const app = studio();
app.session.setState({ status: SessionStatus.Ready, welcoming: false });
app.library.setState({ games: [POND] });
initializeAppearance();

let remount: () => void = () => {};
Object.assign(window, {
  test: {
    calls: () => fake.calls.map((call) => ({ method: call.method, args: JSON.parse(JSON.stringify(call.args)) })),
    theme: (mode: "light" | "dark") => updateAppearance((previous) => ({ ...previous, mode })),
    /** The host the header reads its destinations for; the header mounts again to read it. */
    platform: (platform: StudioPlatform) => {
      document.documentElement.dataset.platform = platform;
      remount();
    },
  },
});

function Fixture() {
  const [mount, setMount] = useState(0);
  const [notices, setNotices] = useState<string[]>([]);
  remount = () => setMount((count) => count + 1);
  const chatExport = useChatExport((text) => setNotices((said) => [...said, text]));
  return (
    <div className="flex h-screen flex-col bg-canvas text-foreground">
      <ChatHeader
        key={mount}
        chatTitle="Pond"
        isStudio={false}
        isDraft={false}
        project={NAME}
        contextUsage={null}
        compacting={false}
        onCompact={() => {}}
        onRename={() => {}}
        onExport={chatExport.exportGame(NAME)}
        exporting={chatExport.exporting}
        sidebarHidden={false}
        onToggleSidebar={() => {}}
      />
      {chatExport.sheet && (
        <ExportSheet
          project={chatExport.sheet.project}
          destination={chatExport.sheet.destination}
          onClose={chatExport.closeSheet}
          onExported={chatExport.sheetExported}
        />
      )}
      <ul className="p-4 text-sm">
        {notices.map((notice) => (
          <li key={notice} data-export-notice>
            {notice}
          </li>
        ))}
      </ul>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
