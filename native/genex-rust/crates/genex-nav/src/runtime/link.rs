//! Animation links: an edge (or point) an agent reaches, then plays an animation or otherwise
//! moves outside the mesh to another edge (jumps, ladders, doors). Other engines call them
//! off-mesh links.
//!
//! Ported from landmass 0.9.3 `src/link.rs`, and `PermittedAnimationLinks` from `src/agent.rs`
//! (MIT OR Apache-2.0, used under Apache 2.0). Changed: ids are [`crate::arena`] keys; the
//! permitted kinds are a `Set` (P1, landmass's P13 in NAV-7's list). NAV-4 ports the data the
//! stitching needs; NAV-7 adds the agent side (reaching and taking links).

use std::sync::Arc;

use genex_core::map::Set;

use super::coords::CoordinateSystem;
use super::nav_data::NodeRef;

crate::arena_key! {
    /// The id of an [`AnimationLink`].
    pub struct AnimationLinkId;
}

/// A link between two edges that an agent takes by some action (an animation).
pub struct AnimationLink<CS: CoordinateSystem> {
    /// The edge the agent must reach to use the link; its order is arbitrary. Both ends equal
    /// make a point.
    pub start_edge: (CS::Coordinate, CS::Coordinate),
    /// The edge the link takes the agent to, in `start_edge`'s order (`start_edge.0` leads to
    /// `end_edge.0`).
    pub end_edge: (CS::Coordinate, CS::Coordinate),
    /// The link's kind: an arbitrary number agents filter on.
    pub kind: usize,
    /// The cost of taking the link.
    pub cost: f32,
    /// Whether the link also goes from `end_edge` to `start_edge`.
    pub bidirectional: bool,
}

impl<CS: CoordinateSystem> Clone for AnimationLink<CS> {
    fn clone(&self) -> Self {
        Self {
            start_edge: self.start_edge.clone(),
            end_edge: self.end_edge.clone(),
            kind: self.kind,
            cost: self.cost,
            bidirectional: self.bidirectional,
        }
    }
}

impl<CS: CoordinateSystem<Coordinate: core::fmt::Debug>> core::fmt::Debug for AnimationLink<CS> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("AnimationLink")
            .field("start_edge", &self.start_edge)
            .field("end_edge", &self.end_edge)
            .field("kind", &self.kind)
            .field("cost", &self.cost)
            .field("bidirectional", &self.bidirectional)
            .finish()
    }
}

/// An animation link and the node portals it attached to.
pub(crate) struct AnimationLinkState<CS: CoordinateSystem> {
    /// The link as the caller gave it.
    pub(crate) main_link: AnimationLink<CS>,
    /// The portals the link can be taken from.
    pub(crate) start_portals: Vec<NodePortal>,
    /// The portals the link leads to.
    pub(crate) end_portals: Vec<NodePortal>,
}

impl<CS: CoordinateSystem> AnimationLinkState<CS> {
    pub(crate) fn new(link: AnimationLink<CS>) -> Self {
        Self { main_link: link, start_portals: Vec::new(), end_portals: Vec::new() }
    }
}

/// The part of a world portal that lies on one node.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct NodePortal {
    /// The node.
    pub(crate) node: NodeRef,
    /// The interval of the world portal on this node, ascending, within [0, 1].
    pub(crate) interval: (f32, f32),
}

/// Which animation links an agent (or a connectivity query) may use.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum PermittedAnimationLinks {
    /// Every animation link.
    #[default]
    All,
    /// Only links whose kind is in the set.
    Kinds(Arc<Set<usize>>),
}

impl PermittedAnimationLinks {
    /// Only the links of these kinds.
    pub fn kinds(kinds: impl IntoIterator<Item = usize>) -> Self {
        Self::Kinds(Arc::new(kinds.into_iter().collect()))
    }

    /// Whether a link of `kind` is permitted.
    pub fn is_permitted(&self, kind: usize) -> bool {
        match self {
            Self::All => true,
            Self::Kinds(kinds) => kinds.contains(&kind),
        }
    }
}
