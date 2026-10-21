//! The host's team reconciler: the net page's "host-only shared state" rule as twenty lines of game
//! code (extension ladder level 1), not a facade call. The host runs it every tick over the seated
//! players and publishes the result in the shared `teams` key only when it changed.

use std::collections::BTreeMap;

use genex::Value;

/// The red team's wire name.
pub const RED: &str = "red";
/// The blue team's wire name.
pub const BLUE: &str = "blue";

/// The teams the host should publish: every seated player keeps the team `current` gives them,
/// players who left drop out, and each newcomer, in id order, joins the smaller team (red on a
/// tie). `current` is the shared `teams` value: an object of player id to team, or anything else
/// when nothing was published yet.
pub fn reconcile(current: Option<&Value>, seated: &[&str]) -> BTreeMap<String, String> {
    let known = |id: &str| current.and_then(|teams| teams.get(id)).and_then(Value::as_str).filter(|team| [RED, BLUE].contains(team));
    let mut teams: BTreeMap<String, String> = BTreeMap::new();
    for id in seated {
        if let Some(team) = known(id) {
            teams.insert((*id).to_owned(), team.to_owned());
        }
    }
    for id in seated {
        if teams.contains_key(*id) {
            continue;
        }
        let reds = teams.values().filter(|team| team.as_str() == RED).count();
        let team = if reds * 2 <= teams.len() { RED } else { BLUE };
        teams.insert((*id).to_owned(), team.to_owned());
    }
    teams
}

#[cfg(test)]
mod tests {
    use super::*;
    use genex::json;

    #[test]
    fn newcomers_fill_the_smaller_team_in_id_order_and_seated_players_keep_theirs() {
        let teams = reconcile(None, &["me", "remote-1", "remote-2"]);
        assert_eq!(teams["me"], RED);
        assert_eq!(teams["remote-1"], BLUE);
        assert_eq!(teams["remote-2"], RED);
        let published = json!({ "me": "blue", "gone": "red", "remote-1": "blue" });
        let teams = reconcile(Some(&published), &["me", "remote-1", "remote-3"]);
        assert_eq!(teams.len(), 3, "a leaver drops out");
        assert_eq!((teams["me"].as_str(), teams["remote-1"].as_str()), (BLUE, BLUE), "seated players keep their team");
        assert_eq!(teams["remote-3"], RED, "the newcomer joins the smaller team");
    }

    #[test]
    fn a_published_value_that_is_not_a_team_is_ignored() {
        let published = json!({ "me": "green", "remote-1": 3 });
        let teams = reconcile(Some(&published), &["me", "remote-1"]);
        assert_eq!((teams["me"].as_str(), teams["remote-1"].as_str()), (RED, BLUE));
    }
}
