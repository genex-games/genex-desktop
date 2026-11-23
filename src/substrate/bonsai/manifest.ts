/**
 * The local models Studio downloads and runs itself on a llama.cpp server: their pinned files,
 * and the pinned llama.cpp build each runs on per kind of machine. Never resolve latest at install
 * time. Bonsai 2 runs on PrismML's fork on Apple Silicon (weights Apache-2.0, runtime MIT);
 * Inkling 2 Mini runs on mainline llama.cpp on Windows and Linux PCs (weights Apache-2.0, runtime MIT).
 */
import { StudioPlatform } from "../../shared/boot.ts";

export const BONSAI_REVISION = "6ed5e12bf84b7a63069882c91dd9e9218647d17b";
export const BONSAI_RUNTIME = "prism-b10709-9a9394a";
/** Mainline llama.cpp: Inkling 2 Mini needs b12600 or newer (ggml-org/llama.cpp #32704). */
export const LLAMA_CPP_RELEASE = "b12631";
/** AtomicChat's Inkling 2 Mini GGUF: requantized from BF16 to plain k-quants, so no NVFP4 tensor needs a GPU that runs it. */
export const INKLING_REVISION = "4f0c56af7e0c242e620be6394983d245b8c3fd27";
const MESSAGE = {
  UnknownModel: (id: string) => `Unknown local model: ${id}`,
} as const;
export interface DownloadFile {
  name: string;
  url: string;
  bytes: number;
  sha256: string;
}
/** The kind of model a managed model is: it picks the server's flags, sampling and reasoning control. */
export const ManagedFamily = {
  Bonsai: "bonsai",
  Inkling: "inkling",
} as const;
export type ManagedFamily = (typeof ManagedFamily)[keyof typeof ManagedFamily];

/** One pinned llama.cpp build: its archives unpack together into a folder named after it. */
export interface RuntimeBuild {
  name: string;
  archives: readonly DownloadFile[];
}
/** What a machine is, for choosing the build it runs. */
export interface RuntimeHost {
  platform: string;
  arch: string;
  appleSilicon: boolean;
}
/** A model Studio downloads and runs on its own llama.cpp server. */
export interface ManagedModel {
  id: string;
  label: string;
  family: ManagedFamily;
  file: DownloadFile;
  /** The vision projector the server loads beside the weights. */
  projector: DownloadFile;
  /** License files kept beside the weights. */
  notices: readonly DownloadFile[];
  /** The build this model runs on on `host`, or null when that machine cannot run it. */
  runtimeFor: (host: RuntimeHost) => RuntimeBuild | null;
}

const bonsaiFile = (name: string, bytes: number, sha256: string): DownloadFile => ({
  name,
  bytes,
  sha256,
  url: `https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/${BONSAI_REVISION}/${name}`,
});
const inklingFile = (name: string, bytes: number, sha256: string): DownloadFile => ({
  name,
  bytes,
  sha256,
  url: `https://huggingface.co/AtomicChat/Inkling-2-Mini-GGUF/resolve/${INKLING_REVISION}/${name}`,
});
const llamaCppArchive = (name: string, bytes: number, sha256: string): DownloadFile => ({
  name,
  bytes,
  sha256,
  url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_RELEASE}/${name}`,
});

export const BONSAI_BINARY: DownloadFile = {
  name: `llama-${BONSAI_RUNTIME}-bin-macos-arm64.tar.gz`,
  bytes: 11500187,
  sha256: "f9cdf245fb7b832f1996dd776b321d4ae1f23b6d88c380100f636742c3a980ff",
  url: `https://github.com/PrismML-Eng/llama.cpp/releases/download/${BONSAI_RUNTIME}/llama-${BONSAI_RUNTIME}-bin-macos-arm64.tar.gz`,
};
/** PrismML's fork on Apple Silicon: the only build that reads Bonsai's PQ2_0 and PTQ1_0 packing. */
export const PRISM_MAC_BUILD: RuntimeBuild = { name: BONSAI_RUNTIME, archives: [BONSAI_BINARY] };
/**
 * Mainline llama.cpp's Vulkan builds: one archive per platform that runs on NVIDIA, AMD and Intel
 * graphics alike, with the driver the PC already has. llama-server's `--fit` (on by default) keeps
 * on the card what fits and the rest of the experts in RAM.
 */
