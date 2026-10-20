//! Nine-slice frames (G6 gameplay UI, UIS-5): a texture cut into corners, edges and a centre by
//! four margins, drawn into any rect with the corners at their own size (in world pixels, so a
//! frame looks the same on a 4K world and a phone-sized one), the edges stretched along one axis
//! and the centre along both. A rect smaller than two margins shrinks the corners in proportion.

/// A nine-slice: `NineSlice::new(texture, [w, h], [l, t, r, b]).paint(ui.painter(), rect)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NineSlice {
    texture: egui::TextureId,
    size: egui::Vec2,
    margins: [f32; 4],
    scale: f32,
    tint: egui::Color32,
}

impl NineSlice {
    /// `texture` of `size` texels, cut `[left, top, right, bottom]` texels from its edges. Margins
    /// are clamped so opposite ones never overlap.
    pub fn new(texture: egui::TextureId, size: [u32; 2], margins: [u32; 4]) -> NineSlice {
        let size = egui::vec2(size[0].max(1) as f32, size[1].max(1) as f32);
        let [left, top, right, bottom] = margins.map(|m| m as f32);
        let (left, right) = fit_pair(left, right, size.x);
        let (top, bottom) = fit_pair(top, bottom, size.y);
        NineSlice { texture, size, margins: [left, top, right, bottom], scale: 1.0, tint: egui::Color32::WHITE }
    }

    /// World pixels per texel for the corners (default 1; a UI scale passes its factor).
    #[must_use]
    pub fn scale(self, scale: f32) -> NineSlice {
        let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
        NineSlice { scale, ..self }
    }

    /// A colour multiplied into the texture (default white).
    #[must_use]
    pub fn tint(self, tint: egui::Color32) -> NineSlice {
        NineSlice { tint, ..self }
    }

    /// The corner sizes in `rect`, `[left, top, right, bottom]` world pixels.
    pub fn corners(&self, rect: egui::Rect) -> [f32; 4] {
        let [left, top, right, bottom] = self.margins.map(|m| m * self.scale);
        let (left, right) = fit_pair(left, right, rect.width());
        let (top, bottom) = fit_pair(top, bottom, rect.height());
        [left, top, right, bottom]
    }

    /// The nine quads covering `rect`.
    pub fn mesh(&self, rect: egui::Rect) -> egui::Mesh {
        let [left, top, right, bottom] = self.corners(rect);
        let xs = [rect.left(), rect.left() + left, rect.right() - right, rect.right()];
        let ys = [rect.top(), rect.top() + top, rect.bottom() - bottom, rect.bottom()];
        let [ml, mt, mr, mb] = self.margins;
        let us = [0.0, ml / self.size.x, 1.0 - mr / self.size.x, 1.0];
        let vs = [0.0, mt / self.size.y, 1.0 - mb / self.size.y, 1.0];
        let mut mesh = egui::Mesh::with_texture(self.texture);
        for row in 0..3 {
            for column in 0..3 {
                let quad = egui::Rect::from_min_max(egui::pos2(xs[column], ys[row]), egui::pos2(xs[column + 1], ys[row + 1]));
                let uv = egui::Rect::from_min_max(egui::pos2(us[column], vs[row]), egui::pos2(us[column + 1], vs[row + 1]));
                if quad.width() > 0.0 && quad.height() > 0.0 {
                    mesh.add_rect_with_uv(quad, uv, self.tint);
                }
            }
        }
        mesh
    }

    /// Paint the frame into `rect`.
    pub fn paint(&self, painter: &egui::Painter, rect: egui::Rect) {
        painter.add(egui::Shape::mesh(self.mesh(rect)));
    }
}

/// Two opposite margins that fit in `length`: unchanged when they do, shrunk in proportion when
/// they do not (never negative, never NaN).
fn fit_pair(first: f32, second: f32, length: f32) -> (f32, f32) {
    let first = if first.is_finite() { first.max(0.0) } else { 0.0 };
    let second = if second.is_finite() { second.max(0.0) } else { 0.0 };
    let length = if length.is_finite() { length.max(0.0) } else { 0.0 };
    let total = first + second;
    if total <= length || total == 0.0 {
        return (first, second);
    }
    let share = length / total;
    (first * share, second * share)
}
