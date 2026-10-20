//! Off-mesh links (NAV-8): jumps, drops, ladders, doors, teleporters and game kinds, as landmass
//! animation links. A link is global: it attaches to whichever islands lie under its ends, drops
//! off when one streams out and attaches again, with the same id, when it streams back (landmass's
//! `AnimationLink`, the navcat model).
//!
//! The crossing is the game's: an agent reaching the link says `ReachedAnimationLink`
//! (facade `at-link`); [`take_link`] starts the crossing (`UsingAnimationLink`, facade
//! `on-link`), the game plays the clip and moves the body, and [`finish_link`] hands the agent
//! back to its path (`Moving`).

use glam::Vec3;

use crate::error::NavError;
use crate::runtime::agent::{AgentId, ReachedAnimationLink};
use crate::runtime::archipelago::Archipelago;
use crate::runtime::coords::{CoordinateSystem, CorePointSampleDistance, GenexCoords, PointSampleDistance};
use crate::runtime::link::{AnimationLink, AnimationLinkId};

/// The most links one nav holds.
pub const NAV_LINKS_MAX: usize = 4096;

/// The first link code a game kind gets: `Custom(n)` is `CUSTOM_CODE_FIRST + n`.
const CUSTOM_CODE_FIRST: usize = 16;

/// How a link is crossed; the game plays it (ANIM) between [`take_link`] and [`finish_link`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum NavLinkKind {
    /// A jump across a gap or up a ledge.
    Jump,
    /// A drop down a ledge.
    Drop,
    /// A ladder.
    Ladder,
    /// A door the game opens.
    Door,
    /// A teleporter.
    Teleport,
    /// A game-defined kind.
    Custom(u8),
}

impl NavLinkKind {
    /// The built-in kinds, in declaration order.
    pub const BUILT_IN: [NavLinkKind; 5] = [NavLinkKind::Jump, NavLinkKind::Drop, NavLinkKind::Ladder, NavLinkKind::Door, NavLinkKind::Teleport];

    /// The kind's number in the runtime (what agents and filters permit).
    pub const fn code(self) -> usize {
        match self {
            NavLinkKind::Jump => 0,
            NavLinkKind::Drop => 1,
            NavLinkKind::Ladder => 2,
            NavLinkKind::Door => 3,
            NavLinkKind::Teleport => 4,
            NavLinkKind::Custom(index) => CUSTOM_CODE_FIRST + index as usize,
        }
    }

    /// The kind with this runtime number.
    pub fn from_code(code: usize) -> Option<NavLinkKind> {
        if code >= CUSTOM_CODE_FIRST {
            return u8::try_from(code - CUSTOM_CODE_FIRST).ok().map(NavLinkKind::Custom);
        }
        NavLinkKind::BUILT_IN.into_iter().find(|kind| kind.code() == code)
    }

    /// The kind's wire spelling, for probes.
    pub const fn wire(self) -> &'static str {
        match self {
            NavLinkKind::Jump => "jump",
            NavLinkKind::Drop => "drop",
            NavLinkKind::Ladder => "ladder",
            NavLinkKind::Door => "door",
            NavLinkKind::Teleport => "teleport",
            NavLinkKind::Custom(_) => "custom",
        }
    }
}

/// An off-mesh link from one edge to another, in genex world space (Y up).
#[derive(Clone, Debug, PartialEq)]
pub struct NavLink {
    start: [Vec3; 2],
    end: [Vec3; 2],
    kind: NavLinkKind,
    cost: f32,
    both_ways: bool,
}

impl NavLink {
    /// From the point `from` to the point `to` (an agent walks to `from`, crosses, lands at `to`).
    pub fn between(from: Vec3, to: Vec3, kind: NavLinkKind) -> NavLink {
        NavLink::edges([from, from], [to, to], kind)
    }

