/** This Mac's hardware and the local models that fit it, as the harness and the Settings page both read it. */
import { OllamaClient } from "../../substrate/engines/ollama.ts";
import { detectHardware, recommendModels } from "../../substrate/hardware.ts";

/** `ollamaHost` is the Ollama the app pulls from: its version decides which models it can pull. */
export async function hardwareReport(ollamaHost?: string) {
  const [hardware, ollamaVersion] = await Promise.all([detectHardware(), new OllamaClient(ollamaHost).version()]);
  return { hardware, recommendation: await recommendModels(hardware, ollamaVersion) };
}
