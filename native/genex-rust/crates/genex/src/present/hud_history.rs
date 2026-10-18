//! The HUD textures a painter on a re-created device receives first (review F10): one image per
//! live texture. epaint's own `append` already lets a whole-image set replace the earlier ones and
//! a free drop them, but a patch (`ImageDelta::pos`: the font atlas growing a glyph, a game's
//! `TextureHandle::set_partial`) was appended after its base every frame, so a game patching an
//! image each tick grew the history without bound (and a recovery uploaded all of it). Patches are
//! folded into their base image here instead.

use genex_hud::egui::epaint::textures::TexturesDelta;
use genex_hud::egui::epaint::{ImageData, ImageDelta, TextureId};
use std::sync::Arc;

/// Add a frame's `fresh` texture changes to `history`: a whole image replaces the texture's
/// entries, a patch is folded into the texture's whole image (kept as it came without one), and a
/// freed texture leaves the history. No free is kept: a replay only sets.
pub(super) fn record(history: &mut TexturesDelta, mut fresh: TexturesDelta) {
    #[expect(clippy::iter_over_hash_type, reason = "each texture's deltas are folded on their own; the order between textures does not matter")]
    for (id, deltas) in fresh.set.drain() {
        for delta in deltas {
            fold(history, id, delta);
        }
    }
    #[expect(clippy::iter_over_hash_type, reason = "removing each freed texture; the order does not matter")]
    for id in fresh.free.drain() {
        history.set.remove(&id);
    }
    history.free.clear();
}

/// `delta` for texture `id` into `history`.
fn fold(history: &mut TexturesDelta, id: TextureId, delta: ImageDelta) {
    let Some(pos) = delta.pos else {
        history.set.insert(id, std::iter::once(delta).collect());
        return;
    };
    let base = history.set.get_mut(&id).and_then(|deltas| match deltas.as_mut_slice() {
        [base] if base.pos.is_none() => Some(base),
        _ => None,
    });
    match base {
        Some(base) => patch_into(base, pos, &delta.image),
        None => history.set.entry(id).or_default().push(delta),
    }
}

/// Copy `patch` into `base`'s whole image at `pos`, clipped to the image.
fn patch_into(base: &mut ImageDelta, [x, y]: [usize; 2], patch: &ImageData) {
    let (ImageData::Color(image), ImageData::Color(patch)) = (&mut base.image, patch);
    let image = Arc::make_mut(image);
    let [width, height] = image.size;
    let [patch_width, patch_height] = patch.size;
    let columns = patch_width.min(width.saturating_sub(x));
    for row in 0..patch_height.min(height.saturating_sub(y)) {
        let to = (y + row) * width + x;
        let from = row * patch_width;
        image.pixels[to..to + columns].copy_from_slice(&patch.pixels[from..from + columns]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genex_hud::egui::epaint::{Color32, ColorImage, ImageDelta, TextureId, textures::TextureOptions};

    fn image(side: usize, shade: u8) -> ColorImage {
        ColorImage::new([side, side], vec![Color32::from_gray(shade); side * side])
    }

    fn whole(side: usize, shade: u8) -> ImageDelta {
        ImageDelta::full(image(side, shade), TextureOptions::LINEAR)
    }

    fn patch(at: [usize; 2], side: usize, shade: u8) -> ImageDelta {
        ImageDelta::partial(at, image(side, shade), TextureOptions::LINEAR)
    }

    fn frame(changes: Vec<(TextureId, ImageDelta)>, frees: &[TextureId]) -> TexturesDelta {
        let mut delta = TexturesDelta::default();
        for (id, change) in changes {
            delta.push(id, change);
        }
        for id in frees {
            delta.free(*id);
        }
        delta
    }

    /// A history cleared when the row ends, passed or not (epaint asserts a dropped delta was applied).
    struct History(TexturesDelta);

    impl Drop for History {
        fn drop(&mut self) {
            self.0.clear();
        }
    }

    /// Texels the history holds, over every delta of every texture.
    fn texels(history: &TexturesDelta) -> usize {
        history.set.values().flatten().map(|delta| delta.image.width() * delta.image.height()).sum()
    }

    fn pixel(history: &TexturesDelta, id: TextureId, at: (usize, usize)) -> Option<Color32> {
        let deltas = history.set.get(&id)?;
        let [only] = deltas.as_slice() else { return None };
        let genex_hud::egui::epaint::ImageData::Color(image) = &only.image;
        Some(image[at])
    }

    /// A game that updates an egui image every tick (a minimap) or patches one (a portrait's
    /// corner): the history stays at the live textures' size, never the sum of every update.
    #[test]
    fn the_history_holds_each_live_texture_once_however_often_it_changes() {
        let atlas = TextureId::Managed(0);
        let minimap = TextureId::Managed(1);
        let portrait = TextureId::Managed(2);
        let mut kept = History(TexturesDelta::default());
        let history = &mut kept.0;
        record(history, frame(vec![(atlas, whole(64, 0)), (portrait, whole(32, 0))], &[]));
        for tick in 0..600_u32 {
            let shade = (tick % 250) as u8 + 1;
            let changes = vec![(minimap, whole(16, shade)), (portrait, patch([4, 4], 8, shade)), (atlas, patch([8, 0], 4, shade))];
            record(history, frame(changes, &[]));
        }
        assert_eq!(texels(history), 64 * 64 + 16 * 16 + 32 * 32, "one image per live texture");
        assert_eq!(pixel(history, portrait, (5, 5)), Some(Color32::from_gray(100)), "the last patch (tick 599) is folded in");
        assert_eq!(pixel(history, portrait, (0, 0)), Some(Color32::from_gray(0)), "outside the patch the base stays");
        assert_eq!(pixel(history, atlas, (9, 1)), Some(Color32::from_gray(100)));
        record(history, frame(Vec::new(), &[minimap]));
        assert!(!history.set.contains_key(&minimap), "a freed texture leaves the history");
        assert!(history.free.is_empty(), "frees are applied, never replayed");
    }

    /// A patch whose base the history never saw stays a patch (the painter's own rule decides).
    #[test]
    fn a_patch_without_its_base_is_kept_as_it_came() {
        let id = TextureId::Managed(7);
        let mut kept = History(TexturesDelta::default());
        record(&mut kept.0, frame(vec![(id, patch([0, 0], 4, 9))], &[]));
        assert_eq!(kept.0.set.get(&id).map(|deltas| deltas.len()), Some(1));
    }

    /// Hostile patches: past the image's edge they are clipped, wholly outside they change nothing.
    #[test]
    fn a_patch_past_the_edge_is_clipped() {
        let id = TextureId::Managed(3);
        let mut kept = History(TexturesDelta::default());
        record(&mut kept.0, frame(vec![(id, whole(8, 0))], &[]));
        record(&mut kept.0, frame(vec![(id, patch([6, 6], 4, 7)), (id, patch([100, 100], 4, 9))], &[]));
        assert_eq!(texels(&kept.0), 64);
        assert_eq!(pixel(&kept.0, id, (7, 7)), Some(Color32::from_gray(7)));
        assert_eq!(pixel(&kept.0, id, (5, 5)), Some(Color32::from_gray(0)));
    }
}
