//! A generic A* search with a node cap.
//!
//! Ported from landmass 0.9.3 `src/astar.rs` (MIT OR Apache-2.0, used under Apache 2.0; crates.io
//! sha256 `fd2fd988b81194c6f02c293a28b510b44f1d8581c80b1bfe498e85e9c3f57b93`). Changed (NAV-7):
//! - P1: the best-estimate table is a `Map`, not a std `HashMap`.
//! - P11: the open heap orders by (estimate, deeper cost first, state, insertion index) with
//!   `total_cmp`, so ties never depend on the order successors were pushed in (upstream compared
//!   estimates only, and its tie rule compared one node's cost with the other's estimate). A
//!   successor list built from a per-process hash order therefore still yields the same path.
//! - P12: [`find_path_capped`] stops after `max_explored` expansions and hands back the path to
//!   the explored node closest to the goal by its heuristic (Detour's `DT_PARTIAL_RESULT`), so a
//!   search costs at most that many expansions however large the mesh is.
//! - GE (NAV-18 search budget): the best-estimate table is a `FastMap` (genex-core's fixed-seed
//!   Fx-style hash) instead of a SipHash `Map`, and successors are written into one buffer the
//!   search reuses instead of a new `Vec` per expansion. The table is only looked up, never
//!   iterated, so the hash cannot change a path.

use core::cmp::{Ordering, Reverse};
use core::hash::Hash;
use std::collections::BinaryHeap;

use genex_core::map::FastMap;

/// The best estimate per state, hashed with genex-core's [`FastHasher`](genex_core::map::FastHasher).
type Estimates<S> = FastMap<S, f32>;

/// A successor: the action's cost, the action, and the state it leads to.
pub(crate) type Successor<P> = (f32, <P as AStarProblem>::ActionType, <P as AStarProblem>::StateType);

/// A generic A* problem.
pub(crate) trait AStarProblem {
    /// The action that moves between states.
    type ActionType: Clone;
    /// The state the search walks. `Ord` breaks heap ties, so the search never depends on memory.
    type StateType: Hash + Eq + Ord + Clone;

    /// The initial state.
    fn initial_state(&self) -> Self::StateType;

    /// Every state one action from `state`, appended to `out` (empty on entry): the action's
    /// cost, the action, and the state.
    fn successors(&self, state: &Self::StateType, out: &mut Vec<(f32, Self::ActionType, Self::StateType)>);

    /// An estimate of the cost from `state` to a goal: never negative, 0 at a goal.
    fn heuristic(&self, state: &Self::StateType) -> f32;

    /// Whether `state` is a goal.
    fn is_goal_state(&self, state: &Self::StateType) -> bool;
}

/// A path as a chain of nodes: each knows the node it came from and the action taken.
struct Node<P: AStarProblem> {
    cost: f32,
    state: P::StateType,
    previous_node: Option<(usize, P::ActionType)>,
}

/// An open-heap entry. `Ord` is the P11 key; the heap holds `Reverse` entries so the smallest
/// key pops first.
struct OpenEntry<S> {
    estimate: f32,
    cost: f32,
    state: S,
    index: usize,
}

impl<S: Ord> PartialEq for OpenEntry<S> {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl<S: Ord> Eq for OpenEntry<S> {}

impl<S: Ord> PartialOrd for OpenEntry<S> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl<S: Ord> Ord for OpenEntry<S> {
    fn cmp(&self, other: &Self) -> Ordering {
        // Lower estimate first; among equal estimates the deeper node (larger cost) first; then
        // the state, then the insertion index, so the order is total.
        self.estimate
            .total_cmp(&other.estimate)
            .then_with(|| other.cost.total_cmp(&self.cost))
            .then_with(|| self.state.cmp(&other.state))
            .then_with(|| self.index.cmp(&other.index))
    }
}

/// The actions that lead to `index`, first action first.
fn recover_path<P: AStarProblem>(index: usize, nodes: &[Node<P>]) -> Vec<P::ActionType> {
    let mut path = Vec::new();
    let mut node_index = index;
    while let Some((previous, action)) = &nodes[node_index].previous_node {
        path.push(action.clone());
        node_index = *previous;
    }
    path.reverse();
    path
}

/// Statistics about a search.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PathStats {
    /// The nodes expanded. Can exceed the state count when the heuristic underestimates.
    pub(crate) explored_nodes: u32,
    /// Whether the search stopped at its node cap before reaching a goal.
    pub(crate) capped: bool,
}

