/**
 * An install's refusals with their typed code (`PluginInstallProblem`) beside the same words: a
 * step that throws words of its own (a manifest check, a download, a backend's probe) is refused
 * again with the code, so the renderer tells the failure apart without reading it.
 */
import { CodedError, errorCode, errorMessage, isUserCancelled } from "../../shared/errors.ts";
import type { PluginInstallProblem } from "../../shared/plugins.ts";

/**
 * `error` as a refusal coded `code`, its words and name unchanged (a record that keeps `String(e)`
 * reads the same). One that already carries an app code, or the person's no, is answered as it is.
 */
export function asInstallProblem(code: PluginInstallProblem, error: unknown): unknown {
  if (errorCode(error) || isUserCancelled(error)) return error;
  const coded = new CodedError(code, errorMessage(error));
  if (error instanceof Error) coded.name = error.name;
  return coded;
}

/** What `step` answers, or its refusal coded `code` (`asInstallProblem`). */
export async function refusedAs<T>(code: PluginInstallProblem, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw asInstallProblem(code, error);
  }
}

/** What a synchronous `step` answers, or its refusal coded `code` (`asInstallProblem`). */
export function refusedNowAs<T>(code: PluginInstallProblem, step: () => T): T {
  try {
    return step();
  } catch (error) {
    throw asInstallProblem(code, error);
  }
}
