// SPDX-License-Identifier: GPL-3.0-or-later

//! Tauri commands for the notes registry, and the events it sends: note
//! events to the Quick Notes window, the only one that may see note contents,
//! and file events to the main window, the only one that edits files.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::files::{FileDocUpdates, FileExternal, FileSaved};
use super::registry::{
    DocUpdates, LocalCollection, Pulled, Pushed, Registry, Sink, State, Structure, Update,
};
use crate::quicknotes;
use crate::store::workspace as store;
use crate::workspace::Workspaces;

pub(crate) const CHANGED_EVENT: &str = "notes-workspace-changed";
pub(crate) const DOC_EVENT: &str = "notes-doc-updates";
pub(crate) const FILE_DOC_EVENT: &str = "file-doc-updates";
pub(crate) const FILE_SAVED_EVENT: &str = "file-doc-saved";
pub(crate) const FILE_EXTERNAL_EVENT: &str = "file-doc-external";

pub(crate) type SharedRegistry = Arc<Registry>;

struct AppSink(AppHandle);

impl Sink for AppSink {
    fn changed(&self, state: &State) {
        let _ = self
            .0
            .emit_to(quicknotes::window::LABEL, CHANGED_EVENT, state);
    }
    fn doc(&self, updates: &DocUpdates) {
        let _ = self
            .0
            .emit_to(quicknotes::window::LABEL, DOC_EVENT, updates);
    }
    fn file_doc(&self, updates: &FileDocUpdates) {
        let _ = self
            .0
            .emit_to(quicknotes::window::MAIN_LABEL, FILE_DOC_EVENT, updates);
    }
    fn file_saved(&self, saved: &FileSaved) {
        let _ = self
            .0
            .emit_to(quicknotes::window::MAIN_LABEL, FILE_SAVED_EVENT, saved);
    }
    fn file_external(&self, external: &FileExternal) {
        let _ = self.0.emit_to(
            quicknotes::window::MAIN_LABEL,
            FILE_EXTERNAL_EVENT,
            external,
        );
    }
}

/// What the page needs to know once, when it first loads.
#[derive(Default)]
pub(crate) struct Startup {
    default_path: PathBuf,
    /// No preference file existed, so a workspace path an old build kept in
    /// localStorage may still be adopted.
    legacy_pending: bool,
    /// Why the remembered workspace could not be opened.
    fallback: Option<String>,
}

