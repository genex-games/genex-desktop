//! landmass 0.9.3's `src/astar_test.rs` (MIT OR Apache-2.0, used under Apache 2.0), unchanged
//! but for the 4-space indent and the state type's `Ord` (P11 breaks heap ties by state), plus
//! rows for P11 (successor order never changes the result) and P12 (the node cap).

use super::{AStarProblem, find_path, find_path_capped, open_key};

struct AdjacencyListProblemState {
    adjacency: Vec<(f32, i32, usize)>,
    heuristic: f32,
}

struct AdjacencyListProblem {
    states: Vec<AdjacencyListProblemState>,
    start: usize,
    end: usize,
}

impl AStarProblem for AdjacencyListProblem {
    type ActionType = i32;
    type StateType = usize;

    fn initial_state(&self) -> Self::StateType {
        self.start
    }

    fn successors(&self, state: &Self::StateType, out: &mut Vec<(f32, Self::ActionType, Self::StateType)>) {
        out.extend_from_slice(&self.states[*state].adjacency);
    }

    fn heuristic(&self, state: &Self::StateType) -> f32 {
        self.states[*state].heuristic
    }

    fn is_goal_state(&self, state: &Self::StateType) -> bool {
        *state == self.end
    }
}

#[test]
fn finds_simple_path_no_heuristic() {
    let problem = AdjacencyListProblem {
        start: 0,
        end: 1,
        states: vec![
            AdjacencyListProblemState {
                adjacency: vec![(10.0, 1, 1), (3.0, 2, 2)],
                heuristic: 0.0,
            },
            AdjacencyListProblemState {
                adjacency: vec![(10.0, 3, 0), (3.0, 4, 2)],
                heuristic: 0.0,
            },
            AdjacencyListProblemState {
                adjacency: vec![(4.0, 5, 1), (3.0, 6, 0)],
                heuristic: 0.0,
            },
        ],
    };

    let result = find_path(&problem);
    assert_eq!(result.path, Some(vec![2, 5]));
    assert_eq!(result.stats.explored_nodes, 3);
}

#[test]
fn finds_no_path() {
    let problem = AdjacencyListProblem {
        start: 0,
        // This state doesn't exist, so a path can't be found!
        end: 3,
        states: vec![
            AdjacencyListProblemState {
                adjacency: vec![(10.0, 1, 1), (3.0, 2, 2)],
                heuristic: 0.0,
            },
            AdjacencyListProblemState {
                adjacency: vec![(10.0, 3, 0), (3.0, 4, 2)],
                heuristic: 0.0,
            },
            AdjacencyListProblemState {
                adjacency: vec![(4.0, 5, 1), (3.0, 6, 0)],
                heuristic: 0.0,
            },
        ],
    };

    let result = find_path(&problem);
    assert!(result.path.is_none());
    assert_eq!(result.stats.explored_nodes, 3);
}

#[test]
fn grid_no_heuristic() {
    const WIDTH: usize = 5;

    let mut problem = AdjacencyListProblem {
        start: 0,
        end: WIDTH * WIDTH - 1,
        states: Vec::with_capacity(WIDTH * WIDTH),
    };

    for y in 0..WIDTH {
        for x in 0..WIDTH {
            let mut state = AdjacencyListProblemState {
                heuristic: 0.0,
                adjacency: Vec::with_capacity(4),
            };

            let state_index = problem.states.len();
            if x > 0 {
                state.adjacency.push((1.0, 1, state_index - 1));
            }
            if x < WIDTH - 1 {
                state.adjacency.push((1.0, 2, state_index + 1));
            }
            if y > 0 {
                state.adjacency.push((1.0, 3, state_index - WIDTH));
            }
            if y < WIDTH - 1 {
                state.adjacency.push((1.0, 4, state_index + WIDTH));
            }

            problem.states.push(state);
        }
    }

    let result = find_path(&problem);
    let direction_sums = result.path.expect("Path should be found.").iter().fold(
        (0, 0, 0, 0),
        |mut acc, elem| {
            match elem {
                1 => acc.0 += 1,
                2 => acc.1 += 1,
                3 => acc.2 += 1,
                4 => acc.3 += 1,
                _ => panic!("Invalid direction: {}", elem),
            };
            acc
        },
    );
    assert_eq!(direction_sums, (0, 4, 0, 4));
    // All paths look equally good, so all of them must be explored to ensure we
    // get the optimal path.
    assert_eq!(result.stats.explored_nodes, (WIDTH * WIDTH) as u32);
}