export const LLAMA_CPP_WINDOWS_BUILD: RuntimeBuild = {
  name: `llama-${LLAMA_CPP_RELEASE}-win-vulkan-x64`,
  archives: [
    llamaCppArchive(
      `llama-${LLAMA_CPP_RELEASE}-bin-win-vulkan-x64.zip`,
      38879485,
      "f54121061f29cfcd59a3e3ca17870c41957f4a226146185ab6c5297258203fc4",
    ),
  ],
};
export const LLAMA_CPP_LINUX_BUILD: RuntimeBuild = {
  name: `llama-${LLAMA_CPP_RELEASE}-ubuntu-vulkan-x64`,
  archives: [
    llamaCppArchive(
      `llama-${LLAMA_CPP_RELEASE}-bin-ubuntu-vulkan-x64.tar.gz`,
      36909311,
      "ddaa5ca038cafffd4a858488a2ca6e2b703077e4cfa55b4d3f96f8a5590afa51",
    ),
  ],
};
/** Every pinned build, so a delete can tell which of their files no model needs any more. */
export const RUNTIME_BUILDS: readonly RuntimeBuild[] = [
  PRISM_MAC_BUILD,
  LLAMA_CPP_WINDOWS_BUILD,
  LLAMA_CPP_LINUX_BUILD,
];

const onAppleSilicon = (host: RuntimeHost): RuntimeBuild | null => (host.appleSilicon ? PRISM_MAC_BUILD : null);
/** An x64 Windows or Linux PC; Macs run Inkling through Ollama's MLX build instead. */
function onPc(host: RuntimeHost): RuntimeBuild | null {
  if (host.arch !== "x64") return null;
  if (host.platform === StudioPlatform.Windows) return LLAMA_CPP_WINDOWS_BUILD;
  if (host.platform === StudioPlatform.Linux) return LLAMA_CPP_LINUX_BUILD;
  return null;
}

export const BONSAI_PROJECTOR = bonsaiFile(
  "Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf",
  629246976,
  "6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903",
);
export const BONSAI_NOTICES: DownloadFile[] = [
  bonsaiFile("LICENSE", 10174, "69849221bfb90053de2134ef5e6d540287b4b98062326492f1f96f5da685524b"),
  bonsaiFile("NOTICE.txt", 411, "de0e0c48fb6f691a31e74f338e3ccf93f9ecdfe2866ab769c4bf8b79a7636a30"),
];
const bonsai = (id: string, label: string, file: DownloadFile): ManagedModel => ({
  id,
  label,
  family: ManagedFamily.Bonsai,
  file,
  projector: BONSAI_PROJECTOR,
  notices: BONSAI_NOTICES,
  runtimeFor: onAppleSilicon,
});
export const BONSAI_MODELS = [
  bonsai(
    "bonsai-2:27b-pq2_0",
    "Bonsai 2 27B",
    bonsaiFile(
      "Ternary-Bonsai-2-27B-PQ2_0.gguf",
      7206168928,
      "3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1",
    ),
  ),
  bonsai(
    "bonsai-2:27b-ptq1_0",
    "Bonsai 2 27B Lite",
    bonsaiFile(
      "Ternary-Bonsai-2-27B-PTQ1_0.gguf",
      5946648928,
      "53107f530aa52eb00912263ab1ee29bd199261c87cd7b4ad4ca1318c1fe33ee3",
    ),
  ),
] as const;

/** Inkling's projector: the Q8_0 one its quantizer checked against these weights. */
export const INKLING_PROJECTOR = inklingFile(
  "mmproj-Inkling-2-Mini-Q8_0.gguf",
  345911008,
  "f0c269cdbffdeb2d8bdabd9d859d1ea0874f58e7783913d7ce75028eb9425d97",
);
export const INKLING_NOTICES: DownloadFile[] = [];
/** AD-Q4_K: 96.3% of next tokens the same as the BF16 original, the best quality under 20 GB. */
export const INKLING_MODELS = [
  {
    id: "inkling-2-mini:gguf-q4_k",
    label: "Inkling 2 Mini",
    family: ManagedFamily.Inkling,
    file: inklingFile(
      "Inkling-2-Mini-AD-Q4_K.gguf",
      16525559776,
      "2bfc233e10925297cc79dffce5d9be4f2a2b43e499ea6a1bf03b9242867dce9e",
    ),
    projector: INKLING_PROJECTOR,
    notices: INKLING_NOTICES,
    runtimeFor: onPc,
  },
] as const satisfies readonly ManagedModel[];

/** Every model Studio downloads and runs itself, in the order Settings lists them. */
export const MANAGED_MODELS: readonly ManagedModel[] = [...BONSAI_MODELS, ...INKLING_MODELS];

/** Every Bonsai id starts with this, pinned or not. */
const BONSAI_ID_PREFIX = "bonsai-2:";
/**
 * Whether `id` names a model Studio runs itself: such an id is the managed runtime's to answer
 * for, never Ollama's. Any Bonsai id counts, pinned or not.
 */
export const isManagedModelId = (id: string): boolean =>
  id.startsWith(BONSAI_ID_PREFIX) || MANAGED_MODELS.some((model) => model.id === id);
/** The pinned model with this id; an unknown id is refused. */
export function managedModel(id: string): ManagedModel {
  const model = MANAGED_MODELS.find((m) => m.id === id);
  if (!model) throw new Error(MESSAGE.UnknownModel(id));
  return model;
}
