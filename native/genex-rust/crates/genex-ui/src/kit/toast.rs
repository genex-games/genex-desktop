//! Toasts (G6 gameplay UI, UIS-5): short notices ("Saved", "Achievement") stacked in the top-right
//! corner that slide in, wait and slide out, counted in ticks.
//!
//! A port of egui-notify 0.23 `src/lib.rs` (MIT, Copyright (c) 2022-2023 ItsEthra): the queue, the
//! top-right anchor with its 8 px margin and spacing and 10 px padding, the cubic slide, the
//! countdown that pauses while the pointer is over a toast, dismissing by click and the 4 px
//! progress line. Changed for genex: time is ticks (one per [`Toasts::show`], which the HUD calls
//! once per tick) instead of `stable_dt`, the queue lives in egui memory (so a seed forgets it),
//! the level icons are drawn as shapes and the close cross is dropped (a click anywhere on the
//! toast dismisses it) because the HUD fonts have no such glyphs, the queue is capped, and each
//! toast is labelled and keyed in AccessKit.

use crate::keyed::key_widget;

/// Ticks a toast is shown when the pointer never rests on it, its slides included.
pub const TOAST_TICKS: u32 = 180;
/// Ticks a toast takes to slide in, and to slide out (egui-notify's speed 4 at 60 ticks a second).
pub const TOAST_SLIDE_TICKS: u32 = 15;
/// The most toasts queued; pushing more drops the oldest.
pub const TOASTS_MAX: usize = 8;
/// The longest toast text, in characters; longer text is cut.
pub const TOAST_TEXT_MAX: usize = 120;
/// Distance from the frame's corner, gap between toasts and inner padding, in world pixels.
const MARGIN: egui::Vec2 = egui::vec2(8.0, 8.0);
const SPACING: f32 = 8.0;
const PADDING: egui::Vec2 = egui::vec2(10.0, 10.0);
/// The corner radius, the icon's size and gap, the progress line's height, in world pixels.
const RADIUS: f32 = 4.0;
const ICON_SIZE: f32 = 14.0;
const ICON_GAP: f32 = 8.0;
const PROGRESS_HEIGHT: f32 = 4.0;
/// Where the queue lives in egui memory.
const QUEUE_ID: &str = "genex-ui.toasts";

/// What a toast reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ToastKind {
    /// Neutral news.
    Info,
    /// Something worked.
    Success,
    /// Something needs attention.
    Warning,
    /// Something failed.
    Error,
}

impl ToastKind {
    /// The kind's wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            ToastKind::Info => "info",
            ToastKind::Success => "success",
            ToastKind::Warning => "warning",
            ToastKind::Error => "error",
        }
    }

    fn color(self) -> egui::Color32 {
        match self {
            ToastKind::Info => egui::Color32::from_rgb(90, 160, 255),
            ToastKind::Success => egui::Color32::from_rgb(90, 200, 120),
            ToastKind::Warning => egui::Color32::from_rgb(240, 180, 60),
            ToastKind::Error => egui::Color32::from_rgb(235, 90, 90),
        }
    }
}

/// One queued toast.
#[derive(Clone, Debug, PartialEq)]
struct Toast {
    sequence: u64,
    kind: ToastKind,
    text: String,
    /// Ticks shown so far while not paused.
    age: u32,
    dismissed_at: Option<u32>,
}

impl Toast {
    /// How far in the toast is, 0 (hidden) to 1 (in place).
    fn slide(&self) -> f32 {
        let leaving_from = self.dismissed_at.unwrap_or(TOAST_TICKS - TOAST_SLIDE_TICKS);
        let entering = self.age.min(TOAST_SLIDE_TICKS) as f32 / TOAST_SLIDE_TICKS as f32;
        let leaving = 1.0 - (self.age.saturating_sub(leaving_from)).min(TOAST_SLIDE_TICKS) as f32 / TOAST_SLIDE_TICKS as f32;
        ease(entering.min(leaving))
    }

    fn expired(&self) -> bool {
        let end = self.dismissed_at.map_or(TOAST_TICKS, |at| at + TOAST_SLIDE_TICKS);
        self.age >= end
    }

    /// Whether the idle countdown runs (egui-notify pauses it under the pointer).
    fn idling(&self) -> bool {
        self.dismissed_at.is_none() && (TOAST_SLIDE_TICKS..TOAST_TICKS - TOAST_SLIDE_TICKS).contains(&self.age)
    }
}

/// egui-notify's slide curve, `1 - (1 - x)^3`.
fn ease(x: f32) -> f32 {
    let rest = 1.0 - x.clamp(0.0, 1.0);
    1.0 - rest * rest * rest
}

#[derive(Clone, Debug, Default)]
struct Queue {
    next_sequence: u64,
    toasts: Vec<Toast>,
}

/// The toast queue of a HUD context.
#[derive(Clone, Copy, Debug)]
pub struct Toasts;