#[test]
fn grid_perfect_heuristic() {
    const WIDTH: usize = 5;

    let mut problem = AdjacencyListProblem {
        start: 0,
        end: WIDTH * WIDTH - 1,
        states: Vec::with_capacity(WIDTH * WIDTH),
    };

    for y in 0..WIDTH {
        for x in 0..WIDTH {
            let mut state = AdjacencyListProblemState {
                heuristic: (WIDTH * 2 - (x + y) - 2) as f32,
                adjacency: Vec::with_capacity(4),
            };

            let state_index = problem.states.len();
            if x > 0 {
                state.adjacency.push((1.0, 1, state_index - 1));
            }
            if x < WIDTH - 1 {
                state.adjacency.push((1.0, 2, state_index + 1));
            }
            if y > 0 {
                state.adjacency.push((1.0, 3, state_index - WIDTH));
            }
            if y < WIDTH - 1 {
                state.adjacency.push((1.0, 4, state_index + WIDTH));
            }

            problem.states.push(state);
        }
    }

    let result = find_path(&problem);
    // Flipped from upstream's [4, 4, 4, 4, 2, 2, 2, 2] (P11): every optimal path ties, and the
    // tie goes to the smaller state (right, state 1, before down, state 5), never to heap memory.
    assert_eq!(result.path, Some(vec![2, 2, 2, 2, 4, 4, 4, 4]));
    // Every step towards the bottom right is the optimal path, so we should
    // only explore one path.
    assert_eq!(result.stats.explored_nodes, (WIDTH * 2 - 1) as u32);
}

#[test]
fn dead_end_wrong_heuristic() {
    let problem = AdjacencyListProblem {
        start: 0,
        end: 3,
        states: vec![
            AdjacencyListProblemState {
                adjacency: vec![(1.0, 1, 1), (2.0, 3, 2)],
                heuristic: 3.0,
            },
            AdjacencyListProblemState {
                adjacency: vec![(1.0, 2, 0)],
                heuristic: 1.0,
            },
            AdjacencyListProblemState {
                adjacency: vec![(1.0, 4, 0), (1.0, 1, 3)],
                heuristic: 1.0,
            },
            AdjacencyListProblemState {
                adjacency: vec![(1.0, 2, 2)],
                heuristic: 0.0,
            },
        ],
    };

    let path = find_path(&problem);
    assert_eq!(path.path, Some(vec![3, 1]));
    // The dead end was explored, found to be a dead end, and then a new path
    // was found.
    assert_eq!(path.stats.explored_nodes, 4);
}

/// A `width` × `width` grid with unit steps and no heuristic, its adjacency listed in `order`.
fn open_grid(width: usize, reversed: bool) -> AdjacencyListProblem {
    let mut problem = AdjacencyListProblem { start: 0, end: width * width - 1, states: Vec::with_capacity(width * width) };
    for y in 0..width {
        for x in 0..width {
            let index = problem.states.len();
            let mut adjacency = Vec::with_capacity(4);
            if x > 0 {
                adjacency.push((1.0, 1, index - 1));
            }
            if x < width - 1 {
                adjacency.push((1.0, 2, index + 1));
            }
            if y > 0 {
                adjacency.push((1.0, 3, index - width));
            }
            if y < width - 1 {
                adjacency.push((1.0, 4, index + width));
            }
            if reversed {
                adjacency.reverse();
            }
            problem.states.push(AdjacencyListProblemState { adjacency, heuristic: 0.0 });
        }
    }
    problem
}

