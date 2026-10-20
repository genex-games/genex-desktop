// Ported from rerecast v0.5.0 `crates/rerecast/src/region.rs` (MIT OR Apache-2.0, used under MIT;
// by Jan Hohenheim and contributors), itself a port of Recast (Zlib); an altered version of both. Changed: `RegionId`'s `bitflags` impl is written out: the `flag_set!` macro gives the bitflags 2 operations the stages use.
// The R-numbered changes are listed in `mod.rs` and `N/PORTS.md`.

use core::ops::{Add, AddAssign};

/// A region in a [`CompactHeightfield`](super::compact_heightfield::CompactHeightfield).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(transparent)]
pub struct RegionId(u16);

/// The `bitflags` 2 operations the stages use on a flag newtype `$name($bits)` whose known bits
/// are `$known`, written out (the port takes no `bitflags` dependency): `|` and `&` keep every
/// bit (`union`, `intersection`), `!` keeps only the known bits (`complement`), `contains` and
/// `intersects` read as bitflags reads them.
macro_rules! flag_set {
    ($name:ident, $bits:ty, $known:expr) => {
        impl $name {
            /// The raw bits.
            #[inline]
            pub const fn bits(&self) -> $bits {
                self.0
            }

            /// The value of `bits`, unknown bits kept.
            #[inline]
            pub const fn from_bits_retain(bits: $bits) -> Self {
                Self(bits)
            }

            /// Whether every bit of `other` is set here.
            #[inline]
            pub const fn contains(&self, other: Self) -> bool {
                self.0 & other.0 == other.0
            }

            /// Whether any bit of `other` is set here.
            #[inline]
            pub const fn intersects(&self, other: Self) -> bool {
                self.0 & other.0 != 0
            }
        }

        impl core::ops::BitOr for $name {
            type Output = Self;
            #[inline]
            fn bitor(self, other: Self) -> Self {
                Self(self.0 | other.0)
            }
        }

        impl core::ops::BitOrAssign for $name {
            #[inline]
            fn bitor_assign(&mut self, other: Self) {
                self.0 |= other.0;
            }
        }

        impl core::ops::BitAnd for $name {
            type Output = Self;
            #[inline]
            fn bitand(self, other: Self) -> Self {
                Self(self.0 & other.0)
            }
        }

        impl core::ops::BitAndAssign for $name {
            #[inline]
            fn bitand_assign(&mut self, other: Self) {
                self.0 &= other.0;
            }
        }

        impl core::ops::Not for $name {
            type Output = Self;
            #[inline]
            fn not(self) -> Self {
                Self(!self.0 & $known)
            }
        }
    };
}
pub(crate) use flag_set;

impl RegionId {
    /// The default region, which is used for spans that are not in a region, i.e. not walkable.
    pub const NONE: Self = Self(0);
    /// Heightfield border flag.
    /// If a heightfield region ID has this bit set, then the region is a border
    /// region and its spans are considered un-walkable.
    /// (Used during the region and contour build process.)
    pub const BORDER_REGION: Self = Self(0x8000);
    /// The maximum region ID.
    pub const MAX: Self = Self(u16::MAX);
}

flag_set!(RegionId, u16, u16::MAX);

impl Add<u16> for RegionId {
    type Output = Self;
    fn add(self, other: u16) -> Self::Output {
        RegionId::from(self.bits() + other)
    }
}

impl AddAssign<u16> for RegionId {
    fn add_assign(&mut self, other: u16) {
        *self = RegionId::from(self.bits() + other);
    }
}

impl Default for RegionId {
    fn default() -> Self {
        Self::NONE
    }
}

impl From<u16> for RegionId {
    fn from(value: u16) -> Self {
        RegionId::from_bits_retain(value)
    }
}
