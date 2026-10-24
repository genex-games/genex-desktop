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
//! - R-19 (NAV-18 search budget, the same pops in the same order): the open heap holds only
//!   (key, node index), its key packing the estimate and the cost into one integer that orders as
//!   their two `total_cmp`s do, and looks a node's state up only to break a tie (the order stays
//!   total, so the pops are the same); a popped entry learns whether a cheaper push of its state
//!   followed from the chain of pushes per state instead of a table lookup; and the tables start
//!   with room for `SEARCH_RESERVE` states.

use core::cmp::Ordering;
use core::hash::Hash;

use genex_core::map::FastMap;

/// States a search makes room for up front, so a typical search never regrows its tables.
const SEARCH_RESERVE: usize = 1024;

/// The best estimate per state and the node that was pushed with it (none when the state was only
/// ever offered at an estimate no better than infinity), hashed with genex-core's
/// [`FastHasher`](genex_core::map::FastHasher).
type Estimates<S> = FastMap<S, (f32, Option<usize>)>;

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

/// A pushed node's search bookkeeping, beside the node chain.
struct Pushed {
    /// Cost plus heuristic, as pushed.
    estimate: f32,
    /// The next push of the same state (each is cheaper than the one before), if any.
    next: Option<usize>,
}

/// `value`'s place in [`f32::total_cmp`]'s order as an unsigned integer.
fn total_order_bits(value: f32) -> u32 {
    let bits = value.to_bits();
    // total_cmp flips the magnitude bits of a negative value; the sign bit flip then makes the
    // signed order unsigned.
    let flipped = bits ^ ((((bits as i32) >> 31) as u32) >> 1);
    flipped ^ 0x8000_0000
}

/// The P11 key's first two parts in one integer: lower estimate first, then the larger cost.
fn open_key(estimate: f32, cost: f32) -> u64 {
    (u64::from(total_order_bits(estimate)) << 32) | u64::from(!total_order_bits(cost))
}

/// An open-heap entry: [`open_key`] of the estimate and the cost, and the node's index. The full
/// P11 order (lower estimate first; among equal estimates the deeper node, the larger cost, first;
/// then the state; then the insertion index) is [`Search::before`]. The order is total, so any
/// heap pops the entries in one sequence.
type OpenEntry = (u64, usize);

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
    /// Per node, its estimate and the next push of its state.
    pushed: Vec<Pushed>,
    /// A binary min-heap under [`Search::before`].
    open: Vec<OpenEntry>,
}

impl<P: AStarProblem> Search<P> {
    /// An empty search with room for `SEARCH_RESERVE` states.
    fn new() -> Search<P> {
        Search {
            best_estimates: Estimates::with_capacity_and_hasher(SEARCH_RESERVE, Default::default()),
            nodes: Vec::with_capacity(SEARCH_RESERVE),
            pushed: Vec::with_capacity(SEARCH_RESERVE),
            open: Vec::with_capacity(SEARCH_RESERVE),
        }
    }

    /// Whether entry `a` pops before entry `b` (the P11 order).
    fn before(&self, a: OpenEntry, b: OpenEntry) -> bool {
        let order = a.0.cmp(&b.0).then_with(|| self.nodes[a.1].state.cmp(&self.nodes[b.1].state)).then_with(|| a.1.cmp(&b.1));
        order == Ordering::Less
    }

    /// Pushes `entry` onto the open heap (its node is already in `nodes`).
    fn push_open(&mut self, entry: OpenEntry) {
        let mut at = self.open.len();
        self.open.push(entry);
        while at > 0 {
            let parent = (at - 1) / 2;
            if !self.before(entry, self.open[parent]) {
                break;
            }
            self.open[at] = self.open[parent];
            at = parent;
        }
        self.open[at] = entry;
    }

    /// Pops the open heap's first entry.
    fn pop_open(&mut self) -> Option<OpenEntry> {
        let last = self.open.pop()?;
        let Some(&first) = self.open.first() else {
            return Some(last);
        };
        let len = self.open.len();
        let mut at = 0;
        loop {
            let left = 2 * at + 1;
            if left >= len {
                break;
            }
            let right = left + 1;
            let child = if right < len && self.before(self.open[right], self.open[left]) { right } else { left };
            if !self.before(self.open[child], last) {
                break;
            }
            self.open[at] = self.open[child];
            at = child;
        }
        self.open[at] = last;
        Some(first)
    }

    fn try_add(&mut self, problem: &P, node: Node<P>) {
        let estimate = node.cost + problem.heuristic(&node.state);
        let (best, latest) = self.best_estimates.entry(node.state.clone()).or_insert((f32::INFINITY, None));
        if *best <= estimate {
            return;
        }
        *best = estimate;
        let index = self.nodes.len();
        if let Some(previous) = latest.replace(index) {
            self.pushed[previous].next = Some(index);
        }
        let key = open_key(estimate, node.cost);
        self.nodes.push(node);
        self.pushed.push(Pushed { estimate, next: None });
        self.push_open((key, index));
    }

    /// Whether a push of `index`'s state after it holds a better estimate: the state's best (its
    /// last push) is below `index`'s estimate, as the table would say.
    fn superseded(&self, index: usize) -> bool {
        let estimate = self.pushed[index].estimate;
        let mut last = index;
        while let Some(next) = self.pushed[last].next {
            last = next;
        }
        self.pushed[last].estimate < estimate
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
    let mut search = Search::<P>::new();
    let mut successors: Vec<Successor<P>> = Vec::new();
    search.try_add(problem, Node { cost: 0.0, state: problem.initial_state(), previous_node: None });
    // (heuristic, cost, node index) of the explored node nearest the goal.
    let mut nearest: Option<(f32, f32, usize)> = None;

    while let Some((_, index)) = search.pop_open() {
        // A cheaper path to this state was pushed after this one; it was explored instead.
        if search.superseded(index) {
            continue;
        }
        let node = &search.nodes[index];
        let estimate = search.pushed[index].estimate;
        if stats.explored_nodes >= max_explored {
            stats.capped = true;
            let partial = nearest.map(|(_, _, index)| recover_path(index, &search.nodes));
            return PathResult { stats, path: None, partial };
        }
        stats.explored_nodes += 1;

        if problem.is_goal_state(&node.state) {
            return PathResult { stats, path: Some(recover_path(index, &search.nodes)), partial: None };
        }
        let heuristic = estimate - node.cost;
        let closer = nearest.is_none_or(|(h, c, _)| heuristic.total_cmp(&h).then(node.cost.total_cmp(&c)) == Ordering::Less);
        if closer {
            nearest = Some((heuristic, node.cost, index));
        }

        let current_cost = node.cost;
        let state = node.state.clone();
        successors.clear();
        problem.successors(&state, &mut successors);
        for (action_cost, action, next) in successors.drain(..) {
            let next_node = Node { cost: current_cost + action_cost, state: next, previous_node: Some((index, action)) };
            search.try_add(problem, next_node);
        }
    }

    PathResult { stats, path: None, partial: None }
}

#[cfg(test)]
#[path = "astar_test.rs"]
mod test;