    /// From the edge (a0, a1) to the edge (b0, b1); a0 leads to b0. Costs its length by default.
    pub fn edges(start: [Vec3; 2], end: [Vec3; 2], kind: NavLinkKind) -> NavLink {
        let cost = start[0].midpoint(start[1]).distance(end[0].midpoint(end[1]));
        NavLink { start, end, kind, cost, both_ways: false }
    }

    /// The cost of taking the link (default: the distance it spans).
    pub fn with_cost(mut self, cost: f32) -> NavLink {
        self.cost = cost;
        self
    }

    /// The link goes both ways.
    pub fn both_ways(mut self) -> NavLink {
        self.both_ways = true;
        self
    }

    /// The link's kind.
    pub fn kind(&self) -> NavLinkKind {
        self.kind
    }

    /// The runtime link.
    fn to_runtime(&self) -> AnimationLink<GenexCoords> {
        AnimationLink {
            start_edge: (self.start[0], self.start[1]),
            end_edge: (self.end[0], self.end[1]),
            kind: self.kind.code(),
            cost: self.cost,
            bidirectional: self.both_ways,
        }
    }

    /// What is wrong with the link's own numbers, if anything.
    fn invalid(&self) -> Option<String> {
        let points_finite = self.start.iter().chain(&self.end).all(|point| point.is_finite());
        if !points_finite {
            return Some("a link end is not finite".to_owned());
        }
        if !self.cost.is_finite() || self.cost < 0.0 {
            return Some(format!("link cost {} is not a finite number of at least 0", self.cost));
        }
        None
    }
}

/// Adds `link` after checking it: finite ends and cost, room under [`NAV_LINKS_MAX`], and every
/// end point within the sample reach (horizontal) and `animation_link_max_vertical_distance`
/// (vertical) of some mesh, so it can attach. Nothing is added on a refusal.
///
/// # Errors
///
/// `nav-link-invalid` for a bad number or an end far from every mesh; `nav-too-large` past the
/// cap.
pub fn add_link(archipelago: &mut Archipelago<GenexCoords>, link: &NavLink) -> Result<AnimationLinkId, NavError> {
    if let Some(detail) = link.invalid() {
        return Err(NavError::link_invalid(detail));
    }
    if archipelago.get_animation_link_ids().count() >= NAV_LINKS_MAX {
        return Err(NavError::too_large(format!("a nav holds at most {NAV_LINKS_MAX} links")));
    }
    let samples = &archipelago.archipelago_options.point_sample_distance;
    let vertical = samples.animation_link_max_vertical_distance();
    let reach = CorePointSampleDistance {
        horizontal_distance: samples.horizontal_distance(),
        distance_above: vertical,
        distance_below: vertical,
        vertical_preference_ratio: samples.vertical_preference_ratio(),
    };
    for (end, point) in [("start", link.start[0]), ("start", link.start[1]), ("end", link.end[0]), ("end", link.end[1])] {
        if archipelago.nav_data().sample_point(GenexCoords::to_landmass(&point), &reach).is_none() {
            return Err(NavError::link_invalid(format!("the link's {end} at {point} is more than {vertical} m from every mesh")));
        }
    }
    Ok(archipelago.add_animation_link(link.to_runtime()))
}

/// Starts `agent`'s crossing of the link it reached at the last update, and returns that link.
/// `None` (nothing changes) when it reached none.
pub fn take_link<CS: CoordinateSystem>(archipelago: &mut Archipelago<CS>, agent: AgentId) -> Option<ReachedAnimationLink<CS>> {
    let agent = archipelago.get_agent_mut(agent)?;
    let reached = agent.reached_animation_link()?.clone();
    agent.start_animation_link().ok()?;
    Some(reached)
}

/// Ends `agent`'s crossing; it follows its path again from the next update. Returns false when it
/// was not crossing.
pub fn finish_link<CS: CoordinateSystem>(archipelago: &mut Archipelago<CS>, agent: AgentId) -> bool {
    archipelago.get_agent_mut(agent).is_some_and(|agent| agent.end_animation_link().is_ok())
}
