// SPDX-License-Identifier: GPL-3.0-or-later

// Declaring the commands makes Tauri check each one against a capability, so a
// command registered without a grant cannot be called from the webview.
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "confirm_and_open_url",
            "load_workspace_preference",
            "set_last_workspace",
            "save_file_native",
            "import_file_native",
            "select_db_file",
            "vacuum_workspace",
            "load_db_notes",
            "load_db_folders",
            "load_db_trash",
            "save_note_db",
            "save_notes_db",
            "save_folders_db",
            "save_workspace_db",
            "show_alert_dialog",
            "update_mcp_snapshot",
            "update_mcp_note",
            "get_mcp_connection_info",
            "start_mcp_server",
            "set_mcp_permissions",
            "complete_mcp_write",
            "stop_mcp_server",
        ]),
    ))
    .expect("failed to run tauri-build");
}
