// SPDX-License-Identifier: GPL-3.0-or-later

// Turns a Tauri window into a non-activating floating panel: it takes keyboard
// focus without activating Sodilaud, so the frontmost app, the Cmd-Tab order, and
// full-screen Spaces stay as they were.

use std::ffi::CStr;
use std::ptr;
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::{msg_send, sel, ClassType, MainThreadMarker};
use objc2_app_kit::{
    NSEvent, NSEventType, NSPanel, NSPopUpMenuWindowLevel, NSWindow, NSWindowCollectionBehavior,
    NSWindowStyleMask,
};
use tauri::WebviewWindow;

const PANEL_CLASS: &CStr = c"SodilaudFloatingPanel";
// tao 0.35 stores this flag on its window class; see `panel_class`.
const TAO_FOCUSABLE_IVAR: &CStr = c"focusable";

/// Converts `window` in place. Returns false, leaving the window untouched, when
/// not on the main thread or when its class is not one the swap is known to be
/// safe for; the caller then shows it as an ordinary window.
pub fn make_floating_panel(window: &WebviewWindow) -> bool {
    let Some(ns_window) = ns_window(window) else {
        return false;
    };
    let Some(panel_class) = panel_class() else {
        return false;
    };
    let current = AnyObject::class(&ns_window);
    if !ptr::eq(current, panel_class) {
        if !layout_compatible(current, panel_class) {
            return false;
        }
        // SAFETY: we are on the main thread, where AppKit and tao touch this window,
        // and `ns_window` keeps it alive. `layout_compatible` checked that the panel
        // class has the same instance size as the current class, carries each of its
        // ivars at the same offset with the same type, and overrides every method it
        // overrides, so no code can read memory or behavior the swap removed.
        unsafe {
            objc2::ffi::object_setClass(
                Retained::as_ptr(&ns_window).cast_mut().cast(),
                panel_class,
            );
        }
    }
    let Ok(panel) = ns_window.downcast::<NSPanel>() else {
        return false;
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
    true
}

/// Orders the panel in front and makes it key without activating the app.
pub fn show_panel(window: &WebviewWindow) {
    let Some(panel) = ns_window(window).and_then(|w| w.downcast::<NSPanel>().ok()) else {
        return;
    };
    panel.orderFrontRegardless();
    panel.makeKeyWindow();
}

fn ns_window(window: &WebviewWindow) -> Option<Retained<NSWindow>> {
    MainThreadMarker::new()?;
    let raw = window.ns_window().ok()?;
    // SAFETY: Tauri returns tao's NSWindow pointer, which tao keeps retained for as
    // long as `window` exists; retaining it here keeps it valid while we use it.
    unsafe { Retained::retain(raw.cast::<NSWindow>()) }
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
}
