/** Pinned upstream releases: weights Apache-2.0, runtime MIT. Never resolve latest at install time. */
export const BONSAI_REVISION = "6ed5e12bf84b7a63069882c91dd9e9218647d17b";
export const BONSAI_RUNTIME = "prism-b10709-9a9394a";
const MESSAGE = {
  UnknownModel: (id: string) => `Unknown Bonsai model: ${id}`,
} as const;
export interface DownloadFile {
  name: string;
  url: string;
  bytes: number;
  sha256: string;
}
const weight = (name: string, bytes: number, sha256: string): DownloadFile => ({
  name,
  bytes,
  sha256,
  url: `https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/${BONSAI_REVISION}/${name}`,
});
export const BONSAI_MODELS = [
  {
    id: "bonsai-2:27b-pq2_0",
    label: "Bonsai 2 27B · PQ2_0",
    file: weight(
      "Ternary-Bonsai-2-27B-PQ2_0.gguf",
      7206168928,
      "3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1",
    ),
  },
  {
    id: "bonsai-2:27b-ptq1_0",
    label: "Bonsai 2 27B · PTQ1_0",
    file: weight(
      "Ternary-Bonsai-2-27B-PTQ1_0.gguf",
      5946648928,
      "53107f530aa52eb00912263ab1ee29bd199261c87cd7b4ad4ca1318c1fe33ee3",
    ),
  },
] as const;
export const BONSAI_PROJECTOR = weight(
  "Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf",
  629246976,
  "6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903",
);
export const BONSAI_BINARY: DownloadFile = {
  name: `llama-${BONSAI_RUNTIME}-bin-macos-arm64.tar.gz`,
  bytes: 11500187,
  sha256: "f9cdf245fb7b832f1996dd776b321d4ae1f23b6d88c380100f636742c3a980ff",
  url: `https://github.com/PrismML-Eng/llama.cpp/releases/download/${BONSAI_RUNTIME}/llama-${BONSAI_RUNTIME}-bin-macos-arm64.tar.gz`,
};
/** Every Bonsai id starts with this: such an id is Bonsai's to answer for, never Ollama's. */
const BONSAI_ID_PREFIX = "bonsai-2:";
/** Whether `id` names a Bonsai model, pinned or not. */
export const isBonsaiModelId = (id: string): boolean => id.startsWith(BONSAI_ID_PREFIX);
/** The pinned model with this id; an unknown id is refused. */
export function bonsaiModel(id: string) {
  const model = BONSAI_MODELS.find((m) => m.id === id);
  if (!model) throw new Error(MESSAGE.UnknownModel(id));
  return model;
}
export const BONSAI_NOTICES: DownloadFile[] = [
  weight("LICENSE", 10174, "69849221bfb90053de2134ef5e6d540287b4b98062326492f1f96f5da685524b"),
  weight("NOTICE.txt", 411, "de0e0c48fb6f691a31e74f338e3ccf93f9ecdfe2866ab769c4bf8b79a7636a30"),
];
