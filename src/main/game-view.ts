/**
 * What a game page's renderer is given: the `webPreferences` of every game view `preview.ts`
 * creates. Kept free of Electron so the settings are tested as values, not read out of source.
 */

/**
 * Blink features no game page gets. On-device speech recognition asks the browser for
 * `media.mojom.OnDeviceSpeechRecognition`, a binder only Chrome registers: Electron treats the
 * request as a bad Mojo message and kills the whole renderer (reason 123). An agent's diagnostic
 * probe can do it — `SpeechRecognition.available()` or `install()` with
 * `processLocally: true`, or `start()` on a recognizer with `processLocally` and a `lang`, is
 * enough. With these off, those members do not exist in any frame of the view, iframes and blob:
 * documents included, which a page-world stub cannot reach; plain `start()` still ends in a
 * `not-allowed` error because the microphone is never granted, and speech synthesis is untouched.
 * `--disable-speech-api` is not the fix: it removes synthesis too while the unprefixed API still
 * crashes. Chromium ignores a name it does not know, so the self test (`npm run test:e2e`) re-checks the
 * kill in real Electron, a cross-site frame included.
 */
export const GAME_DISABLED_BLINK_FEATURES = ["OnDeviceWebSpeechAvailable", "InstallOnDeviceSpeechRecognition"] as const;

/** The game view's `webPreferences`, for the game session it is given. No preload, ever. */
export function gameViewPreferences<S>(gameSession: S, offscreen: boolean) {
  return {
    session: gameSession,
    offscreen,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    // Unattended runs must keep simulating while the window is occluded or in the background.
    backgroundThrottling: false,
    // Nobody clicks a hidden preview: an AudioContext must start without a gesture, or the
    // audio probes (`__studio.audio()`) measure silence forever.
    autoplayPolicy: "no-user-gesture-required" as const,
    disableBlinkFeatures: GAME_DISABLED_BLINK_FEATURES.join(","),
  };
}
