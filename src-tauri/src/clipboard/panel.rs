// SPDX-License-Identifier: GPL-3.0-or-later

// Turns a Tauri window into a non-activating floating panel: it takes keyboard
// focus without activating Sodilaud, so the frontmost app, the Cmd-Tab order, and
// full-screen Spaces stay as they were.

use std::ffi::CStr;
use std::ptr;
use std::sync::{Mutex, OnceLock, PoisonError};

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, NSObjectProtocol, Sel};
use objc2::{msg_send, sel, ClassType, MainThreadMarker};
use objc2_app_kit::{
    NSEvent, NSEventType, NSPanel, NSPopUpMenuWindowLevel, NSWindow, NSWindowCollectionBehavior,
    NSWindowStyleMask,
};
use tauri::WebviewWindow;

const PANEL_CLASS: &CStr = c"SodilaudFloatingPanel";
// tao 0.35 stores this flag on its window class; see `panel_class`.
const TAO_FOCUSABLE_IVAR: &CStr = c"focusable";
const KVO_PREFIX: &str = "NSKVONotifying_";

/// Why a window was left as it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanelRefusal {
    NotMainThread,
    NoNativeWindow,
    PanelClassUnavailable,
    UnknownWindowClass,
}

/// Each converted window's class before the swap, keyed by the window's address,
/// so `restore_window_class` can put back the exact (often KVO) class.
static ORIGINAL_CLASSES: Mutex<Vec<(usize, &'static AnyClass)>> = Mutex::new(Vec::new());

/// Converts `window` in place. On refusal the window is untouched and the caller
/// shows it as an ordinary window. Call `restore_window_class` before destroying it.
pub fn make_floating_panel(window: &WebviewWindow) -> Result<(), PanelRefusal> {
    convert(&*ns_window(window)?)
}

/// Orders the panel in front and makes it key without activating the app.
pub fn show_panel(window: &WebviewWindow) {
    let Some(panel) = ns_window(window)
        .ok()
        .and_then(|w| w.downcast::<NSPanel>().ok())
    else {
        return;
    };
    panel.orderFrontRegardless();
    panel.makeKeyWindow();
}

/// Swaps the window back to the class it had before `make_floating_panel`, so the
/// KVO machinery that isa-swizzled it finds its own class when observers are
/// removed and the window is deallocated. A no-op for windows never converted.
pub fn restore_window_class(window: &WebviewWindow) {
    if let Ok(ns_window) = ns_window(window) {
        restore(&ns_window);
    }
}

fn convert(ns_window: &NSWindow) -> Result<(), PanelRefusal> {
    let panel_class = panel_class().ok_or(PanelRefusal::PanelClassUnavailable)?;
    if !ns_window.isKindOfClass(panel_class) {
        let current = AnyObject::class(ns_window);
        if !swappable(current, panel_class) {
            return Err(PanelRefusal::UnknownWindowClass);
        }
        let key = ptr::from_ref(ns_window) as usize;
        let mut originals = lock_originals();
        originals.retain(|(window, _)| *window != key);
        originals.push((key, current));
        // SAFETY: we are on the main thread, where AppKit and tao touch this window,
        // and the caller's reference keeps it alive. `swappable` checked that the
        // panel class has the same instance size as the window's class, carries each
        // of its base class's ivars at the same offset with the same type, and
        // overrides every method the base class overrides, so no code can read
        // memory or behavior the swap removed. The KVO subclass's own overrides are
        // put back by `restore` before the window is destroyed.
        unsafe {
            objc2::ffi::object_setClass(ptr::from_ref(ns_window).cast_mut().cast(), panel_class);
        }
    }
    let Some(panel) = ns_window.downcast_ref::<NSPanel>() else {
        return Err(PanelRefusal::UnknownWindowClass);
    };
    // The panel class is swapped in after NSWindow's initializer ran, so NSPanel's
    // own defaults were never applied; set every property the popup relies on.
    panel.setStyleMask(panel.styleMask() | NSWindowStyleMask::NonactivatingPanel);
    panel.setFloatingPanel(true);
    panel.setHidesOnDeactivate(false);
    panel.setBecomesKeyOnlyIfNeeded(false);
    panel.setLevel(NSPopUpMenuWindowLevel);
    panel.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Transient
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    Ok(())
}

fn restore(ns_window: &NSWindow) {
    let key = ptr::from_ref(ns_window) as usize;
    let original = {
        let mut originals = lock_originals();
        let index = originals.iter().position(|(window, _)| *window == key);
        index.map(|index| originals.swap_remove(index).1)
    };
    let Some(original) = original else {
        return;
    };
    // Only undo our own swap. If something observed the panel meanwhile, KVO now
    // owns the isa and swapping it away would break that observation.
    if panel_class().is_some_and(|panel| ptr::eq(AnyObject::class(ns_window), panel)) {
        // SAFETY: main thread, and the caller's reference keeps the window alive.
        // `original` is the class the object had before `convert`, which checked it
        // is layout-identical to the panel class, so restoring it is the inverse swap.
        unsafe {
            objc2::ffi::object_setClass(ptr::from_ref(ns_window).cast_mut().cast(), original);
        }
    }
    // SAFETY: turning release-on-close off cannot over-release; tao owns the only
    // strong reference and releases it itself, as tauri-nspanel also relies on.
    unsafe { ns_window.setReleasedWhenClosed(false) };
}

fn lock_originals() -> std::sync::MutexGuard<'static, Vec<(usize, &'static AnyClass)>> {
    ORIGINAL_CLASSES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn ns_window(window: &WebviewWindow) -> Result<Retained<NSWindow>, PanelRefusal> {
    MainThreadMarker::new().ok_or(PanelRefusal::NotMainThread)?;
    let raw = window
        .ns_window()
        .map_err(|_| PanelRefusal::NoNativeWindow)?;
    // SAFETY: Tauri returns tao's NSWindow pointer, which tao keeps retained for as
    // long as `window` exists; retaining it here keeps it valid while we use it.
    unsafe { Retained::retain(raw.cast::<NSWindow>()) }.ok_or(PanelRefusal::NoNativeWindow)
}

/// By the time Tauri hands the window over, AppKit or WebKit has usually added a
/// key-value observer, which isa-swizzles the object to a runtime subclass named
/// `NSKVONotifying_<class>`. That subclass adds no ivars and only overrides KVO
/// plumbing (`class`, `dealloc`, `_isKVOA`, observed setters), so the layout that
/// matters is its superclass's. Anything else must itself be the base class.
fn base_class(current: &'static AnyClass) -> Option<&'static AnyClass> {
    let name = current.name().to_str().ok()?;
    let Some(base_name) = name.strip_prefix(KVO_PREFIX) else {
        return Some(current);
    };
    let base = current.superclass()?;
    let is_kvo_wrapper = base.name().to_str().ok() == Some(base_name)
        && current.instance_size() == base.instance_size()
        && current.instance_variables().is_empty();
    is_kvo_wrapper.then_some(base)
}

fn swappable(current: &'static AnyClass, panel: &AnyClass) -> bool {
    base_class(current).is_some_and(|base| layout_compatible(base, panel))
}

/// The swap must coexist with tao, which created the window as its own `TaoWindow`
/// (an NSWindow subclass). tao keeps using the object afterwards: it reads and writes
/// the `focusable` ivar by name, and its `sendEvent:` override forwards to
/// `[self superclass]`, which would recurse forever if we subclassed `TaoWindow`
/// itself without replacing that override. So the panel
/// class derives from NSPanel, re-declares `focusable` (landing at the same offset,
/// which `layout_compatible` verifies), and re-implements `TaoWindow`'s overrides.
fn panel_class() -> Option<&'static AnyClass> {
    static CLASS: OnceLock<Option<&'static AnyClass>> = OnceLock::new();
    *CLASS.get_or_init(|| {
        let mut builder = ClassBuilder::new(PANEL_CLASS, NSPanel::class())?;
        builder.add_ivar::<Bool>(TAO_FOCUSABLE_IVAR);
        // SAFETY: each function's receiver, arguments, and return type match the
        // Objective-C signature of the selector it implements.
        unsafe {
            builder.add_method(
                sel!(canBecomeKeyWindow),
                can_become_key as extern "C-unwind" fn(_, _) -> _,
            );
            builder.add_method(
                sel!(canBecomeMainWindow),
                can_become_main as extern "C-unwind" fn(_, _) -> _,
            );
            builder.add_method(
                sel!(sendEvent:),
                send_event as extern "C-unwind" fn(_, _, _),
            );
        }
        Some(builder.register())
    })
}

fn layout_compatible(current: &AnyClass, panel: &AnyClass) -> bool {
    let derives_from_nswindow = current
        .superclass()
        .is_some_and(|superclass| ptr::eq(superclass, NSWindow::class()));
    let same_ivars = current.instance_variables().iter().all(|ivar| {
        panel.instance_variable(ivar.name()).is_some_and(|ours| {
            ours.offset() == ivar.offset() && ours.type_encoding() == ivar.type_encoding()
        })
    });
    let panel_methods = panel.instance_methods();
    let same_overrides = current.instance_methods().iter().all(|method| {
        panel_methods
            .iter()
            .any(|ours| ours.name() == method.name())
    });
    derives_from_nswindow
        && current.instance_size() == panel.instance_size()
        && same_ivars
        && same_overrides
}

extern "C-unwind" fn can_become_key(_this: &NSPanel, _sel: Sel) -> Bool {
    Bool::YES
}

extern "C-unwind" fn can_become_main(_this: &NSPanel, _sel: Sel) -> Bool {
    Bool::NO
}

// Mirrors TaoWindow's override, which WKWebView needs for drag-by-background.
extern "C-unwind" fn send_event(this: &NSPanel, _sel: Sel, event: &NSEvent) {
    if event.r#type() == NSEventType::LeftMouseDown && this.isMovableByWindowBackground() {
        this.performWindowDragWithEvent(event);
    }
    // SAFETY: NSPanel implements `sendEvent:` with this signature; naming NSPanel
    // statically (unlike tao's `[self superclass]`) cannot recurse into this method.
    unsafe {
        let _: () = msg_send![super(this, NSPanel::class()), sendEvent: event];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    extern "C-unwind" fn yes(_this: &AnyObject, _sel: Sel) -> Bool {
        Bool::YES
    }

    extern "C-unwind" fn ignore_event(_this: &AnyObject, _sel: Sel, _event: &AnyObject) {}

    // Same shape as tao 0.35's TaoWindow: an NSWindow subclass with a `focusable`
    // BOOL ivar overriding canBecomeMainWindow, canBecomeKeyWindow, and sendEvent:.
    fn tao_like(name: &CStr, extra: impl FnOnce(&mut ClassBuilder)) -> &'static AnyClass {
        let mut builder = ClassBuilder::new(name, NSWindow::class()).expect("unique name");
        builder.add_ivar::<Bool>(TAO_FOCUSABLE_IVAR);
        // SAFETY: the signatures match the NSWindow selectors they override.
        unsafe {
            builder.add_method(
                sel!(canBecomeMainWindow),
                yes as extern "C-unwind" fn(_, _) -> _,
            );
            builder.add_method(
                sel!(canBecomeKeyWindow),
                yes as extern "C-unwind" fn(_, _) -> _,
            );
            builder.add_method(
                sel!(sendEvent:),
                ignore_event as extern "C-unwind" fn(_, _, _),
            );
        }
        extra(&mut builder);
        builder.register()
    }

    #[test]
    fn panel_class_matches_the_tao_window_layout() {
        let tao = tao_like(c"PanelTestTaoWindow", |_| {});
        let panel = panel_class().expect("panel class registers");
        assert!(layout_compatible(tao, panel));
        assert_eq!(
            tao.instance_variable(TAO_FOCUSABLE_IVAR)
                .map(|ivar| ivar.offset()),
            panel
                .instance_variable(TAO_FOCUSABLE_IVAR)
                .map(|ivar| ivar.offset()),
        );
    }

    #[test]
    fn refuses_a_window_class_with_state_the_panel_lacks() {
        let tao = tao_like(c"PanelTestExtraIvar", |builder| {
            builder.add_ivar::<usize>(c"extra");
        });
        assert!(!layout_compatible(
            tao,
            panel_class().expect("panel class registers")
        ));
    }

    #[test]
    fn refuses_a_window_class_with_an_override_the_panel_lacks() {
        let tao = tao_like(c"PanelTestExtraMethod", |builder| {
            // SAFETY: the signature matches -[NSResponder acceptsFirstResponder].
            unsafe {
                builder.add_method(
                    sel!(acceptsFirstResponder),
                    yes as extern "C-unwind" fn(_, _) -> _,
                );
            }
        });
        assert!(!layout_compatible(
            tao,
            panel_class().expect("panel class registers")
        ));
    }

    #[test]
    fn refuses_a_class_that_is_not_a_direct_nswindow_subclass() {
        let panel = panel_class().expect("panel class registers");
        assert!(!layout_compatible(NSWindow::class(), panel));
        assert!(!layout_compatible(NSPanel::class(), panel));
    }

    extern "C-unwind" fn kvo_class(_this: &AnyObject, _sel: Sel) -> *const AnyClass {
        ptr::null()
    }

    extern "C-unwind" fn kvo_noop(_this: &AnyObject, _sel: Sel) {}

    extern "C-unwind" fn kvo_set_opaque(_this: &AnyObject, _sel: Sel, _opaque: Bool) {}

    // Same shape as the runtime subclass KVO creates when something observes a
    // window: no ivars, overriding `class`, `dealloc`, `_isKVOA`, and a setter.
    fn kvo_like(
        base: &AnyClass,
        name: &CStr,
        extra: impl FnOnce(&mut ClassBuilder),
    ) -> &'static AnyClass {
        let mut builder = ClassBuilder::new(name, base).expect("unique name");
        // SAFETY: the signatures match the NSObject/NSWindow selectors they override.
        unsafe {
            builder.add_method(sel!(class), kvo_class as extern "C-unwind" fn(_, _) -> _);
            builder.add_method(sel!(dealloc), kvo_noop as extern "C-unwind" fn(_, _));
            builder.add_method(sel!(_isKVOA), yes as extern "C-unwind" fn(_, _) -> _);
            builder.add_method(
                sel!(setOpaque:),
                kvo_set_opaque as extern "C-unwind" fn(_, _, _),
            );
        }
        extra(&mut builder);
        builder.register()
    }

    #[test]
    fn a_kvo_wrapped_tao_window_is_checked_through_its_base_class() {
        let tao = tao_like(c"PanelTestKvoBase", |_| {});
        let kvo = kvo_like(tao, c"NSKVONotifying_PanelTestKvoBase", |_| {});
        let panel = panel_class().expect("panel class registers");
        assert!(base_class(kvo).is_some_and(|base| ptr::eq(base, tao)));
        assert!(!layout_compatible(kvo, panel));
        assert!(swappable(kvo, panel));
    }

    #[test]
    fn a_kvo_wrapper_does_not_excuse_an_unknown_base_class() {
        let tao = tao_like(c"PanelTestKvoExtraIvar", |builder| {
            builder.add_ivar::<usize>(c"extra");
        });
        let kvo = kvo_like(tao, c"NSKVONotifying_PanelTestKvoExtraIvar", |_| {});
        assert!(!swappable(
            kvo,
            panel_class().expect("panel class registers")
        ));
    }

    #[test]
    fn refuses_a_kvo_named_class_that_is_not_a_plain_wrapper() {
        let panel = panel_class().expect("panel class registers");
        let tao = tao_like(c"PanelTestKvoMismatch", |_| {});
        let misnamed = kvo_like(tao, c"NSKVONotifying_SomethingElse", |_| {});
        assert!(base_class(misnamed).is_none());
        assert!(!swappable(misnamed, panel));

        let tao = tao_like(c"PanelTestKvoOwnIvar", |_| {});
        let with_ivar = kvo_like(tao, c"NSKVONotifying_PanelTestKvoOwnIvar", |builder| {
            builder.add_ivar::<usize>(c"extra");
        });
        assert!(!swappable(with_ivar, panel));
    }

    // AppKit windows need the main thread, and libtest runs every test on a spawned
    // thread, so this only passes when called from a harness-less binary's main().
    #[test]
    #[ignore = "needs the main thread, which libtest never provides"]
    fn swaps_and_restores_a_real_key_value_observed_window() {
        use objc2::rc::Allocated;
        use objc2_app_kit::{NSApplication, NSBackingStoreType};
        use objc2_foundation::{NSObject, NSPoint, NSRect, NSSize, NSString};

        let mtm = MainThreadMarker::new().expect("must run on the main thread");
        let _app = NSApplication::sharedApplication(mtm);
        let tao = tao_like(c"PanelTestRealTaoWindow", |_| {});
        // SAFETY: `tao` is an NSWindow subclass, so `alloc` returns an allocated
        // NSWindow that the initializer below takes ownership of.
        let allocated: Allocated<NSWindow> = unsafe { msg_send![tao, alloc] };
        // SAFETY: plain borderless off-screen window; released by ARC, not on close.
        let window = unsafe {
            let window = NSWindow::initWithContentRect_styleMask_backing_defer(
                allocated,
                NSRect::new(NSPoint::new(-2000.0, -2000.0), NSSize::new(10.0, 10.0)),
                NSWindowStyleMask::Borderless,
                NSBackingStoreType::Buffered,
                false,
            );
            window.setReleasedWhenClosed(false);
            window
        };
        let focusable = tao.instance_variable(TAO_FOCUSABLE_IVAR).expect("ivar");
        // SAFETY: the ivar is a BOOL declared on the window's class.
        unsafe { *focusable.load_ptr::<Bool>(&window) = Bool::YES };

        let observer = NSObject::new();
        let key = NSString::from_str("opaque");
        // SAFETY: valid observer and key path; the observer is removed below and no
        // change to `opaque` is made, so it is never sent a notification.
        unsafe {
            let _: () = msg_send![&window, addObserver: &*observer, forKeyPath: &*key, options: 0usize, context: ptr::null_mut::<std::ffi::c_void>()];
        }
        let observed = AnyObject::class(&window);
        assert!(observed
            .name()
            .to_bytes()
            .starts_with(KVO_PREFIX.as_bytes()));

        assert_eq!(convert(&window), Ok(()));
        let panel = panel_class().expect("panel class registers");
        assert!(ptr::eq(AnyObject::class(&window), panel));
        assert!(window.canBecomeKeyWindow());
        assert!(!window.canBecomeMainWindow());
        // SAFETY: same ivar, which the panel class declares at the same offset.
        assert!(unsafe { *focusable.load_ptr::<Bool>(&window) }.as_bool());

        restore(&window);
        assert!(ptr::eq(AnyObject::class(&window), observed));
        // SAFETY: removes exactly the registration added above.
        unsafe {
            let _: () = msg_send![&window, removeObserver: &*observer, forKeyPath: &*key];
        }
        window.close();
        drop(window);
    }
}
