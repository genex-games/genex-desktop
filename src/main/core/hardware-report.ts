/** This Mac's hardware and the local models that fit it, as the harness and the Settings page both read it. */
import { OllamaClient } from "../../substrate/engines/ollama.ts";
import { detectHardware, recommendModels } from "../../substrate/hardware.ts";

export async function hardwareReport() {
  const [hardware, ollamaVersion] = await Promise.all([detectHardware(), new OllamaClient().version()]);
  return { hardware, recommendation: await recommendModels(hardware, ollamaVersion) };
}
