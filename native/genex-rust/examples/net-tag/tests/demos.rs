//! net-tag's rules through its demos, headless in the loopback room (the example's default
//! `net-loopback` feature, as a Live build of a `[net]` game): the menu comes before any network
//! contact, two players land on opposite teams and a touch scores once for the toucher's team, a
//! leaving host hands the host role and the tag to the next seat with the tag where it was, a
//! reconnect keeps the seat and its team, and a round waits below the quorum. Every demo's answer
//! and checksum is the same on a second run and equals the goldens in `tests/goldens/demos.json`
//! (written with `GENEX_NET_TAG_BLESS=1`), so a scripted session is a pure function of the seed and
//! the script.

use std::path::PathBuf;

use genex::net::NetMode;
use genex::{FIXED_STEP_MS, Runtime, Value, json};
use net_tag_game::{BLUE, DEMOS, RED, World, game};

/// The seed every row runs.
const SEED: u32 = 1;

fn runtime() -> Runtime<World> {
    let mut runtime = Runtime::new(game()).expect("net-tag installs");
    runtime.seed(SEED);
    runtime
}

fn demo(name: &str) -> (Value, Value) {
    let mut runtime = runtime();
    let answer = runtime.demo(name).expect("the demo exists");
    (answer, runtime.state()["checksum"].clone())
}

#[test]
fn the_menu_comes_before_any_network_contact() {
    let mut runtime = runtime();
    assert!(runtime.start());
    for _ in 0..120 {
        runtime.step(FIXED_STEP_MS);
    }
    let probe = &runtime.probes()["tag"];
    assert_eq!(runtime.sim().net.mode(), NetMode::Loopback, "the dev flavour plays in the loopback room");
    assert_eq!((probe["mode"].as_str(), probe["status"].as_str()), (Some("menu"), Some("offline")));
    assert_eq!(runtime.state()["__net"]["players"], json!(0), "nobody is seated before Play online");
}

#[test]
fn solo_plays_bots_offline() {
    let (answer, _) = demo("solo");
    assert_eq!(answer["mode"], json!("bots"));
    assert_eq!(answer["status"], json!("offline"), "Bots never touches sim.net");
    assert_eq!(answer["players"], json!(0));
    let points = answer["score"][RED].as_u64().unwrap_or(0) + answer["score"][BLUE].as_u64().unwrap_or(0);
    assert!(points >= 1, "the bots reach the tag in three seconds: {answer}");
}

#[test]
fn two_players_land_on_opposite_teams_and_a_touch_scores_for_the_touchers_team() {
    let (answer, _) = demo("two_players");
    assert_eq!(answer["status"], json!("joined"));
    assert_eq!(answer["host"], json!("me"), "the first seat hosts");
    assert_eq!(answer["players"], json!(2));
    assert_eq!(answer["teams"], json!({ "me": RED, "remote-1": BLUE }), "opposite teams");
    assert_eq!(answer["phase"], json!("playing"));
    assert_eq!(answer["score"][BLUE], json!(1), "Bea's raw position on the tag scores once for blue: {answer}");
    assert_eq!(answer["tagOwner"], json!("me"), "the host simulates the tag after an accepted claim");
}

#[test]
fn host_leaves_migrates_the_host_and_re_claims_the_tag_where_it_was() {
    let (answer, _) = demo("host_leaves");
    let (before, after) = (&answer["before"], &answer["after"]);
    assert_eq!((before["host"].as_str(), before["tagOwner"].as_str()), (Some("remote-1"), Some("remote-1")));
    assert_eq!((after["host"].as_str(), after["tagOwner"].as_str()), (Some("me"), Some("me")), "{answer}");
    assert_eq!(after["tag"], json!([3.0, -2.0]), "seeded from the tag's last raw state, not the origin");
    let claims = |probe: &Value| probe["claimsAccepted"].as_u64().unwrap_or(0);
    assert_eq!(claims(after), claims(before) + 1, "one claim_as_host after the migration");
    assert_eq!(after["players"], json!(1));
}

#[test]
fn reconnect_keeps_the_seat_and_its_team() {
    let (answer, _) = demo("reconnect");
    let (before, during, after) = (&answer["before"], &answer["during"], &answer["after"]);
    assert_eq!(during["status"], json!("reconnecting"));
    assert_eq!(after["status"], json!("joined"), "{answer}");
    assert_eq!((before["me"].as_str(), after["me"].as_str()), (Some("me"), Some("me")), "the same seat");
    assert_eq!(after["teams"]["me"], before["teams"]["me"], "the same team");
    assert_eq!(after["players"], json!(2), "the other player is still seated");
}

#[test]
fn match_quorum_waits_below_two_connected_players_and_resumes_on_a_backfill() {
    let (answer, _) = demo("match_quorum");
    assert_eq!(answer["phases"], json!(["waiting", "playing", "waiting", "playing"]), "{answer}");
    let teams = &answer["end"]["teams"];
    assert_eq!(teams["remote-1"], json!(BLUE), "a player in the reconnect grace keeps their team");
    assert_eq!(teams["remote-2"], json!(RED), "the backfill joins the smaller team (red on a tie)");
}

fn goldens_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/goldens/demos.json")
}

#[test]
fn every_demo_replays_with_the_same_answer_and_the_golden_checksum() {
    let mut found = json!({});
    for name in DEMOS {
        let (answer, checksum) = demo(name);
        let (again, checksum_again) = demo(name);
        assert_eq!((&answer, &checksum), (&again, &checksum_again), "{name}: a second run differs");
        found[name] = json!({ "checksum": checksum, "answer": answer });
    }
    let path = goldens_path();
    if std::env::var("GENEX_NET_TAG_BLESS").is_ok_and(|v| v == "1") {
        std::fs::write(&path, format!("{found:#}\n")).expect("goldens written");
    }
    let goldens: Value = std::fs::read_to_string(&path).expect("goldens exist").parse().expect("goldens parse");
    for name in DEMOS {
        assert_eq!(found[name]["checksum"], goldens[name]["checksum"], "{name}: checksum differs from the golden");
        assert_eq!(found[name]["answer"], goldens[name]["answer"], "{name}: answer differs from the golden");
    }
}
