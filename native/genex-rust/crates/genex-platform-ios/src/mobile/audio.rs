//! The audio session (iOS) and audio focus (Android), as the shell's lifecycle sees them: on
//! `resumed` the shell asks the platform for its audio ([`AudioPlatform::acquire`]: the iOS ambient
//! session, which follows the silent switch and mixes with other apps; Android's audio focus), and
//! on `suspended` it gives it back. While resumed, the platform's own news arrives as
//! [`AudioChange`]s ([`AudioPlatform::poll`], drained every frame): an interruption (a call, Siri,
//! an alarm) silences the game until it ends, and the session is asked for again only when the
//! system says the app should resume; a focus loss or regain on Android does the same.
//! [`AudioGate`] keeps whether the game should be heard: only in the foreground, with the
//! platform's audio granted and no interruption under way.
//!
//! The game follows the gate ([`follow_gate`], game systems AU-8): its device output is muted
//! while [`AudioGate::muted`] is true, and the device (cpal's CoreAudio or AAudio output over the
//! runtime's queue) opens the first time the game may be heard. The simulation and the meter go
//! on either way, so `audioLevel` and `state()` never depend on the gate. The gate's `audio`
//! events in the lifecycle log are what M5.7 checks.

use genex::audio::Device;
use genex::{Value, json};
use genex_platform_web::GameHandle;

/// Whether the platform granted the app its audio.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Focus {
    /// Granted: the session is active (iOS) or the focus is held (Android).
    Held,
    /// Refused or taken by another app.
    Lost,
}

impl Focus {
    /// The wire spelling (the lifecycle log).
    pub const fn wire(self) -> &'static str {
        match self {
            Focus::Held => "held",
            Focus::Lost => "lost",
        }
    }
}

/// What the platform said about the app's audio while it was resumed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioChange {
    /// Another app took the audio (an incoming call, Siri, an alarm; Android's focus loss).
    InterruptionBegan,
    /// The interruption ended; `resume` is the system's advice that the app should play again
    /// (iOS's `ShouldResume` option; Android's focus gain always resumes).
    InterruptionEnded {
        /// Whether to ask for the audio again.
        resume: bool,
    },
}

/// A platform's audio hooks: plain functions, so the shell stays one type on every phone.
#[derive(Clone, Copy, Debug)]
pub struct AudioPlatform {
    /// Ask for the app's audio; answers whether it was granted.
    pub acquire: fn() -> bool,
    /// Give it back.
    pub release: fn(),
    /// The next change the platform reported, if any (drained every frame).
    pub poll: fn() -> Option<AudioChange>,
}

impl AudioPlatform {
    /// No platform audio (host builds and tests): always granted, nothing to give back, no news.
    pub const NONE: AudioPlatform = AudioPlatform { acquire: || true, release: || {}, poll: || None };
}

/// Whether the game should be heard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AudioGate {
    foreground: bool,
    focus: Focus,
    interrupted: bool,
}

impl Default for AudioGate {
    fn default() -> Self {
        AudioGate { foreground: false, focus: Focus::Lost, interrupted: false }
    }
}

impl AudioGate {
    /// The app came to the foreground and asked for its audio; `granted` is the platform's answer.
    pub fn resumed(&mut self, granted: bool) {
        self.foreground = true;
        self.interrupted = false;
        self.focus = if granted { Focus::Held } else { Focus::Lost };
    }

    /// The app went to the background and gave its audio back.
    pub fn suspended(&mut self) {
        self.foreground = false;
        self.focus = Focus::Lost;
    }

    /// Apply what the platform reported while resumed; `acquire` asks for the audio again when an
    /// interruption ends with the advice to resume. Answers whether anything changed.
    pub fn changed(&mut self, change: AudioChange, acquire: impl FnOnce() -> bool) -> bool {
        let before = *self;
        match change {
            AudioChange::InterruptionBegan => {
                self.interrupted = true;
                self.focus = Focus::Lost;
            }
            AudioChange::InterruptionEnded { resume } => {
                self.interrupted = false;
                if resume && self.foreground {
                    self.focus = if acquire() { Focus::Held } else { Focus::Lost };
                }
            }
        }
        *self != before
    }

    /// Whether an interruption is under way.
    pub fn interrupted(&self) -> bool {
        self.interrupted
    }

    /// Whether the game's audio is silenced now.
    pub fn muted(&self) -> bool {
        !self.foreground || self.interrupted || self.focus == Focus::Lost
    }

    /// The lifecycle log's `audio` event.
    pub fn event(&self) -> Value {
        json!({ "event": "audio", "focus": self.focus.wire(), "interrupted": self.interrupted, "muted": self.muted() })
    }
}

