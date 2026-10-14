//! The refusal screen on iOS, drawn without wgpu, as Android blits it into its `ANativeWindow`: the
//! shell's pre-rendered [`RefusalImage`] (the copy and colours of [`crate::mobile::refusal`]) becomes
//! a CoreGraphics image, set as the contents of a plain `CALayer` laid over the window's view, above
//! the Metal layer wgpu made for the refused surface. The layer fills the view in the screen's
//! background; the image (rendered at the safe area's size) sits at its own pixel size in the middle,
//! so the text is never stretched. A redraw (resize, rotation, resume) replaces the layer.
//!
//! The Simulator's Metal is below WebGPU core, so this is what a Simulator run shows. Off iOS there
//! is no view to draw into and the hook answers `false` (the shell then exits after the record).

use crate::mobile::refusal::RefusalImage;
use winit::window::Window;

/// The name the screen's layer carries, so a redraw finds and replaces it.
pub const LAYER_NAME: &str = "genex-refusal";
/// `kCGImageAlphaNoneSkipLast` with the default byte order: four bytes a pixel, R G B and an
/// ignored fourth (the screen is opaque).
pub const BITMAP_INFO_RGBX: u32 = 5;
const BYTES_PER_PIXEL: usize = 4;
const BITS_PER_COMPONENT: usize = 8;
const BITS_PER_PIXEL: usize = 32;

/// How a [`RefusalImage`] is handed to CoreGraphics (`CGImageCreate`'s geometry).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CgBitmap {
    /// Width in pixels.
    pub width: usize,
    /// Height in pixels.
    pub height: usize,
    /// Bits per colour component.
    pub bits_per_component: usize,
    /// Bits per pixel.
    pub bits_per_pixel: usize,
    /// Bytes from one row to the next (no padding: the image is packed).
    pub bytes_per_row: usize,
    /// The `CGBitmapInfo` (alpha and byte order).
    pub bitmap_info: u32,
}

impl CgBitmap {
    /// The bitmap for `image`, or `None` for an empty one or one whose bytes are not exactly its
    /// `width * height` RGBA pixels (CoreGraphics would read past them).
    pub fn of(image: &RefusalImage) -> Option<CgBitmap> {
        let width = usize::try_from(image.width).ok()?;
        let height = usize::try_from(image.height).ok()?;
        let bytes_per_row = width.checked_mul(BYTES_PER_PIXEL)?;
        let packed = bytes_per_row.checked_mul(height)? == image.rgba.len();
        if width == 0 || height == 0 || !packed {
            return None;
        }
        Some(CgBitmap {
            width,
            height,
            bits_per_component: BITS_PER_COMPONENT,
            bits_per_pixel: BITS_PER_PIXEL,
            bytes_per_row,
            bitmap_info: BITMAP_INFO_RGBX,
        })
    }
}

/// An RGBA colour as UIKit's 0 to 1 components.
pub fn unit_rgba(colour: [u8; 4]) -> [f64; 4] {
    colour.map(|component| f64::from(component) / 255.0)
}

/// The shell's `refusal_screen` hook on iOS: lay `image` over `window`'s view; answers whether it
/// is showing.
#[cfg(target_os = "ios")]
pub fn draw(window: &Window, image: &RefusalImage) -> bool {
    ios::draw(window, image).is_some()
}

/// The shell's `refusal_screen` hook off iOS: there is no UIKit view to draw into.
#[cfg(not(target_os = "ios"))]
pub fn draw(_window: &Window, _image: &RefusalImage) -> bool {
    false
}