#[test]
fn successor_order_never_changes_the_path_or_the_work() {
    // P11: a successor list in another order (a per-process hash order upstream) yields the same
    // path among equally good ones, with the same expansions.
    let forward = find_path(&open_grid(7, false));
    let reversed = find_path(&open_grid(7, true));
    assert_eq!(forward.path, reversed.path);
    assert_eq!(forward.stats, reversed.stats);
}

#[test]
fn a_capped_search_stops_at_the_cap_with_a_partial_path() {
    // P12: 10 expansions on a 7 × 7 grid stop the search; it hands back a partial path (with no
    // heuristic every state ties, so the cheapest explored state, the start, is the nearest).
    let problem = open_grid(7, false);
    let result = find_path_capped(&problem, 10);
    assert!(result.path.is_none());
    assert!(result.stats.capped);
    assert_eq!(result.stats.explored_nodes, 10);
    assert!(result.partial.is_some());
    // With room to finish, the same search is not capped.
    let full = find_path_capped(&problem, 1000);
    assert!(!full.stats.capped);
    assert_eq!(full.path, find_path(&problem).path);
}

#[test]
fn a_capped_search_heads_toward_the_goal() {
    // With a perfect heuristic the partial path is the optimal path's prefix.
    let mut problem = open_grid(5, false);
    for (index, state) in problem.states.iter_mut().enumerate() {
        let (x, y) = (index % 5, index / 5);
        state.heuristic = (8 - x - y) as f32;
    }
    let result = find_path_capped(&problem, 4);
    let partial = result.partial.expect("a partial path");
    assert_eq!(partial.len(), 3, "4 expansions reach depth 3 along the optimal path");
    let full = find_path(&problem).path.expect("a path");
    assert_eq!(partial[..], full[..3]);
}

/// The search as it stood before R-19 (`std` `BinaryHeap` of full entries ordered by two
/// `total_cmp`s, the state and the index; a table lookup on every pop), kept as the oracle the
/// faster search must match pop for pop.
mod before_r19 {
    use core::cmp::{Ordering, Reverse};
    use std::collections::BinaryHeap;

    use genex_core::map::FastMap;

    use super::super::{AStarProblem, PathResult, PathStats};

    struct Node<P: AStarProblem> {
        cost: f32,
        state: P::StateType,
        previous_node: Option<(usize, P::ActionType)>,
    }

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
            self.estimate
                .total_cmp(&other.estimate)
                .then_with(|| other.cost.total_cmp(&self.cost))
                .then_with(|| self.state.cmp(&other.state))
                .then_with(|| self.index.cmp(&other.index))
        }
    }

    fn recover<P: AStarProblem>(index: usize, nodes: &[Node<P>]) -> Vec<P::ActionType> {
        let mut path = Vec::new();
        let mut node_index = index;
        while let Some((previous, action)) = &nodes[node_index].previous_node {
            path.push(action.clone());
            node_index = *previous;
        }
        path.reverse();
        path
    }

    fn try_add<P: AStarProblem>(problem: &P, best: &mut FastMap<P::StateType, f32>, nodes: &mut Vec<Node<P>>, open: &mut BinaryHeap<Reverse<OpenEntry<P::StateType>>>, node: Node<P>) {
        let estimate = node.cost + problem.heuristic(&node.state);
        let entry = best.entry(node.state.clone()).or_insert(f32::INFINITY);
        if *entry <= estimate {
            return;
        }
        *entry = estimate;
        let index = nodes.len();
        open.push(Reverse(OpenEntry { estimate, cost: node.cost, state: node.state.clone(), index }));
        nodes.push(node);
    }

    pub(super) fn find_path_capped<P: AStarProblem>(problem: &P, max_explored: u32) -> PathResult<P::ActionType> {
        let mut stats = PathStats { explored_nodes: 0, capped: false };
        let mut best: FastMap<P::StateType, f32> = FastMap::default();
        let mut nodes: Vec<Node<P>> = Vec::new();
        let mut open = BinaryHeap::new();
        let mut successors = Vec::new();
        try_add(problem, &mut best, &mut nodes, &mut open, Node { cost: 0.0, state: problem.initial_state(), previous_node: None });
        let mut nearest: Option<(f32, f32, usize)> = None;
        while let Some(Reverse(entry)) = open.pop() {
            let node = &nodes[entry.index];
            if best.get(&node.state).is_some_and(|b| *b < entry.estimate) {
                continue;
            }
            if stats.explored_nodes >= max_explored {
                stats.capped = true;
                let partial = nearest.map(|(_, _, index)| recover(index, &nodes));
                return PathResult { stats, path: None, partial };
            }
            stats.explored_nodes += 1;
            if problem.is_goal_state(&node.state) {
                return PathResult { stats, path: Some(recover(entry.index, &nodes)), partial: None };
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
                try_add(problem, &mut best, &mut nodes, &mut open, Node { cost: current_cost + action_cost, state: next, previous_node: Some((entry.index, action)) });
            }
        }
        PathResult { stats, path: None, partial: None }
    }
}

