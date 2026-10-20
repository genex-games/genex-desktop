//! Area costs and filters (NAV-8): which areas are shut and which animation links are closed for
//! everyone ([`Gates`], a door), and what one query may walk ([`NavFilter`]: area costs, shut
//! areas and link kinds).
//!
//! landmass skips a polygon whose type cost is not finite but never revisits a path when a cost
//! changes. Patch P14 (see `runtime/pathfinding.rs` and `runtime/path.rs`) makes A* skip shut areas
//! and closed links, and the archipelago drops every corridor that crosses one on the tick it
//! shuts, so the agents walking through repath (or go `NoPath`) at that update.

use genex_core::map::{Map, Set};

use crate::input::NavArea;
use crate::links::NavLinkKind;
use crate::runtime::link::{AnimationLinkId, PermittedAnimationLinks};

/// What is shut for every agent and query: areas (doors) and animation links.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Gates {
    shut_areas: Set<usize>,
    closed_links: Set<AnimationLinkId>,
    /// Whether something shut since the archipelago last looked (opening never breaks a path).
    newly_shut: bool,
}

impl Gates {
    /// Everything open.
    pub fn new() -> Gates {
        Gates::default()
    }

    /// Whether no area is shut and no link closed.
    pub fn is_open_everywhere(&self) -> bool {
        self.shut_areas.is_empty() && self.closed_links.is_empty()
    }

    /// Whether the area with this type index is shut.
    pub fn is_area_shut(&self, type_index: usize) -> bool {
        self.shut_areas.contains(&type_index)
    }

    /// Whether this animation link is closed.
    pub fn is_link_closed(&self, link: AnimationLinkId) -> bool {
        self.closed_links.contains(&link)
    }

    /// Opens or shuts an area (by type index). Returns whether anything changed.
    pub fn set_area_open(&mut self, type_index: usize, open: bool) -> bool {
        let changed = if open { self.shut_areas.shift_remove(&type_index) } else { self.shut_areas.insert(type_index) };
        self.newly_shut |= changed && !open;
        changed
    }

    /// Opens or closes an animation link. Returns whether anything changed.
    pub fn set_link_open(&mut self, link: AnimationLinkId, open: bool) -> bool {
        let changed = if open { self.closed_links.shift_remove(&link) } else { self.closed_links.insert(link) };
        self.newly_shut |= changed && !open;
        changed
    }

    /// Forgets a removed link.
    pub(crate) fn forget_link(&mut self, link: AnimationLinkId) {
        self.closed_links.shift_remove(&link);
    }

    /// Whether something shut since the last call, clearing the flag.
    pub(crate) fn take_newly_shut(&mut self) -> bool {
        core::mem::take(&mut self.newly_shut)
    }
}

/// What one query may walk: per-area costs, shut areas and the link kinds it may take.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NavFilter {
    costs: Map<usize, f32>,
    shut: Set<usize>,
    links: PermittedAnimationLinks,
}

impl NavFilter {
    /// Everything walkable at the nav's own costs, every link kind.
    pub fn new() -> NavFilter {
        NavFilter::default()
    }

    /// This query's cost per metre for an area (a soldier who avoids WATER). A cost that is not
    /// above zero makes the query refuse (`nav-cost-invalid` at the facade).
    pub fn with_area_cost(mut self, area: NavArea, cost: f32) -> NavFilter {
        self.costs.insert(usize::from(area.raw()), cost);
        self
    }

    /// Never walk this area.
    pub fn without_area(mut self, area: NavArea) -> NavFilter {
        self.shut.insert(usize::from(area.raw()));
        self
    }

    /// Only links of these kinds.
    pub fn with_links(mut self, kinds: &[NavLinkKind]) -> NavFilter {
        self.links = PermittedAnimationLinks::kinds(kinds.iter().map(|kind| kind.code()));
        self
    }

    /// A filter from raw parts: costs by type index and permitted link kinds (the runtime's
    /// converted upstream tests build it this way).
    #[cfg(test)]
    pub(crate) fn from_parts(costs: Map<usize, f32>, links: PermittedAnimationLinks) -> NavFilter {
        NavFilter { costs, shut: Set::default(), links }
    }

    /// The cost overrides, by type index.
    pub fn costs(&self) -> &Map<usize, f32> {
        &self.costs
    }

    /// Whether this filter shuts the area with this type index.
    pub fn is_area_shut(&self, type_index: usize) -> bool {
        self.shut.contains(&type_index)
    }

    /// The link kinds the filter permits.
    pub fn links(&self) -> &PermittedAnimationLinks {
        &self.links
    }

    /// The first cost that is not above zero, as (type index, cost).
    pub fn invalid_cost(&self) -> Option<(usize, f32)> {
        self.costs.iter().map(|(&index, &cost)| (index, cost)).find(|&(_, cost)| cost.is_nan() || cost <= 0.0)
    }

    /// The filter's shut areas on top of `gates`' (a query sees both).
    pub(crate) fn gates_with(&self, gates: &Gates) -> Gates {
        let mut merged = gates.clone();
        for &type_index in &self.shut {
            merged.shut_areas.insert(type_index);
        }
        merged
    }
}