#[cfg(target_os = "ios")]
mod ios {
    use super::{CgBitmap, LAYER_NAME, unit_rgba};
    use crate::mobile::refusal::{BACKGROUND, RefusalImage};
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSData, NSString};
    use objc2_quartz_core::{CALayer, kCAFilterNearest, kCAGravityCenter};
    use objc2_ui_kit::{UIColor, UIView};
    use std::ffi::c_void;
    use std::ptr::{NonNull, null};
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use winit::window::Window;

    /// Above every layer the view hosts (wgpu's Metal layer among them).
    const Z_POSITION: f64 = 1000.0;
    /// `kCGRenderingIntentDefault`.
    const RENDERING_INTENT_DEFAULT: i32 = 0;

    // The few CoreGraphics calls that turn bytes into a CGImage (objc2-core-graphics is not a
    // dependency of this crate; the framework is linked by objc2-quartz-core's already).
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGColorSpaceCreateDeviceRGB() -> *mut c_void;
        fn CGColorSpaceRelease(space: *mut c_void);
        fn CGDataProviderCreateWithCFData(data: *const c_void) -> *mut c_void;
        fn CGDataProviderRelease(provider: *mut c_void);
        #[allow(clippy::too_many_arguments)]
        fn CGImageCreate(
            width: usize,
            height: usize,
            bits_per_component: usize,
            bits_per_pixel: usize,
            bytes_per_row: usize,
            space: *mut c_void,
            bitmap_info: u32,
            provider: *mut c_void,
            decode: *const f64,
            should_interpolate: bool,
            intent: i32,
        ) -> *mut c_void;
        fn CGImageRelease(image: *mut c_void);
    }

    /// A CoreGraphics object this code created, released when dropped.
    struct Owned {
        object: NonNull<c_void>,
        release: unsafe extern "C" fn(*mut c_void),
    }

    impl Owned {
        fn new(object: *mut c_void, release: unsafe extern "C" fn(*mut c_void)) -> Option<Owned> {
            NonNull::new(object).map(|object| Owned { object, release })
        }
    }

    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: `object` was returned by a CoreGraphics Create call (we hold its one
            // reference) and `release` is that type's release function.
            unsafe { (self.release)(self.object.as_ptr()) };
        }
    }

    /// `image` as a CGImage over a copy of its bytes.
    fn cg_image(image: &RefusalImage, bitmap: CgBitmap) -> Option<Owned> {
        let data = NSData::with_bytes(&image.rgba);
        // SAFETY: NSData is toll-free bridged to CFData; the provider retains it.
        let provider = Owned::new(
            unsafe { CGDataProviderCreateWithCFData(Retained::as_ptr(&data).cast()) },
            CGDataProviderRelease,
        )?;
        // SAFETY: plain constructor; released by `Owned`.
        let space = Owned::new(unsafe { CGColorSpaceCreateDeviceRGB() }, CGColorSpaceRelease)?;
        // SAFETY: the geometry is `CgBitmap::of`'s, which checked the provider's bytes are exactly
        // `bytes_per_row * height`; the image retains the provider and the colour space.
        let image = unsafe {
            CGImageCreate(
                bitmap.width,
                bitmap.height,
                bitmap.bits_per_component,
                bitmap.bits_per_pixel,
                bitmap.bytes_per_row,
                space.object.as_ptr(),
                bitmap.bitmap_info,
                provider.object.as_ptr(),
                null(),
                false,
                RENDERING_INTENT_DEFAULT,
            )
        };
        Owned::new(image, CGImageRelease)
    }

    /// Remove the screen a previous draw laid over `host`.
    fn remove_previous(host: &CALayer) {
        // SAFETY: -sublayers answers an NSArray of CALayers, or nil.
        let Some(sublayers) = (unsafe { host.sublayers() }) else { return };
        let name = NSString::from_str(LAYER_NAME);
        let ours: Vec<Retained<CALayer>> =
            sublayers.iter().filter(|layer| layer.name().is_some_and(|named| named.isEqualToString(&name))).collect();
        for layer in ours {
            layer.removeFromSuperlayer();
        }
    }

    pub(super) fn draw(window: &Window, image: &RefusalImage) -> Option<()> {
        let bitmap = CgBitmap::of(image)?;
        let handle = window.window_handle().ok()?;
        let RawWindowHandle::UiKit(handle) = handle.as_raw() else { return None };
        // SAFETY: winit's handle names the window's live UIView while the window exists, and the
        // shell calls this hook from the event loop, on the main thread.
        let view: &UIView = unsafe { handle.ui_view.cast::<UIView>().as_ref() };
        let contents = cg_image(image, bitmap)?;
        let host = view.layer();
        remove_previous(&host);
        let screen = CALayer::layer();
        screen.setName(Some(&NSString::from_str(LAYER_NAME)));
        screen.setFrame(host.bounds());
        screen.setZPosition(Z_POSITION);
        screen.setOpaque(true);
        let [red, green, blue, alpha] = unit_rgba(BACKGROUND);
        // SAFETY: read on the main thread; the layer retains the colour.
        let background = unsafe { UIColor::colorWithRed_green_blue_alpha(red, green, blue, alpha).CGColor() };
        screen.setBackgroundColor(Some(&background));
        // SAFETY: the gravity and filter names are CoreAnimation's constant strings.
        unsafe {
            screen.setContentsGravity(kCAGravityCenter);
            screen.setMagnificationFilter(kCAFilterNearest);
            screen.setMinificationFilter(kCAFilterNearest);
        }
        // The image is the safe area's physical pixels: drawn at that scale it is never stretched.
        screen.setContentsScale(window.scale_factor());
        // SAFETY: a CGImage is a CoreFoundation object, which -contents takes as an `id`; the layer
        // retains it, so `contents` can be released after.
        unsafe { screen.setContents(Some(contents.object.cast::<AnyObject>().as_ref())) };
        host.addSublayer(&screen);
        Some(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mobile::refusal::{BACKGROUND, REFUSAL_LINES, render};

    #[test]
    fn a_rendered_screen_is_handed_over_as_packed_opaque_rgb_bytes() {
        let image = render(1179, 2556, &REFUSAL_LINES).expect("a phone screen");
        let bitmap = CgBitmap::of(&image).expect("a bitmap");
        assert_eq!((bitmap.width, bitmap.height), (1179, 2556));
        assert_eq!(bitmap.bytes_per_row, 1179 * 4);
        assert_eq!(bitmap.bytes_per_row * bitmap.height, image.rgba.len(), "CoreGraphics reads exactly the image");
        assert_eq!((bitmap.bits_per_component, bitmap.bits_per_pixel), (8, 32));
        assert_eq!(bitmap.bitmap_info, BITMAP_INFO_RGBX, "R G B and a skipped fourth byte: opaque");
    }

    #[test]
    fn an_empty_or_inconsistent_image_never_reaches_core_graphics() {
        let short = RefusalImage { width: 4, height: 4, rgba: vec![0; 4 * 4 * 4 - 1] };
        let long = RefusalImage { width: 4, height: 4, rgba: vec![0; 4 * 4 * 4 + 4] };
        let empty = RefusalImage { width: 0, height: 4, rgba: Vec::new() };
        let huge = RefusalImage { width: u32::MAX, height: u32::MAX, rgba: vec![0; 16] };
        for (name, image) in [("short", short), ("long", long), ("empty", empty), ("overflowing", huge)] {
            assert_eq!(CgBitmap::of(&image), None, "{name}");
        }
    }

    #[test]
    fn the_layer_s_background_is_the_screen_s() {
        let [red, green, blue, alpha] = unit_rgba(BACKGROUND);
        let back = [red, green, blue, alpha].map(|unit| (unit * 255.0).round() as u8);
        assert_eq!(back, BACKGROUND, "the colour round-trips, so the letterbox matches the image");
        assert_eq!(alpha, 1.0);
    }
}
