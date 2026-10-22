//! The audio vocabularies keep their exact wire spellings: every code round-trips through
//! `as_str` and `from_wire`, and a spelling the runtime does not know answers `None`.

use genex_audio::{
    AUDIO_EVENTS_MAX, AudioErrorCode, AudioEventCode, AudioSettings, AudioSpan, Attenuation, Bus, DeviceFault,
    LOGICAL_VOICES_MAX, PHYSICAL_VOICES_DESKTOP, PHYSICAL_VOICES_PHONE, PHYSICAL_VOICES_WEB, PoolClass,
};

const UNKNOWN: [&str; 5] = ["", "SFX", " sfx", "sfx ", "nope"];

#[test]
fn buses_round_trip_in_mixer_order() {
    let wires: Vec<&str> = Bus::ALL.iter().map(|bus| bus.as_str()).collect();
    assert_eq!(wires, ["music", "sfx", "ui", "voice", "ambience"]);
    for bus in Bus::ALL {
        assert_eq!(Bus::from_wire(bus.as_str()), Some(bus));
    }
    assert_eq!(Bus::default(), Bus::Sfx);
    for wire in UNKNOWN {
        assert_eq!(Bus::from_wire(wire), None, "{wire:?}");
    }
}

#[test]
fn attenuation_models_round_trip() {
    let rows = [
        (Attenuation::Inverse, "inverse"),
        (Attenuation::Linear, "linear"),
        (Attenuation::Exponential, "exponential"),
        (Attenuation::Off, "off"),
    ];
    for (model, wire) in rows {
        assert_eq!(model.as_str(), wire);
        assert_eq!(Attenuation::from_wire(wire), Some(model));
    }
    assert_eq!(Attenuation::ALL.len(), rows.len());
    assert_eq!(Attenuation::default(), Attenuation::Inverse);
    for wire in UNKNOWN {
        assert_eq!(Attenuation::from_wire(wire), None, "{wire:?}");
    }
}

#[test]
fn audio_event_codes_round_trip_in_kebab_case() {
    let rows = [
        (AudioEventCode::Played, "played"),
        (AudioEventCode::Ended, "ended"),
        (AudioEventCode::Stopped, "stopped"),
        (AudioEventCode::Stolen, "stolen"),
        (AudioEventCode::Virtualized, "virtualized"),
        (AudioEventCode::Realized, "realized"),
        (AudioEventCode::Refused, "refused"),
        (AudioEventCode::MusicStarted, "music-started"),
        (AudioEventCode::MusicEnded, "music-ended"),
    ];
    for (code, wire) in rows {
        assert_eq!(code.as_str(), wire);
        assert_eq!(AudioEventCode::from_wire(wire), Some(code));
    }
    assert_eq!(AudioEventCode::ALL.len(), rows.len());
    for wire in UNKNOWN.iter().chain(&["music_started", "MusicStarted"]) {
        assert_eq!(AudioEventCode::from_wire(wire), None, "{wire:?}");
    }
}

#[test]
fn pool_classes_round_trip_and_size_the_physical_pool() {
    let rows = [
        (PoolClass::Desktop, "desktop", PHYSICAL_VOICES_DESKTOP),
        (PoolClass::Web, "web", PHYSICAL_VOICES_WEB),
        (PoolClass::Phone, "phone", PHYSICAL_VOICES_PHONE),
    ];
    for (class, wire, voices) in rows {
        assert_eq!(class.as_str(), wire);
        assert_eq!(PoolClass::from_wire(wire), Some(class));
        assert_eq!(class.physical_voices(), voices);
        assert!(voices <= LOGICAL_VOICES_MAX, "a physical pool never exceeds the logical cap");
    }
    assert_eq!((PHYSICAL_VOICES_DESKTOP, PHYSICAL_VOICES_WEB, PHYSICAL_VOICES_PHONE), (48, 32, 24));
    assert_eq!((LOGICAL_VOICES_MAX, AUDIO_EVENTS_MAX), (64, 64));
    for wire in UNKNOWN {
        assert_eq!(PoolClass::from_wire(wire), None, "{wire:?}");
    }
}

