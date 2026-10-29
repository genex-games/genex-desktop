/**
 * Whether a new Unity game can be made on this computer, as `engine-status` answers before a new
 * game's first build: with a Unity 6 editor installed it can, and the engine question offers Unity
 * honestly; with only an older Unity, or none, the setup card gets one first. It only reads which
 * editors are installed.
 */
import { compareVersions, isUnity6, type UnityEditor } from "./editors.ts";

/** Where this computer's Unity stands for making a new game. Wire values: never rename one. */
export const EngineReadiness = { Ready: "ready", OlderOnly: "older-only", None: "none" } as const;
export type EngineReadiness = (typeof EngineReadiness)[keyof typeof EngineReadiness];

/** The tools that make a new Unity game and show the Unity setup card, as the host serves them to agents. */
const NEW_GAME = "unity__new-game";
const SHOW_STEPS = "unity__show-steps";

/**
 * What to do when the user picks Unity before Genex can make its project: never new-game, but the
 * setup card, where Genex installs Hub and Unity 6 for them and they only sign in.
 */
const TO_HUB = `If the user picks it, don't call ${NEW_GAME}, which would refuse: call ${SHOW_STEPS}, which puts the Unity setup card in the chat (Genex installs Unity Hub and Unity 6 for them; they only sign in), say so in one line and end your reply. The chat tells you when Unity is ready.`;

const NOTE = {
  [EngineReadiness.Ready]: (version: string) =>
    `Offer "Unity: plays in the Unity editor on this computer"; when the answer (or the request) is Unity, call ${NEW_GAME}: it makes the game's empty Unity project in this folder as unity/ and opens it in Unity ${version}; then build the game there through the unity-editor tools, never as a web page.`,
  [EngineReadiness.OlderOnly]: (version: string) =>
    `This computer has Unity ${version}, older than the Unity 6 Genex makes Unity games with, so offer it as "Unity 6" with the description "Needs Unity 6 installed beside your ${version}". ${TO_HUB}`,
  [EngineReadiness.None]: () =>
    `Unity isn't installed on this computer yet, so offer it as "Unity" with the description "Plays in the Unity editor on this computer; needs Unity 6 installed first". ${TO_HUB}`,
} as const;

/** The newest installed editor a new game can be made with: Unity 6 or later. */
export const newestUnity6 = (editors: readonly UnityEditor[]): UnityEditor | undefined =>
  [...editors].sort((a, b) => compareVersions(a.version, b.version)).find((editor) => isUnity6(editor.version));

/** `engine-status`'s answer: the readiness, the Unity it speaks of, whether a new game can be made, and the card's words. */
export function readinessOf(editors: readonly UnityEditor[]) {
  const creating = newestUnity6(editors);
  if (creating) {
    const { version } = creating;
    return { engine: EngineReadiness.Ready, version, ready: true, note: NOTE[EngineReadiness.Ready](version) };
  }
  const older = [...editors].sort((a, b) => compareVersions(a.version, b.version))[0];
  if (older) {
    const { version } = older;
    return { engine: EngineReadiness.OlderOnly, version, ready: false, note: NOTE[EngineReadiness.OlderOnly](version) };
  }
  return { engine: EngineReadiness.None, version: null, ready: false, note: NOTE[EngineReadiness.None]() };
}
