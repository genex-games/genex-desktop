//! Native play identity (CLI_INTEGRATION.md §6b) end to end: get an `embed:play` token from the
//! API through one of the three doors, then join the relay with it.
//!
//! ```sh
//! GENEX_API_URL=https://api.genex.games cargo run --example identity -- guest <slug>
//! GENEX_API_URL=https://api.genex.games cargo run --example identity -- device <slug>
//! GENEX_EMBED_TICKET=<ticket> cargo run --example identity -- ticket <slug>
//! ```
//! `GENEX_RELAY_URL` overrides the relay URLs the API returned.
use genex_multiplayer::{ConnectOptions, DevicePoll, EmbedIdentity, Session};
use std::process::ExitCode;
use std::time::Duration;

fn main() -> ExitCode {
    // The launcher's ticket lives 60 s: take it before anything else, and out of the environment.
    let ticket = EmbedIdentity::take_ticket_from_env();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (door, slug) = match args.as_slice() {
        [door, slug] => (door.as_str(), slug.as_str()),
        _ => {
            eprintln!("usage: identity <guest|device|ticket> <slug>");
            return ExitCode::FAILURE;
        }
    };
    let api = std::env::var("GENEX_API_URL").unwrap_or_else(|_| "https://api.genex.games".into());
    let identity = match door {
        "guest" => EmbedIdentity::guest(&api, slug),
        "ticket" => match ticket {
            Some(t) => EmbedIdentity::from_ticket(&api, &t),
            None => {
                eprintln!("{} is not set: not launched by Genex", genex_multiplayer::TICKET_ENV);
                return ExitCode::FAILURE;
            }
        },
        "device" => device(&api, slug),
        _ => {
            eprintln!("unknown door `{door}`");
            return ExitCode::FAILURE;
        }
    };
    let mut identity = match identity {
        Ok(i) => i,
        Err(e) => {
            eprintln!("IDENTITY FAILED: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!(
        "ok  {door} identity: user={} relays={:?}",
        identity.user(),
        identity.relay_urls()
    );
    if let Err(e) = identity.refresh() {
        eprintln!("REFRESH FAILED: {e}");
        return ExitCode::FAILURE;
    }
    println!("ok  token refreshed");
    let endpoints = match std::env::var("GENEX_RELAY_URL") {
        Ok(url) => vec![url],
        Err(_) => identity.relay_urls().to_vec(),
    };
    let mut opts = ConnectOptions::new("", slug);
    opts.endpoints = endpoints;
    match Session::connect_blocking(opts, identity.into_provider(), 15_000) {
        Ok((mut s, _)) => {
            println!("ok  joined {} as {} (uid via relay)", s.room_id(), s.session_id());
            for _ in 0..20 {
                s.poll();
                std::thread::sleep(Duration::from_millis(10));
            }
            if let Some(me) = s.player(s.session_id()) {
                println!("    name={} uid={}", me.name, me.uid);
            }
            s.leave();
            for _ in 0..50 {
                s.poll();
                std::thread::sleep(Duration::from_millis(10));
            }
            println!("IDENTITY OK");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("JOIN FAILED: {e}");
            ExitCode::FAILURE
        }
    }
}

fn device(api: &str, slug: &str) -> Result<EmbedIdentity, genex_multiplayer::IdentityError> {
    let code = EmbedIdentity::device_start(api, slug)?;
    println!("    open {} and enter {}", code.verification_uri, code.user_code);
    let mut interval = code.interval;
    loop {
        std::thread::sleep(Duration::from_secs_f64(interval));
        match EmbedIdentity::device_poll(api, &code)? {
            DevicePoll::Pending { interval: next } => interval = next,
            DevicePoll::Approved(identity) => return Ok(identity),
            DevicePoll::Denied => {
                return Err(genex_multiplayer::IdentityError {
                    status: 0,
                    message: "denied".into(),
                })
            }
            DevicePoll::Expired => {
                return Err(genex_multiplayer::IdentityError {
                    status: 410,
                    message: "expired".into(),
                })
            }
        }
    }
}