#[test]
fn audio_error_codes_keep_the_old_spellings_and_add_the_new_ones() {
    let rows = [
        (AudioErrorCode::MixerFailed, "mixer-failed"),
        (AudioErrorCode::SoundLimit, "sound-limit"),
        (AudioErrorCode::UnsupportedFormat, "unsupported-format"),
        (AudioErrorCode::NeedsImport, "needs-import"),
        (AudioErrorCode::Malformed, "malformed"),
        (AudioErrorCode::TooLarge, "too-large"),
        (AudioErrorCode::InstanceLimit, "instance-limit"),
        (AudioErrorCode::ZoneLimit, "zone-limit"),
        (AudioErrorCode::SoundMissing, "sound-missing"),
        (AudioErrorCode::MemoryLimit, "memory-limit"),
        (AudioErrorCode::InvalidValue, "invalid-value"),
        (AudioErrorCode::Disabled, "audio-disabled"),
    ];
    for (code, wire) in rows {
        assert_eq!(code.as_str(), wire);
        assert_eq!(AudioErrorCode::from_wire(wire), Some(code));
    }
    assert_eq!(AudioErrorCode::ALL.len(), rows.len());
    for wire in UNKNOWN {
        assert_eq!(AudioErrorCode::from_wire(wire), None, "{wire:?}");
    }
}

#[test]
fn device_faults_round_trip() {
    let rows = [(DeviceFault::NoDevice, "no-device"), (DeviceFault::DeviceLost, "device-lost"), (DeviceFault::Underrun, "underrun")];
    for (fault, wire) in rows {
        assert_eq!(fault.as_str(), wire);
        assert_eq!(DeviceFault::from_wire(wire), Some(fault));
    }
    for wire in UNKNOWN {
        assert_eq!(DeviceFault::from_wire(wire), None, "{wire:?}");
    }
}

#[test]
fn profile_span_names_are_pinned() {
    assert_eq!(AudioSpan::Mix.as_str(), "audio.mix");
    assert_eq!(AudioSpan::Decide.as_str(), "audio.decide");
    for span in AudioSpan::ALL {
        assert_eq!(AudioSpan::from_wire(span.as_str()), Some(span));
    }
    assert_eq!(AudioSpan::from_wire("audio"), None);
}

#[test]
fn audio_settings_default_to_full_volume_and_clamp_per_bus() {
    let settings = AudioSettings::default();
    assert_eq!(settings.master, 1.0);
    for bus in Bus::ALL {
        assert_eq!(settings.bus(bus), 1.0, "{bus:?}");
    }
    let quiet = settings.with_bus(Bus::Music, 0.25);
    assert_eq!(quiet.bus(Bus::Music), 0.25);
    assert_eq!(quiet.bus(Bus::Sfx), 1.0, "only the named bus moves");
    let rows: [(f32, f32); 5] = [(2.0, 1.0), (-1.0, 0.0), (f32::INFINITY, 1.0), (f32::NEG_INFINITY, 0.0), (f32::NAN, 0.25)];
    for (volume, expected) in rows {
        assert_eq!(quiet.with_bus(Bus::Music, volume).bus(Bus::Music), expected, "{volume}");
    }
}

#[test]
fn audio_settings_serialize_by_bus_name() {
    let settings = AudioSettings::default().with_bus(Bus::Voice, 0.5);
    let text = serde_json::to_string(&settings).unwrap();
    assert_eq!(text, r#"{"master":1.0,"music":1.0,"sfx":1.0,"ui":1.0,"voice":0.5,"ambience":1.0}"#);
    let back: AudioSettings = serde_json::from_str(&text).unwrap();
    assert_eq!(back, settings);
    let partial: AudioSettings = serde_json::from_str(r#"{"sfx":0.5}"#).unwrap();
    assert_eq!(partial, AudioSettings::default().with_bus(Bus::Sfx, 0.5), "missing keys keep their defaults");
}