/// A seeded random graph: `states` states, a few edges each, costs and heuristics drawn from a
/// handful of values so estimates tie often (the tie rule is what the oracle row must cover).
fn random_problem(seed: u64, states: usize) -> AdjacencyListProblem {
    let mut rng = genex_core::rng::Pcg32::seeded(seed);
    let mut problem = AdjacencyListProblem { states: Vec::with_capacity(states), start: 0, end: states - 1 };
    for state in 0..states {
        let edges = 1 + rng.below(4) as usize;
        let adjacency = (0..edges)
            .map(|action| {
                let next = rng.below(states as u32) as usize;
                let cost = [0.5, 1.0, 1.0, 2.0, 0.25][rng.below(5) as usize];
                (cost, (state * 8 + action) as i32, next)
            })
            .collect();
        let heuristic = [0.0, 0.5, 1.0][rng.below(3) as usize];
        problem.states.push(AdjacencyListProblemState { adjacency, heuristic: if state == states - 1 { 0.0 } else { heuristic } });
    }
    problem
}

#[test]
fn r19_search_pops_exactly_as_the_search_before_it() {
    // R-19: the packed key, the index heap and the push chains are a faster form of one order;
    // over many tie-heavy graphs and node caps, the path, the partial path and the work equal
    // the earlier search's.
    for seed in 1..=300u64 {
        let problem = random_problem(seed, 4 + (seed % 60) as usize);
        for cap in [1, 3, 8, 25, u32::MAX] {
            let now = find_path_capped(&problem, cap);
            let before = before_r19::find_path_capped(&problem, cap);
            assert_eq!((now.path, now.partial, now.stats), (before.path, before.partial, before.stats), "seed {seed} cap {cap}");
        }
    }
}

#[test]
fn the_open_key_orders_as_the_two_total_cmps() {
    // Lower estimate first, then the larger cost: over signed zeros, infinities, NaNs and
    // neighbouring floats, the packed key's order is the P11 order of its two parts.
    let values = [f32::NEG_INFINITY, -2.5, -1.0, -f32::MIN_POSITIVE, -0.0, 0.0, f32::MIN_POSITIVE, 1.0, 1.0 + f32::EPSILON, 2.5, f32::MAX, f32::INFINITY, f32::NAN, -f32::NAN];
    for &estimate_a in &values {
        for &cost_a in &values {
            for &estimate_b in &values {
                for &cost_b in &values {
                    let expected = estimate_a.total_cmp(&estimate_b).then_with(|| cost_b.total_cmp(&cost_a));
                    assert_eq!(open_key(estimate_a, cost_a).cmp(&open_key(estimate_b, cost_b)), expected, "({estimate_a}, {cost_a}) vs ({estimate_b}, {cost_b})");
                }
            }
        }
    }
}
