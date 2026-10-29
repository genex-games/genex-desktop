//! `cargo run -p genex-anim --example character_check -- <model.glb> [<clips.glb>...]`
//!
//! Checks a generated humanoid and its clips and prints the report as JSON (the shape of
//! `src/shared/character-check.ts`'s `CharacterCheckReport`). Exit 0 when it passes, 1 when a
//! diagnostic fails it, 2 when the model cannot be read. Extra GLBs are animation-only files whose
//! clips are mapped onto the model's joints by name.

use std::fmt::Write as _;
use std::process::ExitCode;

use genex_anim::clip::{Clip, import_clips, import_clips_by_name};
use genex_anim::clip_set::ClipRole;
use genex_anim::humanoid::{HUMANOID_BONES, HumanoidBone};
use genex_anim::import::import_rig;
use genex_anim::pose_check::PoseCheck;

fn quote(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A finite number as JSON; NaN and infinity as null.
fn number(value: f32) -> String {
    if value.is_finite() { format!("{value}") } else { "null".to_owned() }
}

fn main() -> ExitCode {
    let files: Vec<String> = std::env::args().skip(1).collect();
    let Some((model, extra)) = files.split_first() else {
        eprintln!("usage: character_check <model.glb> [<clips.glb>...]");
        return ExitCode::from(2);
    };
    let bytes = match std::fs::read(model) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("{model}: {error}");
            return ExitCode::from(2);
        }
    };
    let rig = match import_rig(&bytes) {
        Ok(rig) => rig,
        Err(error) => {
            eprintln!("{model}: {}", error.detail);
            return ExitCode::from(2);
        }
    };
    let mut clips: Vec<Clip> = import_clips(&bytes, &rig).unwrap_or_default();
    let mut unreadable = Vec::new();
    for file in extra {
        match std::fs::read(file).map_err(|e| e.to_string()).and_then(|b| import_clips_by_name(&b, &rig).map_err(|e| e.detail)) {
            Ok(more) => clips.extend(more),
            Err(detail) => unreadable.push((file.clone(), detail)),
        }
    }
    let check = PoseCheck::new(rig.skeleton());
    let report = check.check(&clips);
    let map = check.map();
    let mapped: Vec<String> = HumanoidBone::ALL.iter().filter_map(|b| map.joint(*b).map(|j| format!("{}:{}", quote(b.name()), quote(rig.skeleton().name(j))))).collect();
    let missing: Vec<String> = map.missing().map(|b| quote(b.name())).collect();
    let roles: Vec<String> = ClipRole::ALL.iter().map(|r| format!("{}:{}", quote(r.wire()), report.set.clip(*r).map_or("null".to_owned(), |i| quote(clips[i].name())))).collect();
    let mut diagnostics: Vec<String> = report
        .diagnostics
        .iter()
        .map(|d| {
            let role = d.role.map_or("null".to_owned(), |r| quote(r.wire()));
            let bone = d.bone.map_or("null".to_owned(), |b| quote(b.name()));
            format!("{{\"code\":{},\"cause\":{},\"clip\":{},\"role\":{role},\"time\":{},\"bone\":{bone},\"value\":{},\"limit\":{}}}", quote(d.code.wire()), quote(d.cause.wire()), quote(&d.clip), number(d.time), number(d.value), number(d.limit))
        })
        .collect();
    for (file, detail) in &unreadable {
        diagnostics.push(format!("{{\"code\":\"clip-unreadable\",\"cause\":\"bone-mismatch\",\"clip\":{},\"role\":null,\"time\":0,\"bone\":null,\"value\":null,\"limit\":0,\"detail\":{}}}", quote(file), quote(detail)));
    }
    let pass = diagnostics.is_empty();
    println!(
        "{{\"file\":{},\"profile\":{},\"bones\":{HUMANOID_BONES},\"mapped\":{{{}}},\"missingBones\":[{}],\"roles\":{{{}}},\"diagnostics\":[{}],\"pass\":{pass}}}",
        quote(model),
        quote(&format!("{:?}", map.profile())),
        mapped.join(","),
        missing.join(","),
        roles.join(","),
        diagnostics.join(",")
    );
    ExitCode::from(if pass { 0 } else { 1 })
}