/// The result of a search.
#[derive(Debug)]
pub(crate) struct PathResult<ActionType> {
    /// Statistics about the search.
    pub(crate) stats: PathStats,
    /// The path to a goal, when one was found.
    pub(crate) path: Option<Vec<ActionType>>,
    /// When the search was capped: the path to the explored node with the lowest heuristic
    /// (empty when that is the initial state).
    pub(crate) partial: Option<Vec<ActionType>>,
}

/// The open heap, the node chain and the best estimate per state.
struct Search<P: AStarProblem> {
    best_estimates: Estimates<P::StateType>,
    nodes: Vec<Node<P>>,
    open: BinaryHeap<Reverse<OpenEntry<P::StateType>>>,
}

impl<P: AStarProblem> Search<P> {
    fn try_add(&mut self, problem: &P, node: Node<P>) {
        let estimate = node.cost + problem.heuristic(&node.state);
        let best = self.best_estimates.entry(node.state.clone()).or_insert(f32::INFINITY);
        if *best <= estimate {
            return;
        }
        *best = estimate;
        let index = self.nodes.len();
        self.open.push(Reverse(OpenEntry { estimate, cost: node.cost, state: node.state.clone(), index }));
        self.nodes.push(node);
    }
}

/// Finds a path from the initial state to a goal, with no node cap (upstream's entry point, kept
/// for its converted tests).
#[cfg(test)]
pub(crate) fn find_path<P: AStarProblem>(problem: &P) -> PathResult<P::ActionType> {
    find_path_capped(problem, u32::MAX)
}

/// Finds a path from the initial state to a goal, expanding at most `max_explored` nodes. A
/// capped search returns no path and a partial path to the explored node nearest the goal.
pub(crate) fn find_path_capped<P: AStarProblem>(problem: &P, max_explored: u32) -> PathResult<P::ActionType> {
    let mut stats = PathStats { explored_nodes: 0, capped: false };
    let mut search = Search::<P> { best_estimates: Estimates::default(), nodes: Vec::new(), open: BinaryHeap::new() };
    let mut successors: Vec<Successor<P>> = Vec::new();
    search.try_add(problem, Node { cost: 0.0, state: problem.initial_state(), previous_node: None });
    // (heuristic, cost, node index) of the explored node nearest the goal.
    let mut nearest: Option<(f32, f32, usize)> = None;

    while let Some(Reverse(entry)) = search.open.pop() {
        let node = &search.nodes[entry.index];
        // A cheaper path to this state was pushed after this one; it was explored instead.
        if search.best_estimates.get(&node.state).is_some_and(|best| *best < entry.estimate) {
            continue;
        }
        if stats.explored_nodes >= max_explored {
            stats.capped = true;
            let partial = nearest.map(|(_, _, index)| recover_path(index, &search.nodes));
            return PathResult { stats, path: None, partial };
        }
        stats.explored_nodes += 1;

        if problem.is_goal_state(&node.state) {
            return PathResult { stats, path: Some(recover_path(entry.index, &search.nodes)), partial: None };
        }
        let heuristic = entry.estimate - entry.cost;
        let closer = nearest.is_none_or(|(h, c, _)| heuristic.total_cmp(&h).then(entry.cost.total_cmp(&c)) == Ordering::Less);
        if closer {
            nearest = Some((heuristic, entry.cost, entry.index));
        }

        let current_cost = node.cost;
        let state = node.state.clone();
        successors.clear();
        problem.successors(&state, &mut successors);
        for (action_cost, action, next) in successors.drain(..) {
            let next_node = Node { cost: current_cost + action_cost, state: next, previous_node: Some((entry.index, action)) };
            search.try_add(problem, next_node);
        }
    }

    PathResult { stats, path: None, partial: None }
}

#[cfg(test)]
#[path = "astar_test.rs"]
mod test;