/// Make `game` follow `gate`: mute its device output while the gate is muted, and open `device`
/// on its queue the first time the game may be heard (later calls report the device's faults).
pub fn follow_gate(gate: &AudioGate, game: &mut dyn GameHandle, device: &mut Device) {
    let muted = gate.muted();
    game.set_output_muted(muted);
    if !muted || device.tried() {
        game.follow_device(device);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_game_is_heard_only_resumed_with_its_audio_granted() {
        let mut gate = AudioGate::default();
        assert!(gate.muted(), "launched, never resumed");
        gate.resumed(true);
        assert!(!gate.muted());
        assert_eq!(gate.event(), json!({ "event": "audio", "focus": "held", "interrupted": false, "muted": false }));
        gate.suspended();
        assert!(gate.muted(), "in the background");
        gate.resumed(false);
        assert!(gate.muted(), "another app holds the audio");
        assert_eq!(gate.event(), json!({ "event": "audio", "focus": "lost", "interrupted": false, "muted": true }));
    }

    #[test]
    fn host_builds_have_no_platform_audio_to_ask_for() {
        assert!((AudioPlatform::NONE.acquire)());
        (AudioPlatform::NONE.release)();
        assert_eq!((AudioPlatform::NONE.poll)(), None);
    }

    #[test]
    fn an_interruption_silences_the_game_until_it_ends_with_the_advice_to_resume() {
        let mut gate = AudioGate::default();
        gate.resumed(true);
        assert!(gate.changed(AudioChange::InterruptionBegan, || unreachable!("not asked while interrupted")));
        assert!(gate.muted() && gate.interrupted());
        let mut asked = 0;
        assert!(gate.changed(AudioChange::InterruptionEnded { resume: false }, || {
            asked += 1;
            true
        }));
        assert!(gate.muted(), "ended without the advice to resume: stays silent");
        assert_eq!(asked, 0);
        gate.changed(AudioChange::InterruptionBegan, || true);
        gate.changed(AudioChange::InterruptionEnded { resume: true }, || {
            asked += 1;
            true
        });
        assert!(!gate.muted(), "the session is asked for again and granted");
        assert_eq!(asked, 1);
    }

    #[test]
    fn an_interruption_that_ends_in_the_background_waits_for_the_next_resume() {
        let mut gate = AudioGate::default();
        gate.resumed(true);
        gate.changed(AudioChange::InterruptionBegan, || true);
        gate.suspended();
        gate.changed(AudioChange::InterruptionEnded { resume: true }, || unreachable!("never asked in the background"));
        assert!(gate.muted());
        gate.resumed(true);
        assert!(!gate.muted() && !gate.interrupted(), "a resume starts clean");
    }

    /// The waveform of the asset-import fixture `tone.wav` (FFmpeg's 440 Hz sine, mono, 48 kHz,
    /// 0.5 s, peak 4095) as a 16-bit PCM WAV: a forked engine crate's sources may not include a
    /// file outside the crate (the eject stage refuses `include-escape`).
    fn tone_wav() -> &'static [u8] {
        const RATE: u32 = 48_000;
        const FRAMES: u32 = RATE / 2;
        const PEAK: f64 = 4095.0;
        let data_bytes = FRAMES * 2;
        let mut bytes = Vec::with_capacity(44 + data_bytes as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&RATE.to_le_bytes());
        bytes.extend_from_slice(&(RATE * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_bytes.to_le_bytes());
        for frame in 0..FRAMES {
            let phase = 2.0 * std::f64::consts::PI * 440.0 * f64::from(frame) / f64::from(RATE);
            let sample = (phase.sin() * PEAK).round() as i16;
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        Box::leak(bytes.into_boxed_slice())
    }
    const STEP_MS: f64 = 1000.0 / 60.0;

    /// A game that plays the tone on its first tick.
    fn tone_game() -> genex::Runtime<Option<genex::audio::Sound>> {
        let table: genex::AssetTable = Box::leak(Box::new([("sfx/tone.wav", tone_wav())]));
        let mut game = genex::Game::new(None::<genex::audio::Sound>);
        game.on_reset(|sim, _, _, gfx| sim.world = Some(gfx.sound("sfx/tone.wav")));
        game.on_update(|sim, ctx| {
            if let (0, Some(sound)) = (ctx.tick, sim.world.as_ref()) {
                ctx.audio.play(sound);
            }
        });
        genex::Runtime::with_assets(game, Box::new(table)).expect("installs")
    }

    /// AU-8 red row (closes M5-F3): a muted gate mutes the device output, shown in
    /// `volatile.audio.device.muted`, while `audioLevel` reads the same mix as an unmuted run; no
    /// device opens until the game may be heard.
    #[test]
    fn a_muted_gate_mutes_the_device_and_leaves_the_level() {
        let mut heard: Box<dyn GameHandle> = Box::new(tone_game());
        let mut muted: Box<dyn GameHandle> = Box::new(tone_game());
        let mut device = Device::default();
        follow_gate(&AudioGate::default(), muted.as_mut(), &mut device);
        assert!(!device.tried(), "no device while the gate is muted");
        for game in [&mut heard, &mut muted] {
            game.step(10.0 * STEP_MS);
        }
        assert!(muted.output_muted() && !heard.output_muted());
        let state = muted.state();
        assert_eq!(state["volatile"]["audio"]["device"]["muted"], json!(true), "{state}");
        let bits = |game: &dyn GameHandle| (game.audio_level().rms.to_bits(), game.audio_level().centroid.to_bits());
        assert_eq!(bits(muted.as_ref()), bits(heard.as_ref()), "the meter reads the mix under the mute");
        assert!(muted.audio_level().rms > 0.05, "the tone, not silence");
        assert_eq!(muted.checksum(), heard.checksum(), "the gate never reaches the simulation");
    }

    /// AU-8: once resumed with its audio granted the game is unmuted and the device is asked for
    /// once (a test process, marked `GENEX_NO_WINDOW=1`, opens none); a suspend mutes it again.
    #[test]
    fn a_granted_gate_unmutes_and_asks_for_the_device_once() {
        let mut game: Box<dyn GameHandle> = Box::new(tone_game());
        let mut device = Device::default();
        let mut gate = AudioGate::default();
        gate.resumed((AudioPlatform::NONE.acquire)());
        follow_gate(&gate, game.as_mut(), &mut device);
        assert!(!game.output_muted() && device.tried());
        gate.suspended();
        follow_gate(&gate, game.as_mut(), &mut device);
        assert!(game.output_muted());
        game.step(STEP_MS);
        assert_eq!(game.state()["volatile"]["audio"]["device"]["muted"], json!(true));
    }
}