#[derive(Default)]
pub(crate) struct StartupState(Mutex<Startup>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Boot {
    state: State,
    needs_local_import: bool,
    fallback: Option<String>,
}

/// Opens the remembered workspace, or the default one, before any page loads,
/// so agent access works while the Quick Notes page is still starting.
pub(crate) fn start(app: &AppHandle) -> Result<(), String> {
    let registry = app.state::<SharedRegistry>();
    registry.set_sink(Arc::new(AppSink(app.clone())));
    let default_path = store::default_path(
        &app.path()
            .app_data_dir()
            .map_err(|e| format!("Could not resolve the app data directory: {e}"))?,
    );
    let preferences = crate::read_preferences(&crate::preferences_path(app)?);
    let remembered = preferences
        .as_ref()
        .ok()
        .and_then(|found| found.as_ref())
        .and_then(|found| found.last_workspace.clone());
    let mut startup = Startup {
        default_path: default_path.clone(),
        legacy_pending: matches!(preferences, Ok(None)),
        fallback: preferences
            .as_ref()
            .err()
            .map(|_| "Workspace settings unreadable; using local notes".to_string()),
    };
    let opened = remembered.and_then(|path| {
        let path = PathBuf::from(path);
        let _ = app.state::<Workspaces>().authorize(path.clone());
        registry
            .open(&path, path == default_path)
            .inspect_err(|error| {
                eprintln!("Could not open the remembered workspace: {error}");
                startup.fallback = Some("Workspace unavailable; using local notes".into());
            })
            .ok()
    });
    if opened.is_none() {
        registry.open(&default_path, true)?;
    }
    *app.state::<StartupState>()
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = startup;
    Ok(())
}

fn remember(app: &AppHandle, path: Option<&Path>) -> Result<(), String> {
    crate::write_preferences(
        &crate::preferences_path(app)?,
        &crate::AppPreferences {
            last_workspace: path.map(|path| path.to_string_lossy().into_owned()),
        },
    )
}

fn local_imported(registry: &Registry, default_path: &Path) -> Result<bool, String> {
    if registry.is_open_at(default_path) {
        return registry.with(|workspace| workspace.local_imported());
    }
    let conn = store::open(default_path)?;
    Ok(store::meta(&conn, store::LOCAL_IMPORTED_KEY)?.is_some())
}

#[tauri::command]
pub(crate) fn notes_boot(
    app: AppHandle,
    registry: tauri::State<'_, SharedRegistry>,
    workspaces: tauri::State<'_, Workspaces>,
    startup: tauri::State<'_, StartupState>,
    legacy_path: Option<String>,
) -> Result<Boot, String> {
    let (default_path, legacy_pending, mut fallback) = {
        let mut startup = startup.0.lock().unwrap_or_else(PoisonError::into_inner);
        let legacy_pending = std::mem::take(&mut startup.legacy_pending);
        (
            startup.default_path.clone(),
            legacy_pending,
            startup.fallback.take(),
        )
    };
    if legacy_pending {
        // The legacy value comes from the webview, so it may only name a
        // workspace that already exists; it must never become a way to create
        // a file.
        let legacy = legacy_path
            .filter(|value| !value.is_empty() && Path::new(value).is_file())
            .map(PathBuf::from);
        match legacy {
            Some(path) => {
                workspaces.authorize(path.clone())?;
                match registry.connect(&path) {
                    Ok(_) => remember(&app, Some(&path))?,
                    Err(error) => {
                        eprintln!("Could not open the workspace an older version used: {error}");
                        fallback = Some("Workspace unavailable; using local notes".into());
                    }
                }
            }
            None => remember(&app, None)?,
        }
    }
    Ok(Boot {
        state: registry.state()?,
        needs_local_import: !local_imported(&registry, &default_path)?,
        fallback,
    })
}

#[tauri::command]
pub(crate) fn notes_import_local(
    registry: tauri::State<'_, SharedRegistry>,
    startup: tauri::State<'_, StartupState>,
    local: LocalCollection,
) -> Result<State, String> {
    let default_path = startup
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .default_path
        .clone();
    registry.import_local(&default_path, local)?;
    registry.state()
}

#[tauri::command]
pub(crate) fn notes_connect(
    app: AppHandle,
    registry: tauri::State<'_, SharedRegistry>,
    workspaces: tauri::State<'_, Workspaces>,
    db_path: String,
) -> Result<State, String> {
    workspaces.require(&db_path)?;
    let path = PathBuf::from(db_path);
    let state = registry.connect(&path)?;
    remember(&app, Some(&path))?;
    Ok(state)
}

#[tauri::command]
pub(crate) fn notes_disconnect(
    app: AppHandle,
    registry: tauri::State<'_, SharedRegistry>,
    startup: tauri::State<'_, StartupState>,
) -> Result<State, String> {
    let default_path = startup
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .default_path
        .clone();
    let state = registry.open(&default_path, true)?;
    remember(&app, None)?;
    Ok(state)
}

#[tauri::command]
pub(crate) fn notes_sync_structure(
    registry: tauri::State<'_, SharedRegistry>,
    structure: Structure,
) -> Result<State, String> {
    registry.sync_structure(structure)
}

#[tauri::command]
pub(crate) fn notes_trash(
    registry: tauri::State<'_, SharedRegistry>,
    collection_id: String,
    note_id: String,
) -> Result<serde_json::Value, String> {
    registry.trash_note(&collection_id, &note_id)
}

#[tauri::command]
pub(crate) fn notes_restore(
    registry: tauri::State<'_, SharedRegistry>,
    collection_id: String,
    trash_id: String,
) -> Result<String, String> {
    registry.restore_trash(&collection_id, &trash_id)
}

#[tauri::command]
pub(crate) fn notes_empty_trash(
    registry: tauri::State<'_, SharedRegistry>,
    collection_id: String,
    ids: Vec<String>,
) -> Result<(), String> {
    registry.empty_trash(&collection_id, ids)
}

#[tauri::command]
pub(crate) fn notes_vacuum(registry: tauri::State<'_, SharedRegistry>) -> Result<(), String> {
    registry.vacuum()
}

#[tauri::command]
pub(crate) fn doc_push(
    registry: tauri::State<'_, SharedRegistry>,
    collection_id: String,
    note_id: String,
    version: u64,
    updates: Vec<Update>,
) -> Result<Pushed, String> {
    registry.push(&collection_id, &note_id, version, updates)
}

#[tauri::command]
pub(crate) fn doc_pull(
    registry: tauri::State<'_, SharedRegistry>,
    collection_id: String,
    note_id: String,
    since: u64,
) -> Result<Pulled, String> {
    registry.pull(&collection_id, &note_id, since)
}