impl Toasts {
    /// Queue a toast (keyed `toast.<n>`, `n` counting pushes since the context's start).
    pub fn push(ctx: &egui::Context, kind: ToastKind, text: &str) {
        ctx.data_mut(|data| {
            let queue = data.get_temp_mut_or_default::<Queue>(egui::Id::new(QUEUE_ID));
            if queue.toasts.len() == TOASTS_MAX {
                queue.toasts.remove(0);
            }
            let text: String = text.chars().take(TOAST_TEXT_MAX).collect();
            queue.toasts.push(Toast { sequence: queue.next_sequence, kind, text, age: 0, dismissed_at: None });
            queue.next_sequence += 1;
        });
    }

    /// How many toasts are queued (shown or sliding).
    pub fn len(ctx: &egui::Context) -> usize {
        ctx.data(|data| data.get_temp::<Queue>(egui::Id::new(QUEUE_ID))).map_or(0, |queue| queue.toasts.len())
    }

    /// Whether no toast is queued.
    pub fn is_empty(ctx: &egui::Context) -> bool {
        Toasts::len(ctx) == 0
    }

    /// Draw the queue for this tick and advance it one tick; a toast clicked slides out.
    pub fn show(ui: &egui::Ui) {
        let ctx = ui.ctx().clone();
        let id = egui::Id::new(QUEUE_ID);
        let mut queue = ctx.data(|data| data.get_temp::<Queue>(id)).unwrap_or_default();
        let frame = ctx.content_rect();
        let mut top = frame.top() + MARGIN.y;
        let painter = ctx.layer_painter(egui::LayerId::new(egui::Order::Foreground, id));
        for toast in &mut queue.toasts {
            let rect = toast_rect(&ctx, toast, frame, top);
            top += rect.height() + SPACING;
            let response = draw(&ctx, &painter, toast, rect);
            if response.clicked() && toast.dismissed_at.is_none() {
                toast.dismissed_at = Some(toast.age.max(TOAST_SLIDE_TICKS));
            }
            let paused = toast.idling() && response.hovered();
            if !paused {
                toast.age += 1;
            }
        }
        queue.toasts.retain(|toast| !toast.expired());
        ctx.data_mut(|data| data.insert_temp(id, queue));
    }
}

fn galley(ctx: &egui::Context, text: &str) -> std::sync::Arc<egui::Galley> {
    let font = egui::TextStyle::Body.resolve(&ctx.global_style());
    let color = ctx.global_style().visuals.text_color();
    ctx.fonts_mut(|fonts| fonts.layout_no_wrap(text.to_owned(), font, color))
}

/// Where a toast sits on this tick: right-aligned at `top`, slid out by its width while it enters
/// or leaves.
fn toast_rect(ctx: &egui::Context, toast: &Toast, frame: egui::Rect, top: f32) -> egui::Rect {
    let text = galley(ctx, &toast.text).size();
    let size = egui::vec2(PADDING.x * 2.0 + ICON_SIZE + ICON_GAP + text.x, PADDING.y * 2.0 + text.y.max(ICON_SIZE));
    let offset = size.x * (1.0 - toast.slide());
    let min = egui::pos2(frame.right() - MARGIN.x - size.x + offset, top);
    egui::Rect::from_min_size(min, size)
}

fn draw(ctx: &egui::Context, painter: &egui::Painter, toast: &Toast, rect: egui::Rect) -> egui::Response {
    let id = egui::Id::new(("genex-ui.toast", toast.sequence));
    let response = egui::Area::new(id)
        .order(egui::Order::Foreground)
        .fixed_pos(rect.min)
        .show(ctx, |ui| {
            let (_, response) = ui.allocate_exact_size(rect.size(), egui::Sense::click());
            response
        })
        .inner;
    response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Label, true, &toast.text));
    key_widget(ctx, response.id, &format!("toast.{}", toast.sequence));
    let visuals = &ctx.global_style().visuals;
    painter.rect_filled(rect, RADIUS, visuals.window_fill);
    let icon = egui::Rect::from_center_size(egui::pos2(rect.left() + PADDING.x + ICON_SIZE / 2.0, rect.center().y), egui::Vec2::splat(ICON_SIZE));
    painter.circle_filled(icon.center(), ICON_SIZE / 2.0, toast.kind.color());
    let text_pos = egui::pos2(icon.right() + ICON_GAP, rect.top() + PADDING.y);
    painter.galley(text_pos, galley(ctx, &toast.text), visuals.text_color());
    let remaining = 1.0 - (toast.age as f32 / TOAST_TICKS as f32).min(1.0);
    let line = egui::Rect::from_min_size(egui::pos2(rect.left(), rect.bottom() - PROGRESS_HEIGHT), egui::vec2(rect.width() * remaining, PROGRESS_HEIGHT));
    painter.rect_filled(line, 0.0, toast.kind.color());
    response
}
