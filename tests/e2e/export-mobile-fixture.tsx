/**
 * The phone export sheet for a Rust · wgpu game, with the real sheet over a fake host API: the
 * iPhone's Simulator app and IPAs, Android's development APK and Play bundle, the native dialog's
 * picks answered by path, and an export that answers a receipt or, once asked, a refusal that
 * echoes a keystore password. `run-export-mobile-ui.mjs` drives it.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { initializeAppearance, updateAppearance } from "../../src/renderer/appearance/store.ts";
import { ExportSheet } from "../../src/renderer/panels/ExportSheet.tsx";
import { SessionStatus } from "../../src/renderer/state/session.ts";
import { studio } from "../../src/renderer/state/studio.ts";
import { EXPORT_WORDS } from "../../src/renderer/words.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { SigningReference } from "../../src/shared/game-export-contract.ts";
import { BuildTarget, type ExportResult } from "../../src/shared/game-project.ts";
import type { MobileBuildTarget } from "../../src/shared/toolchain.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const NAME = "pond";
/** Where the person keeps their signing files: the sheet shows only each file's name. */
const PICKED = {
  [SigningReference.Keystore]: "/Users/fixture/Private/keys/upload.jks",
  [SigningReference.ProvisioningProfile]: "/Users/fixture/Private/Profiles/Pond Development.mobileprovision",
  [SigningReference.PasswordFile]: "/Users/fixture/Private/keys/upload-password.txt",
} as const satisfies Record<SigningReference, string>;
/** The artifact each phone's export makes, by destination. */
const ARTIFACT = {
  [BuildTarget.Ios]: "Pond.app",
  [BuildTarget.Android]: "pond.apk",
} as const satisfies Record<MobileBuildTarget, string>;

/** The refusal the next export answers, or null for a receipt. */
let refuseNext: string | null = null;

/** The receipt the core answers for a phone export, or the refusal asked for. */
async function exported(project: string, options?: { destination?: BuildTarget }): Promise<ExportResult> {
  if (refuseNext !== null) {
    const said = refuseNext;
    refuseNext = null;
    throw new Error(said);
  }
  const destination = options?.destination === BuildTarget.Android ? BuildTarget.Android : BuildTarget.Ios;
  const dir = `/Users/fixture/AI Games/.exports/${project}.${destination}`;
  return { dir, files: 4, included: [], excluded: [], destination, artifact: `${dir}/${ARTIFACT[destination]}` };
}

document.documentElement.dataset.platform = StudioPlatform.Mac;
const fake = fakeStudioApi({
  exportGame: exported,
  exportSigningReference: async (kind) => PICKED[kind],
});
window.studio = fake.api;
const app = studio();
app.session.setState({ status: SessionStatus.Ready, welcoming: false });
initializeAppearance();

let open: (destination: MobileBuildTarget) => void = () => {};
Object.assign(window, {
  test: {
    calls: () => fake.calls.map((call) => ({ method: call.method, args: JSON.parse(JSON.stringify(call.args)) })),
    theme: (mode: "light" | "dark") => updateAppearance((previous) => ({ ...previous, mode })),
    /** Opens a fresh sheet for `destination`, the call record cleared. */
    open: (destination: MobileBuildTarget) => {
      fake.calls.length = 0;
      open(destination);
    },
    /** The next export is refused saying `said`. */
    refuseNext: (said: string) => {
      refuseNext = said;
    },
  },
});

function Fixture() {
  const [sheet, setSheet] = useState<{ destination: MobileBuildTarget; key: number }>({
    destination: BuildTarget.Ios,
    key: 0,
  });
  const [notice, setNotice] = useState<string | null>(null);
  open = (destination) => {
    setNotice(null);
    setSheet((current) => ({ destination, key: current.key + 1 }));
  };
  return (
    <div className="flex h-screen flex-col bg-canvas text-foreground">
      {notice && (
        <p data-export-notice className="p-4 text-sm">
          {notice}
        </p>
      )}
      <ExportSheet
        key={sheet.key}
        project={NAME}
        destination={sheet.destination}
        onClose={() => {}}
        onExported={(result) => setNotice(EXPORT_WORDS.mobile.exported(result.artifact?.split("/").at(-1) ?? ""))}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
