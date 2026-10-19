//! A union-find (disjoint set) over dense `usize` elements, in place of the `disjoint` crate
//! (landmass's P4). Union by rank with path halving; the root a join picks depends only on the
//! calls made, so region numbers are the same on every run.
//!
//! Written for genex from the textbook algorithm (Tarjan); the API mirrors the subset of
//! `disjoint::DisjointSet` 0.8 (MIT OR Apache-2.0) landmass calls. `root_of` takes `&self` and
//! does not compress, so a shared borrow answers queries (landmass wrapped the set in a `Mutex`
//! for that; P5 drops it).

/// Disjoint sets of the elements `0..len()`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DisjointSet {
    parent: Vec<usize>,
    rank: Vec<u8>,
}

impl DisjointSet {
    /// An empty set of sets.
    pub const fn new() -> Self {
        Self { parent: Vec::new(), rank: Vec::new() }
    }

    /// `len` singletons, `0..len`.
    pub fn with_len(len: usize) -> Self {
        Self { parent: (0..len).collect(), rank: vec![0; len] }
    }

    /// The number of elements.
    pub fn len(&self) -> usize {
        self.parent.len()
    }

    /// Whether there are no elements.
    pub fn is_empty(&self) -> bool {
        self.parent.is_empty()
    }

    /// Adds one element in a set of its own and returns it.
    pub fn add_singleton(&mut self) -> usize {
        let element = self.parent.len();
        self.parent.push(element);
        self.rank.push(0);
        element
    }

    /// Removes every element.
    pub fn clear(&mut self) {
        self.parent.clear();
        self.rank.clear();
    }

    /// The representative of `element`'s set.
    ///
    /// # Panics
    ///
    /// When `element` is not below `len()`.
    pub fn root_of(&self, element: usize) -> usize {
        let mut current = element;
        while self.parent[current] != current {
            current = self.parent[current];
        }
        current
    }

    fn find_halving(&mut self, element: usize) -> usize {
        let mut current = element;
        while self.parent[current] != current {
            let grandparent = self.parent[self.parent[current]];
            self.parent[current] = grandparent;
            current = grandparent;
        }
        current
    }

    /// Whether `a` and `b` are in one set.
    pub fn is_joined(&self, a: usize, b: usize) -> bool {
        self.root_of(a) == self.root_of(b)
    }

    /// Merges the sets of `a` and `b`; returns whether they were apart.
    pub fn join(&mut self, a: usize, b: usize) -> bool {
        let (root_a, root_b) = (self.find_halving(a), self.find_halving(b));
        if root_a == root_b {
            return false;
        }
        let (high, low) = if self.rank[root_a] >= self.rank[root_b] { (root_a, root_b) } else { (root_b, root_a) };
        self.parent[low] = high;
        if self.rank[high] == self.rank[low] {
            self.rank[high] = self.rank[high].saturating_add(1);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::DisjointSet;

    #[test]
    fn joins_are_transitive_and_singletons_stay_apart() {
        let mut set = DisjointSet::with_len(5);
        assert!(set.join(0, 1));
        assert!(set.join(3, 1));
        assert!(!set.join(0, 3));
        assert!(set.is_joined(0, 3));
        assert!(!set.is_joined(0, 2));
        let extra = set.add_singleton();
        assert_eq!(extra, 5);
        assert!(!set.is_joined(extra, 4));
        set.clear();
        assert!(set.is_empty());
    }

    #[test]
    fn the_root_depends_only_on_the_calls() {
        let build = || {
            let mut set = DisjointSet::with_len(8);
            for (a, b) in [(1, 2), (3, 4), (2, 4), (6, 7), (0, 7), (5, 0)] {
                set.join(a, b);
            }
            (0..8).map(|e| set.root_of(e)).collect::<Vec<_>>()
        };
        assert_eq!(build(), build());
    }
}
