// SPDX-License-Identifier: GPL-3.0-or-later

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::{Arc, RwLock};

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, ClientJsonRpcMessage, ClientRequest, ContentBlock, EmptyResult, GetMeta,
    Implementation, ProtocolVersion, ServerCapabilities, ServerConfig, ServerJsonRpcMessage,
    ServerResult, SubscriptionFilter,
};
use rmcp::transport::{async_rw::AsyncRwTransport, Transport};
use rmcp::{
    tool, tool_handler, tool_router, ErrorData as McpError, RoleServer, ServerHandler, ServiceExt,
};
use serde::{Deserialize, Deserializer, Serialize};
use subtle::ConstantTimeEq;
use tauri::Manager;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::docs::coedit::{self, DocRef};
use crate::docs::commands::SharedRegistry;
use crate::docs::merge::Edit;
use crate::docs::registry::Workspace;
use crate::mcp_config::{self, McpConfig};
use crate::store::workspace::{Folder, Note};

pub(crate) const MCP_PORT: u16 = 39_393;
const MCP_TOKEN_FILE_NAME: &str = "sodilaud-mcp-token";
const CONNECTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const INITIAL_ACCEPT_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(25);
const MAX_ACCEPT_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(1);
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const DEFAULT_PAGE_SIZE: u32 = 50;
const MAX_PAGE_SIZE: u32 = 200;
const PREVIEW_CHARS: usize = 240;
const DEFAULT_CONTENT_CHARS: u32 = 20_000;
const MAX_CONTENT_CHARS: u32 = 100_000;

/// Everything an MCP agent can read, copied from the registry for one call.
///
/// Clipboard items must never enter this snapshot. Agent access hands every field here to
/// the connected client, which normally forwards it to a remote model provider, and
/// `search_notes` is a substring search over full content. Clipboard history holds live
/// credentials and must stay in a store this type has no reference to.
#[derive(Debug)]
struct Snapshot {
    collection_name: String,
    collection_id: String,
    note_revisions: HashMap<String, String>,
    folder_revisions: HashMap<String, String>,
    notes: Vec<Note>,
    folders: Vec<Folder>,
    trash: Vec<TrashSummary>,
}

fn snapshot_of(workspace: &Workspace) -> Snapshot {
    Snapshot {
        collection_name: workspace.name(),
        collection_id: workspace.id.clone(),
        note_revisions: workspace
            .notes
            .iter()
            .map(|entry| (entry.note.id.clone(), entry.rev.to_string()))
            .collect(),
        folder_revisions: workspace
            .folders
            .iter()
            .map(|entry| (entry.folder.id.clone(), entry.rev.to_string()))
            .collect(),
        notes: workspace
            .notes
            .iter()
            .map(|entry| entry.note.clone())
            .collect(),
        folders: workspace
            .folders
            .iter()
            .map(|entry| entry.folder.clone())
            .collect(),
        trash: workspace
            .trash
            .iter()
            .map(|entry| TrashSummary {
                id: entry.id.clone(),
                note_id: entry.note.id.clone(),
                title: entry.note.title.clone(),
                deleted_at: entry.deleted_at,
                folder_id: entry.note.folder_id.clone(),
                folder_name: entry.folder_name.clone(),
            })
            .collect(),
    }
}

/// The functions an agent may call, as the owner last chose them.
type Permissions = Arc<RwLock<HashSet<String>>>;

fn read_permissions() -> HashSet<String> {
    READ_TOOLS.into_iter().map(String::from).collect()
}

const READ_TOOLS: [&str; 8] = [
    "list_folders",
    "list_notes",
    "search_notes",
    "get_note",
    "list_trash",
    "list_documents",
    "read_document",
    "get_pending_comments",
];
const WRITE_TOOLS: [&str; 13] = [
    "create_note",
    "create_folder",
    "append_to_note",
    "rename_note",
    "move_note",
    "rename_folder",
    "delete_note",
    "delete_folder",
    "push_quick_note",
    "open_document",
    "apply_edit",
    "add_comment",
    "resolve_comment",
];
const MAX_WAIT_SECONDS: u32 = 1800;

fn permission_set(tools: Vec<String>) -> Result<HashSet<String>, String> {
    if tools
        .iter()
        .any(|tool| !READ_TOOLS.contains(&tool.as_str()) && !WRITE_TOOLS.contains(&tool.as_str()))
    {
        return Err("Unknown MCP function permission".into());
    }
    Ok(tools.into_iter().collect())
}

/// The saved choices, with any function the file does not name at its default:
/// reads on, writes off.
fn saved_permissions(config: &McpConfig) -> HashSet<String> {
    READ_TOOLS
        .iter()
        .chain(WRITE_TOOLS.iter())
        .filter(|tool| {
            config
                .permissions
                .get(**tool)
                .copied()
                .unwrap_or(READ_TOOLS.contains(*tool))
        })
        .map(|tool| tool.to_string())
        .collect()
}

fn permission_map(enabled: &HashSet<String>) -> BTreeMap<String, bool> {
    READ_TOOLS
        .iter()
        .chain(WRITE_TOOLS.iter())
        .map(|tool| (tool.to_string(), enabled.contains(*tool)))
        .collect()
}

fn config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(mcp_config::FILE_NAME))
        .map_err(|error| format!("Could not resolve the app configuration directory: {error}"))
}

fn sorted(tools: &HashSet<String>) -> Vec<String> {
    READ_TOOLS
        .iter()
        .chain(WRITE_TOOLS.iter())
        .filter(|tool| tools.contains(**tool))
        .map(|tool| tool.to_string())
        .collect()
}

#[tauri::command]
pub(crate) async fn set_mcp_permissions(
    app: tauri::AppHandle,
    state: tauri::State<'_, McpState>,
    tools: Vec<String>,
) -> Result<(), String> {
    state.set_permissions(&config_path(&app)?, tools).await
}

struct RunningServer {
    cancellation: CancellationToken,
    task: JoinHandle<()>,
    connection: McpConnectionInfo,
}

pub(crate) const STATE_EVENT: &str = "mcp-state-changed";

/// What both windows show of agent access, sent whenever it changes.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpStateChanged {
    #[serde(flatten)]
    status: McpStatus,
    /// Set only when the Claude Code integration was installed or removed.
    integration: Option<crate::integration::Plan>,
}

/// Where agent access changes go: both windows, or a test recorder.
pub(crate) trait McpEvents: Send + Sync {
    fn state_changed(&self, event: &McpStateChanged);
}

struct AppEvents(tauri::AppHandle);

impl McpEvents for AppEvents {
    fn state_changed(&self, event: &McpStateChanged) {
        use tauri::Emitter;
        for window in [
            crate::quicknotes::window::LABEL,
            crate::quicknotes::window::MAIN_LABEL,
        ] {
            let _ = self.0.emit_to(window, STATE_EVENT, event);
        }
    }
}

pub(crate) struct McpState {
    permissions: Permissions,
    running: tokio::sync::Mutex<Option<RunningServer>>,
    /// Why access that was on at quit could not start again at launch.
    start_error: std::sync::Mutex<Option<String>>,
    events: RwLock<Option<Arc<dyn McpEvents>>>,
}

impl Default for McpState {
    fn default() -> Self {
        Self {
            permissions: Arc::new(RwLock::new(read_permissions())),
            running: tokio::sync::Mutex::new(None),
            start_error: std::sync::Mutex::new(None),
            events: RwLock::new(None),
        }
    }
}

impl McpState {
    pub(crate) fn set_events(&self, events: Arc<dyn McpEvents>) {
        if let Ok(mut slot) = self.events.write() {
            *slot = Some(events);
        }
    }

    async fn status(&self) -> Result<McpStatus, String> {
        let enabled = self.running.lock().await.is_some();
        let tools = if enabled {
            sorted(&*self.permissions.read().map_err(|e| e.to_string())?)
        } else {
            Vec::new()
        };
        let error = self.start_error.lock().map_err(|e| e.to_string())?.clone();
        Ok(McpStatus {
            enabled,
            tools,
            error,
        })
    }

    pub(crate) async fn publish(&self, integration: Option<crate::integration::Plan>) {
        let events = self.events.read().ok().and_then(|slot| slot.clone());
        let Some(events) = events else {
            return;
        };
        match self.status().await {
            Ok(status) => events.state_changed(&McpStateChanged {
                status,
                integration,
            }),
            Err(error) => eprintln!("Could not read the agent access state: {error}"),
        }
    }

    // Saved before it is applied, so a choice that cannot be remembered is not used.
    async fn set_permissions(&self, path: &Path, tools: Vec<String>) -> Result<(), String> {
        let tools = permission_set(tools)?;
        let mut config = mcp_config::load(path);
        config.permissions = permission_map(&tools);
        mcp_config::save(path, &config)?;
        *self.permissions.write().map_err(|e| e.to_string())? = tools;
        self.publish(None).await;
        Ok(())
    }

    async fn stop(&self, path: &Path) -> Result<(), String> {
        *self.permissions.write().map_err(|e| e.to_string())? = HashSet::new();
        let mut config = mcp_config::load(path);
        config.enabled = false;
        if let Err(error) = mcp_config::save(path, &config) {
            eprintln!("{error}");
        }
        let server = self.running.lock().await.take();
        if let Some(server) = server {
            server.cancellation.cancel();
            let mut task = server.task;
            if tokio::time::timeout(std::time::Duration::from_secs(2), &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        }
        self.publish(None).await;
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpStarted {
    #[serde(flatten)]
    connection: McpConnectionInfo,
    tools: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpStatus {
    enabled: bool,
    tools: Vec<String>,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpConnectionInfo {
    command: String,
    args: Vec<String>,
}

/// The path an MCP client or a Claude Code hook launches Sodilaud by.
pub(crate) fn executable() -> Result<String, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not locate the Sodilaud executable: {error}"))?;
    // An AppImage's inner binary lives in a temporary mount. Its outer path
    // remains launchable after the editor exits and the mount is removed.
    #[cfg(target_os = "linux")]
    let executable = std::env::var_os("APPIMAGE")
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file())
        .unwrap_or(executable);
    executable
        .into_os_string()
        .into_string()
        .map_err(|_| "The Sodilaud executable path is not valid Unicode".to_string())
}

// Reading client configuration never binds a socket or grants agent access.
#[tauri::command]
pub(crate) fn get_mcp_connection_info() -> Result<McpConnectionInfo, String> {
    Ok(McpConnectionInfo {
        command: executable()?,
        args: vec!["--mcp-stdio".into()],
    })
}

/// Send as I go, or Hold for review. Saved before it is applied.
#[tauri::command]
pub(crate) fn coedit_set_hold(
    app: tauri::AppHandle,
    registry: tauri::State<'_, SharedRegistry>,
    hold: bool,
) -> Result<crate::docs::coedit::CoeditState, String> {
    let path = config_path(&app)?;
    let mut config = mcp_config::load(&path);
    config.hold_for_review = hold;
    mcp_config::save(&path, &config)?;
    registry.set_hold_for_review(hold);
    Ok(registry.coedit_state())
}

#[tauri::command]
pub(crate) async fn start_mcp_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, McpState>,
) -> Result<McpStarted, String> {
    let connection = start(&app, &state).await?;
    let tools = sorted(&*state.permissions.read().map_err(|e| e.to_string())?);
    state.publish(None).await;
    Ok(McpStarted { connection, tools })
}

#[tauri::command]
pub(crate) async fn get_mcp_state(state: tauri::State<'_, McpState>) -> Result<McpStatus, String> {
    state.status().await
}

/// Starts access at launch when it was on at quit, before any page loads,
/// and restores how owner comments are sent.
pub(crate) fn start_saved(app: &tauri::AppHandle) {
    app.state::<McpState>()
        .set_events(Arc::new(AppEvents(app.clone())));
    let Ok(path) = config_path(app) else {
        return;
    };
    let config = mcp_config::load(&path);
    app.state::<SharedRegistry>()
        .set_hold_for_review(config.hold_for_review);
    if !config.enabled {
        return;
    }
    let state = app.state::<McpState>();
    if let Err(error) = tauri::async_runtime::block_on(start(app, &state)) {
        eprintln!("{error}");
        if let Ok(mut saved) = state.start_error.lock() {
            *saved = Some(error);
        }
    }
}

async fn start(app: &tauri::AppHandle, state: &McpState) -> Result<McpConnectionInfo, String> {
    let mut running = state.running.lock().await;
    if let Some(server) = running.as_ref() {
        return Ok(server.connection.clone());
    }

    let connection = get_mcp_connection_info()?;
    let listener = TcpListener::bind(("127.0.0.1", MCP_PORT))
        .await
        .map_err(|error| {
            format!(
                "Could not enable agent access on port {MCP_PORT}. Another application may be using it: {error}"
            )
        })?;
    let token_path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not resolve the app configuration directory: {error}"))?
        .join(MCP_TOKEN_FILE_NAME);
    let token = load_or_create_token(&token_path)?;
    let path = config_path(app)?;
    let permissions = saved_permissions(&mcp_config::load(&path));
    if let Err(error) = mcp_config::save(
        &path,
        &McpConfig {
            enabled: true,
            permissions: permission_map(&permissions),
            ..mcp_config::load(&path)
        },
    ) {
        eprintln!("{error}");
    }
    *state.permissions.write().map_err(|e| e.to_string())? = permissions;
    if let Ok(mut error) = state.start_error.lock() {
        *error = None;
    }
    let registry = app.state::<SharedRegistry>().inner().clone();
    let cancellation = CancellationToken::new();
    let task = tokio::spawn(serve_local_connections(
        listener,
        registry,
        state.permissions.clone(),
        Some(app.clone()),
        token,
        cancellation.clone(),
    ));
    *running = Some(RunningServer {
        cancellation,
        task,
        connection: connection.clone(),
    });
    Ok(connection)
}

#[tauri::command]
pub(crate) async fn stop_mcp_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    state.stop(&config_path(&app)?).await
}

// The app owns the live collection. Each headless invocation relays its stdio
// stream over this authenticated loopback channel, without reading note files
// or launching another editor. The token never enters client configuration.
async fn serve_local_connections(
    listener: TcpListener,
    registry: SharedRegistry,
    permissions: Permissions,
    app: Option<tauri::AppHandle>,
    token: String,
    cancellation: CancellationToken,
) {
    let mut sessions = JoinSet::new();
    let mut accept_retry_delay = INITIAL_ACCEPT_RETRY_DELAY;
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => break,
            _ = sessions.join_next(), if !sessions.is_empty() => {},
            connection = listener.accept(), if sessions.len() < 32 => {
                let mut stream = match connection {
                    Ok((stream, _)) => {
                        accept_retry_delay = INITIAL_ACCEPT_RETRY_DELAY;
                        stream
                    }
                    Err(error) => {
                        eprintln!("Sodilaud MCP listener could not accept a connection: {error}");
                        if !should_retry_accept(&error) {
                            break;
                        }
                        let delay = accept_retry_delay;
                        accept_retry_delay = accept_retry_delay
                            .saturating_mul(2)
                            .min(MAX_ACCEPT_RETRY_DELAY);
                        tokio::select! {
                            biased;
                            _ = cancellation.cancelled() => break,
                            _ = tokio::time::sleep(delay) => {}
                        }
                        continue;
                    }
                };
                let registry = registry.clone();
                let permissions = permissions.clone();
                let app = app.clone();
                let token = token.clone();
                let session_cancellation = cancellation.child_token();
                sessions.spawn(async move {
                    let authenticate = tokio::time::timeout(CONNECTION_TIMEOUT, async {
                        let mut supplied = [0u8; 65];
                        stream.read_exact(&mut supplied).await?;
                        if supplied[64] != b'\n'
                            || !bool::from(supplied[..64].ct_eq(token.as_bytes()))
                        {
                            return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
                        }
                        stream.write_all(&[1]).await
                    });
                    let authenticated = tokio::select! {
                        result = authenticate => result,
                        _ = session_cancellation.cancelled() => return,
                    };
                    if !matches!(authenticated, Ok(Ok(()))) { return; }
                    serve_mcp_connection(stream, SodilaudServer::new(registry, permissions, app), session_cancellation).await;
                });
            }
        }
    }
    // Waiting for every session ensures disabling access closes all sockets
    // before another enable can start accepting connections.
    cancellation.cancel();
    while sessions.join_next().await.is_some() {}
}

fn should_retry_accept(error: &std::io::Error) -> bool {
    !matches!(
        error.kind(),
        std::io::ErrorKind::InvalidInput
            | std::io::ErrorKind::NotConnected
            | std::io::ErrorKind::Unsupported
    )
}

async fn serve_mcp_connection(stream: TcpStream, server: SodilaudServer, ct: CancellationToken) {
    let (reader, writer) = stream.into_split();
    let mut transport = AsyncRwTransport::new_server(BoundedMessageReader::new(reader), writer);
    let first = loop {
        let message = tokio::select! {
            message = transport.receive() => message,
            _ = ct.cancelled() => return,
        };
        let Some(message) = message else { return };
        // Legacy clients may ping before initialize. Answer these without
        // committing to either the legacy or per-request metadata lifecycle.
        if let ClientJsonRpcMessage::Request(request) = &message {
            if matches!(request.request, ClientRequest::PingRequest(_)) {
                if transport
                    .send(ServerJsonRpcMessage::response(
                        ServerResult::EmptyResult(EmptyResult {}),
                        request.id.clone(),
                    ))
                    .await
                    .is_err()
                {
                    return;
                }
                continue;
            }
        }
        break message;
    };
    let legacy = matches!(&first, ClientJsonRpcMessage::Request(request)
        if matches!(request.request, ClientRequest::InitializeRequest(_)));
    let transport = PrefetchedTransport {
        first: Some(first),
        inner: transport,
        require_metadata: !legacy,
    };
    let service = if legacy {
        let Ok(service) = server.serve_with_ct(transport, ct).await else {
            return;
        };
        service
    } else {
        // The SDK negotiation path can await the first handler before polling its
        // outgoing channel. A long-lived subscriptions/listen deadlocks there.
        // Start the SDK service loop directly for metadata-based clients; it
        // validates each request and can emit the initial acknowledgment.
        rmcp::service::serve_directly_with_ct(server, transport, None, ct)
    };
    let _ = service.waiting().await;
}

struct PrefetchedTransport<T> {
    first: Option<ClientJsonRpcMessage>,
    inner: T,
    require_metadata: bool,
}

impl<T: Transport<RoleServer>> Transport<RoleServer> for PrefetchedTransport<T> {
    type Error = T::Error;

    fn send(
        &mut self,
        message: ServerJsonRpcMessage,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send + 'static {
        self.inner.send(message)
    }

    async fn receive(&mut self) -> Option<ClientJsonRpcMessage> {
        loop {
            let message = if let Some(first) = self.first.take() {
                first
            } else {
                self.inner.receive().await?
            };
            // serve_directly supports legacy sessions too, so it does not
            // enforce the metadata lifecycle itself. Keep that boundary here.
            if self.require_metadata {
                if let ClientJsonRpcMessage::Request(request) = &message {
                    let missing = request
                        .request
                        .get_meta()
                        .missing_required_keys(&ProtocolVersion::V_2026_07_28);
                    if !missing.is_empty() {
                        let error = McpError::invalid_params(
                            format!(
                                "Request metadata is missing or invalid: {}",
                                missing.join(", ")
                            ),
                            None,
                        );
                        self.inner
                            .send(ServerJsonRpcMessage::error(error, Some(request.id.clone())))
                            .await
                            .ok()?;
                        continue;
                    }
                }
            }
            return Some(message);
        }
    }

    async fn close(&mut self) -> Result<(), Self::Error> {
        self.inner.close().await
    }
}

// Keep the SDK's protocol/error handling while bounding its line buffer,
// including malicious input that never supplies a newline.
struct BoundedMessageReader<R> {
    inner: R,
    line_bytes: usize,
}

impl<R> BoundedMessageReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            line_bytes: 0,
        }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for BoundedMessageReader<R> {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let this = self.get_mut();
        let before = buffer.filled().len();
        match std::pin::Pin::new(&mut this.inner).poll_read(context, buffer) {
            std::task::Poll::Ready(Ok(())) => {
                for byte in &buffer.filled()[before..] {
                    if *byte == b'\n' {
                        this.line_bytes = 0;
                    } else {
                        this.line_bytes += 1;
                        if this.line_bytes > MAX_REQUEST_BYTES {
                            buffer.set_filled(before);
                            return std::task::Poll::Ready(Err(std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                "MCP request exceeds 256 KiB",
                            )));
                        }
                    }
                }
                std::task::Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}

/// Run the installed executable as an MCP stdio subprocess, without Tauri UI.
pub fn run_mcp_stdio(identifier: &str) -> Result<(), String> {
    let token_path = mcp_token_path(identifier)?;
    let token = fs::read_to_string(token_path)
        .map_err(|_| "Open Sodilaud and enable agent access before connecting".to_string())?;
    let token = validate_token(token.trim())?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Could not start the MCP runtime: {error}"))?;
    let result = runtime.block_on(async {
        let stream = connect_to_editor(("127.0.0.1", MCP_PORT), token).await?;
        relay_stdio(stream, tokio::io::stdin(), tokio::io::stdout())
            .await
            .map_err(|_| {
                "The MCP connection closed unexpectedly; reconnect your client".to_string()
            })
    });
    // Tokio's stdin reader can block until more input arrives. Do not wait for
    // that blocking thread when the editor closes or disables agent access.
    runtime.shutdown_background();
    result
}

fn mcp_token_path(identifier: &str) -> Result<std::path::PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or_else(|| "Could not resolve the app configuration directory".to_string())?
        .join(identifier)
        .join(MCP_TOKEN_FILE_NAME))
}

async fn connect_to_editor(
    address: impl tokio::net::ToSocketAddrs,
    token: &str,
) -> Result<TcpStream, String> {
    tokio::time::timeout(CONNECTION_TIMEOUT, async {
        let mut stream = TcpStream::connect(address).await?;
        stream.set_nodelay(true)?;
        stream.write_all(token.as_bytes()).await?;
        stream.write_all(b"\n").await?;
        if stream.read_u8().await? != 1 {
            return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        }
        Ok::<_, std::io::Error>(stream)
    })
    .await
    .map_err(|_| {
        "Sodilaud did not respond; open the app, enable agent access, and reconnect".to_string()
    })?
    .map_err(|_| {
        "Cannot connect to Sodilaud; open the app, enable agent access, and reconnect".to_string()
    })
}

async fn relay_stdio(
    stream: TcpStream,
    mut input: impl AsyncRead + Unpin,
    mut output: impl AsyncWrite + Unpin,
) -> std::io::Result<()> {
    let (mut reader, mut writer) = stream.into_split();
    tokio::select! {
        result = tokio::io::copy(&mut input, &mut writer) => result.map(|_| ()),
        result = async {
            let mut buffer = [0u8; 8192];
            loop {
                let count = reader.read(&mut buffer).await?;
                if count == 0 { return Ok(()); }
                output.write_all(&buffer[..count]).await?;
                output.flush().await?;
            }
        } => result,
    }
}

fn load_or_create_token(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(token) => validate_token(token.trim()).map(str::to_owned),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| "The MCP token path has no parent directory".to_string())?;
            fs::create_dir_all(parent).map_err(|error| {
                format!("Could not create the app configuration directory: {error}")
            })?;
            let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
            write_private_token(path, &token)?;
            Ok(token)
        }
        Err(error) => Err(format!("Could not read the MCP access token: {error}")),
    }
}

fn validate_token(token: &str) -> Result<&str, String> {
    if token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(token)
    } else {
        Err("The saved MCP access token is invalid".into())
    }
}

#[cfg(unix)]
fn write_private_token(path: &Path, token: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("Could not create the MCP access token: {error}"))?;
    file.write_all(token.as_bytes())
        .map_err(|error| format!("Could not save the MCP access token: {error}"))
}

#[cfg(not(unix))]
fn write_private_token(path: &Path, token: &str) -> Result<(), String> {
    use std::io::Write;

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("Could not create the MCP access token: {error}"))?;
    file.write_all(token.as_bytes())
        .map_err(|error| format!("Could not save the MCP access token: {error}"))
}

#[derive(Debug, Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AppendNoteArgs {
    /// Current collection ID returned by get_note.
    collection_id: String,
    /// Unique retry key. Reuse exactly the same arguments when retrying.
    request_id: String,
    /// Existing note ID returned by get_note.
    note_id: String,
    /// Opaque revision returned by get_note; conflicts require rereading.
    expected_revision: String,
    /// Exact text to append (1-100000 UTF-8 bytes). Include your own newlines.
    content: String,
}

#[derive(Debug, Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RenameNoteArgs {
    /// Current collection ID from get_note.
    collection_id: String,
    /// Unique retry key (1-128 characters). Reuse identical arguments on retry.
    request_id: String,
    /// Existing target ID from get_note.
    note_id: String,
    /// Opaque revision from get_note; conflicts require rereading.
    expected_revision: String,
    /// New explicit title (1-200 characters); locks automatic title generation.
    title: String,
}

#[derive(Debug, Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct MoveNoteArgs {
    /// Current collection ID from get_note.
    collection_id: String,
    /// Unique retry key (1-128 characters). Reuse identical arguments on retry.
    request_id: String,
    /// Existing target ID from get_note.
    note_id: String,
    /// Opaque revision from get_note; conflicts require rereading.
    expected_revision: String,
    /// Destination folder ID, or null for top level. Must be explicitly supplied.
    #[serde(deserialize_with = "deserialize_destination")]
    #[schemars(required, schema_with = "nullable_destination_schema")]
    folder_id: Option<String>,
}

#[derive(Debug, Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RenameFolderArgs {
    /// Current collection ID from list_folders.
    collection_id: String,
    /// Unique retry key (1-128 characters). Reuse identical arguments on retry.
    request_id: String,
    /// Existing target ID from list_folders.
    folder_id: String,
    /// Opaque revision from list_folders; conflicts require rereading.
    expected_revision: String,
    /// New folder name (1-200 characters); duplicate and reserved names are rejected.
    name: String,
}

fn nullable_destination_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    // `required` alone unwraps Option's schema. Presence is mandatory, but a
    // JSON null is still a valid destination and means the workspace top level.
    schemars::json_schema!({ "type": ["string", "null"] })
}

fn deserialize_destination<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    serde::Deserialize::deserialize(deserializer)
}

#[derive(Debug, Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DeleteNoteArgs {
    /// Current collection ID from get_note.
    collection_id: String,
    /// Unique retry key. Reuse identical arguments on retry.
    request_id: String,
    /// Existing target ID from get_note.
    note_id: String,
    /// Current revision from get_note; conflicts require rereading.
    expected_revision: String,
}

#[derive(Debug, Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DeleteFolderArgs {
    /// Current collection ID from list_folders.
    collection_id: String,
    /// Unique retry key. Reuse identical arguments on retry.
    request_id: String,
    /// Existing target ID from list_folders.
    folder_id: String,
    /// Current revision from list_folders; conflicts require rereading.
    expected_revision: String,
}

#[derive(Debug, Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateNoteArgs {
    /// Collection ID from a recent list_notes or list_folders result.
    collection_id: String,
    /// Unique retry key (1-128 characters). Reuse with identical arguments on retry.
    request_id: String,
    /// Explicit title (1-200 characters after trimming).
    title: String,
    /// Markdown content, at most 100000 UTF-8 bytes. Defaults to empty.
    #[serde(default)]
    content: String,
    /// Existing destination folder ID. Omit for top level.
    folder_id: Option<String>,
}

#[derive(Debug, Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PushQuickNoteArgs {
    /// Unique retry key (1-128 characters). Reuse with identical arguments on retry.
    request_id: String,
    /// Explicit title (1-200 characters after trimming).
    title: String,
    /// Markdown content, at most 100000 UTF-8 bytes. Defaults to empty.
    #[serde(default)]
    content: String,
    /// Show the Quick Notes panel with the note selected, without taking keyboard focus. Defaults to true.
    #[serde(skip_serializing)]
    show: Option<bool>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OpenDocumentArgs {
    /// Absolute path to an existing .md, .markdown or .txt file (UTF-8, at most 10 MB).
    path: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct NoArgs {}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReadDocumentArgs {
    /// Absolute path of a file open in Sodilaud. Give this or noteId.
    path: Option<String>,
    /// ID of a note in the open collection. Give this or path.
    note_id: Option<String>,
    /// First character to return (Unicode characters, not bytes). Defaults to 0.
    offset: Option<u32>,
    /// Characters to return, 1-200000. Defaults to 200000.
    limit: Option<u32>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ApplyEditArgs {
    /// Absolute path of a file open in Sodilaud. Give this or noteId.
    path: Option<String>,
    /// ID of a note in the open collection. Give this or path.
    note_id: Option<String>,
    /// The version read_document returned with the text the edits were written against.
    base_version: u64,
    /// Unique retry key (1-128 characters). Reuse with identical arguments on retry.
    request_id: String,
    /// 1-50 replacements. Each oldText is copied from the text read at baseVersion and must identify one place.
    edits: Vec<Edit>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PendingCommentsArgs {
    /// Only comments on this file (absolute path). Omit both for every document.
    path: Option<String>,
    /// Only comments on this note.
    note_id: Option<String>,
    /// Seconds to wait for a comment when none is queued, 0-1800. Defaults to 0.
    wait_seconds: Option<u32>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AddCommentArgs {
    /// Absolute path of a file open in Sodilaud. Give this or noteId.
    path: Option<String>,
    /// ID of a note in the open collection. Give this or path.
    note_id: Option<String>,
    /// Exact text to comment on, as it is in the document now.
    anchor_text: String,
    /// Which copy of anchorText, from 1, when it occurs more than once.
    occurrence: Option<u32>,
    /// The comment, 1-2000 characters.
    body: String,
    /// Unique retry key (1-128 characters). Reuse with identical arguments on retry.
    request_id: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ResolveCommentArgs {
    /// Comment ID from get_pending_comments or read_document.
    id: String,
    /// One line for the owner on what changed, 1-500 characters.
    note: String,
}

#[derive(Debug, Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateFolderArgs {
    /// Collection ID from a recent list_notes or list_folders result.
    collection_id: String,
    /// Unique retry key (1-128 characters). Reuse with identical arguments on retry.
    request_id: String,
    /// Folder name (1-200 characters); duplicate and reserved names are rejected.
    name: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ListFoldersArgs {
    /// Maximum entries to return (1-200, default 50).
    limit: Option<u32>,
    /// Number of entries to skip (default 0).
    offset: Option<u32>,
}

#[derive(Debug, Default, PartialEq, Eq)]
enum FolderFilter {
    #[default]
    All,
    TopLevel,
    Folder(String),
}

impl FolderFilter {
    fn includes(&self, note: &Note) -> bool {
        match self {
            Self::All => true,
            Self::TopLevel => note.folder_id.is_none(),
            Self::Folder(folder_id) => note.folder_id.as_deref() == Some(folder_id),
        }
    }
}

fn deserialize_folder_filter<'de, D>(deserializer: D) -> Result<FolderFilter, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Option::<String>::deserialize(deserializer)? {
        Some(folder_id) => FolderFilter::Folder(folder_id),
        None => FolderFilter::TopLevel,
    })
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ListNotesArgs {
    /// Omit to return all notes, pass null for top-level notes, or pass a folder id.
    #[serde(default, deserialize_with = "deserialize_folder_filter")]
    #[schemars(with = "Option<String>")]
    folder_id: FolderFilter,
    /// Maximum notes to return (1-200, default 50).
    limit: Option<u32>,
    /// Number of notes to skip (default 0).
    offset: Option<u32>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SearchNotesArgs {
    /// Literal text to find in note titles or Markdown content.
    query: String,
    /// Omit to search all notes, pass null for top-level notes, or pass a folder id.
    #[serde(default, deserialize_with = "deserialize_folder_filter")]
    #[schemars(with = "Option<String>")]
    folder_id: FolderFilter,
    /// Maximum notes to return (1-200, default 50).
    limit: Option<u32>,
    /// Number of matching notes to skip (default 0).
    offset: Option<u32>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GetNoteArgs {
    /// Stable note id returned by list_notes or search_notes.
    id: String,
    /// Character offset in the Markdown content (default 0).
    offset: Option<u32>,
    /// Maximum content characters to return (1-100000, default 20000).
    limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrashSummary {
    id: String,
    note_id: String,
    title: String,
    deleted_at: i64,
    folder_id: Option<String>,
    folder_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashPage {
    collection_name: String,
    collection_id: String,
    trash: Vec<TrashSummary>,
    next_offset: Option<u32>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct FolderSummary {
    revision: String,
    id: String,
    name: String,
    note_count: usize,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NoteSummary {
    id: String,
    title: String,
    preview: String,
    folder_id: Option<String>,
    folder_name: Option<String>,
    updated_at: i64,
    is_pinned: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct FoldersPage {
    collection_name: String,
    collection_id: String,
    folders: Vec<FolderSummary>,
    next_offset: Option<u32>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NotesPage {
    collection_name: String,
    collection_id: String,
    notes: Vec<NoteSummary>,
    next_offset: Option<u32>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NoteDetail {
    revision: String,
    collection_name: String,
    collection_id: String,
    id: String,
    title: String,
    content: String,
    updated_at: i64,
    is_title_locked: bool,
    is_pinned: bool,
    folder_id: Option<String>,
    folder_name: Option<String>,
    offset: u32,
    next_offset: Option<u32>,
    total_length: u32,
    truncated: bool,
}

fn page_size(limit: Option<u32>, maximum: u32, default: u32) -> Result<u32, McpError> {
    let limit = limit.unwrap_or(default);
    if !(1..=maximum).contains(&limit) {
        return Err(McpError::invalid_params(
            format!("limit must be between 1 and {maximum}"),
            None,
        ));
    }
    Ok(limit)
}

fn preview(content: &str) -> String {
    let flattened: String = content
        .chars()
        .map(|character| match character {
            '\n' | '\r' => ' ',
            other => other,
        })
        .collect();
    let trimmed = flattened.trim();
    if trimmed.chars().count() <= PREVIEW_CHARS {
        trimmed.to_string()
    } else {
        format!(
            "{}…",
            trimmed.chars().take(PREVIEW_CHARS).collect::<String>()
        )
    }
}

fn next_offset(total: usize, offset: u32, limit: u32) -> Option<u32> {
    ((offset as usize).saturating_add(limit as usize) < total).then(|| offset.saturating_add(limit))
}

fn folder_names(snapshot: &Snapshot) -> HashMap<&str, &str> {
    snapshot
        .folders
        .iter()
        .map(|folder| (folder.id.as_str(), folder.name.as_str()))
        .collect()
}

fn note_summary(note: &Note, names: &HashMap<&str, &str>) -> NoteSummary {
    NoteSummary {
        id: note.id.clone(),
        title: note.title.clone(),
        preview: preview(&note.content),
        folder_id: note.folder_id.clone(),
        folder_name: note
            .folder_id
            .as_deref()
            .and_then(|id| names.get(id).copied())
            .map(str::to_owned),
        updated_at: note.updated_at,
        is_pinned: note.is_pinned,
    }
}

fn list_folders_data(snapshot: &Snapshot, limit: u32, offset: u32) -> FoldersPage {
    let total = snapshot.folders.len();
    let folders = snapshot
        .folders
        .iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(|folder| FolderSummary {
            revision: snapshot
                .folder_revisions
                .get(&folder.id)
                .cloned()
                .unwrap_or_default(),
            id: folder.id.clone(),
            name: folder.name.clone(),
            note_count: snapshot
                .notes
                .iter()
                .filter(|note| note.folder_id.as_deref() == Some(folder.id.as_str()))
                .count(),
        })
        .collect();
    FoldersPage {
        collection_name: snapshot.collection_name.clone(),
        collection_id: snapshot.collection_id.clone(),
        folders,
        next_offset: next_offset(total, offset, limit),
    }
}

fn list_notes_data(
    snapshot: &Snapshot,
    folder_filter: &FolderFilter,
    limit: u32,
    offset: u32,
) -> NotesPage {
    let names = folder_names(snapshot);
    let matching: Vec<_> = snapshot
        .notes
        .iter()
        .filter(|note| folder_filter.includes(note))
        .collect();
    let notes = matching
        .iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(|note| note_summary(note, &names))
        .collect();
    NotesPage {
        collection_name: snapshot.collection_name.clone(),
        collection_id: snapshot.collection_id.clone(),
        next_offset: next_offset(matching.len(), offset, limit),
        notes,
    }
}

fn search_notes_data(
    snapshot: &Snapshot,
    query: &str,
    folder_filter: &FolderFilter,
    limit: u32,
    offset: u32,
) -> NotesPage {
    let query = query.to_lowercase();
    let names = folder_names(snapshot);
    let matching: Vec<_> = snapshot
        .notes
        .iter()
        .filter(|note| folder_filter.includes(note))
        .filter(|note| {
            note.title.to_lowercase().contains(&query)
                || note.content.to_lowercase().contains(&query)
        })
        .collect();
    let notes = matching
        .iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(|note| note_summary(note, &names))
        .collect();
    NotesPage {
        collection_name: snapshot.collection_name.clone(),
        collection_id: snapshot.collection_id.clone(),
        next_offset: next_offset(matching.len(), offset, limit),
        notes,
    }
}

fn get_note_data(
    snapshot: &Snapshot,
    id: &str,
    offset: u32,
    limit: u32,
) -> Result<NoteDetail, String> {
    let note = snapshot
        .notes
        .iter()
        .find(|note| note.id == id)
        .ok_or_else(|| format!("No note exists with id `{id}`."))?;
    let total_length = u32::try_from(note.content.chars().count())
        .map_err(|_| "This note is too large to address with character offsets.".to_string())?;
    if offset > total_length {
        return Err(format!(
            "Content offset {offset} exceeds the note length of {total_length} characters."
        ));
    }
    let content: String = note
        .content
        .chars()
        .skip(offset as usize)
        .take(limit as usize)
        .collect();
    let returned = u32::try_from(content.chars().count())
        .map_err(|_| "The returned note chunk is too large.".to_string())?;
    let end = offset.saturating_add(returned);
    let truncated = end < total_length;
    let names = folder_names(snapshot);
    Ok(NoteDetail {
        revision: snapshot
            .note_revisions
            .get(&note.id)
            .cloned()
            .unwrap_or_default(),
        collection_name: snapshot.collection_name.clone(),
        collection_id: snapshot.collection_id.clone(),
        id: note.id.clone(),
        title: note.title.clone(),
        content,
        updated_at: note.updated_at,
        is_title_locked: note.is_title_locked,
        is_pinned: note.is_pinned,
        folder_id: note.folder_id.clone(),
        folder_name: note
            .folder_id
            .as_deref()
            .and_then(|folder_id| names.get(folder_id).copied())
            .map(str::to_owned),
        offset,
        next_offset: truncated.then_some(end),
        total_length,
        truncated,
    })
}

fn successful_result<T: Serialize>(value: T) -> Result<CallToolResult, McpError> {
    serde_json::to_value(value)
        .map(CallToolResult::structured)
        .map_err(|error| McpError::internal_error(error.to_string(), None))
}

fn tool_error(message: String) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message)])
}

fn check_request_id(request_id: &str) -> Result<(), McpError> {
    if request_id.trim().is_empty() || request_id.chars().count() > 128 {
        return Err(McpError::invalid_params(
            "requestId must contain 1-128 characters",
            None,
        ));
    }
    Ok(())
}

fn outcome(result: Result<serde_json::Value, String>) -> Result<CallToolResult, McpError> {
    match result {
        Ok(value) => successful_result(value),
        Err(error) => Ok(tool_error(error)),
    }
}

#[derive(Clone)]
struct SodilaudServer {
    registry: SharedRegistry,
    permissions: Permissions,
    /// The running app, to show what agents push or open. Tests run without one.
    app: Option<tauri::AppHandle>,
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

impl SodilaudServer {
    fn new(
        registry: SharedRegistry,
        permissions: Permissions,
        app: Option<tauri::AppHandle>,
    ) -> Self {
        Self {
            registry,
            permissions,
            app,
            tool_router: Self::tool_router(),
        }
    }

    fn is_allowed(&self, operation: &str) -> Result<bool, McpError> {
        let permissions = self
            .permissions
            .read()
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        Ok(permissions.contains(operation))
    }

    async fn write(
        &self,
        operation: &'static str,
        arguments: serde_json::Value,
    ) -> Result<CallToolResult, McpError> {
        let appending = operation == "append_to_note";
        if !self.is_allowed(operation)? {
            return Ok(tool_error(format!(
                "Permission for {operation} is disabled. Enable it in MCP Configuration."
            )));
        }
        let request_id = arguments["requestId"].as_str().unwrap_or_default();
        if request_id.trim().is_empty() || request_id.chars().count() > 128 {
            return Err(McpError::invalid_params(
                "requestId must contain 1-128 characters",
                None,
            ));
        }
        let deleting = operation == "delete_note" || operation == "delete_folder";
        let changing_folder = operation == "rename_folder" || operation == "delete_folder";
        let editing = appending
            || changing_folder
            || operation == "rename_note"
            || operation == "move_note"
            || deleting;
        if editing {
            let id = arguments[if changing_folder {
                "folderId"
            } else {
                "noteId"
            }]
            .as_str()
            .unwrap_or_default();
            let revision = arguments["expectedRevision"].as_str().unwrap_or_default();
            if id.trim().is_empty()
                || id.chars().count() > 200
                || revision.trim().is_empty()
                || revision.len() > 128
            {
                return Err(McpError::invalid_params("Editing requires an existing ID and expectedRevision from get_note or list_folders", None));
            }
        }
        if appending {
            let content = arguments["content"].as_str().unwrap_or_default();
            if content.is_empty() || content.len() > 100_000 {
                return Err(McpError::invalid_params(
                    "Appending requires 1-100000 UTF-8 bytes of content",
                    None,
                ));
            }
        } else if operation == "move_note" {
            if !arguments["folderId"].is_null() {
                let id = arguments["folderId"].as_str().unwrap_or_default();
                if id.trim().is_empty() || id.chars().count() > 200 {
                    return Err(McpError::invalid_params(
                        "folderId must be an existing folder ID or null for top level",
                        None,
                    ));
                }
            }
        } else if !deleting {
            let field = if operation == "create_note" || operation == "rename_note" {
                "title"
            } else {
                "name"
            };
            let name = arguments[field].as_str().unwrap_or_default().trim();
            if name.is_empty()
                || name.chars().count() > 200
                || arguments["content"].as_str().unwrap_or_default().len() > 100_000
            {
                return Err(McpError::invalid_params("Name/title must contain 1-200 characters and content at most 100000 UTF-8 bytes", None));
            }
        }
        match self.registry.agent_write(operation, &arguments) {
            Ok(result) => successful_result(result),
            Err(error) => Ok(tool_error(error)),
        }
    }

    fn denied(&self, tool: &str) -> Result<Option<CallToolResult>, McpError> {
        Ok((!self.is_allowed(tool)?).then(|| {
            tool_error(format!(
                "Permission for {tool} is disabled. Enable it in MCP Configuration."
            ))
        }))
    }

    fn with_snapshot<T>(&self, operation: impl FnOnce(&Snapshot) -> T) -> Result<T, McpError> {
        self.registry
            .with(|workspace| Ok(operation(&snapshot_of(workspace))))
            .map_err(|error| McpError::internal_error(error, None))
    }
}

#[tool_router]
impl SodilaudServer {
    /// Append exact text to an existing note. Requires separate editing permission and a current get_note revision. It appears live in an open editor without disturbing the user's typing. Retry identical arguments after a failure; a requestId is never applied twice.
    #[tool(annotations(
        title = "Append to note",
        read_only_hint = false,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn append_to_note(
        &self,
        Parameters(args): Parameters<AppendNoteArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.write(
            "append_to_note",
            serde_json::to_value(args)
                .map_err(|e| McpError::internal_error(e.to_string(), None))?,
        )
        .await
    }

    /// Create a note without changing the editor selection. Requires explicit write access.
    #[tool(annotations(
        title = "Create note",
        read_only_hint = false,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn create_note(
        &self,
        Parameters(args): Parameters<CreateNoteArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.write(
            "create_note",
            serde_json::to_value(args)
                .map_err(|e| McpError::internal_error(e.to_string(), None))?,
        )
        .await
    }

    /// Put a note into Quick Notes for the user: a list of commands, the result of a chat with no project to save into. It goes into the "From agents" folder of the collection open now (created if missing), and by default the Quick Notes panel shows it without taking keyboard focus. Needs no collectionId. Retry identical arguments after a failure; a requestId is never applied twice. Follow up with append_to_note using the returned note ID and revision.
    #[tool(annotations(
        title = "Push quick note",
        read_only_hint = false,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn push_quick_note(
        &self,
        Parameters(args): Parameters<PushQuickNoteArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.is_allowed("push_quick_note")? {
            return Ok(tool_error(
                "Permission for push_quick_note is disabled. Enable it in MCP Configuration."
                    .into(),
            ));
        }
        if args.request_id.trim().is_empty() || args.request_id.chars().count() > 128 {
            return Err(McpError::invalid_params(
                "requestId must contain 1-128 characters",
                None,
            ));
        }
        let title = args.title.trim();
        if title.is_empty() || title.chars().count() > 200 || args.content.len() > 100_000 {
            return Err(McpError::invalid_params(
                "title must contain 1-200 characters and content at most 100000 UTF-8 bytes",
                None,
            ));
        }
        let show = args.show.unwrap_or(true);
        let arguments = serde_json::to_value(&args)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        let result = match self.registry.agent_write("push_quick_note", &arguments) {
            Ok(result) => result,
            Err(error) => return Ok(tool_error(error)),
        };
        if let (true, Some(app), Some(id)) = (show, &self.app, result["note"]["id"].as_str()) {
            let handle = app.clone();
            let focus = crate::quicknotes::window::Focus::Id(id.to_string());
            let _ = app.run_on_main_thread(move || {
                crate::quicknotes::window::reveal(&handle, focus);
            });
        }
        successful_result(result)
    }

    /// Open a Markdown or text file in Sodilaud's main window so the user can read it there, or switch to it if it is already open. Takes an absolute path to an existing .md, .markdown or .txt file. Returns the path, name and size, not the content. Safe to repeat.
    #[tool(annotations(
        title = "Open document",
        read_only_hint = false,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn open_document(
        &self,
        Parameters(args): Parameters<OpenDocumentArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.is_allowed("open_document")? {
            return Ok(tool_error(
                "Permission for open_document is disabled. Enable it in MCP Configuration.".into(),
            ));
        }
        let opened = match &self.app {
            Some(app) => crate::files::open_for_agent(app, &args.path),
            None => crate::files::agent_document(&args.path)
                .and_then(|_| Err(crate::files::FileError::not_granted(Path::new(&args.path)))),
        };
        match opened {
            Ok(opened) => {
                self.registry
                    .coedit_mark_file(std::path::Path::new(&opened.path));
                successful_result(opened)
            }
            Err(error) => Ok(tool_error(error.message)),
        }
    }

    /// Create a folder. Requires explicit write access. Retry using the same requestId.
    #[tool(annotations(
        title = "Create folder",
        read_only_hint = false,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn create_folder(
        &self,
        Parameters(args): Parameters<CreateFolderArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.write(
            "create_folder",
            serde_json::to_value(args)
                .map_err(|e| McpError::internal_error(e.to_string(), None))?,
        )
        .await
    }

    /// Rename a note and lock its title against automatic title generation. Requires a current get_note revision. Retry identical arguments after a failure; a requestId is never applied twice.
    #[tool(annotations(
        title = "Rename note",
        read_only_hint = false,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn rename_note(
        &self,
        Parameters(args): Parameters<RenameNoteArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.write(
            "rename_note",
            serde_json::to_value(args)
                .map_err(|e| McpError::internal_error(e.to_string(), None))?,
        )
        .await
    }

    /// Move a note to an existing folder or null for top level, preserving content and pin state. Requires a current get_note revision. Retry identical arguments after a failure; a requestId is never applied twice.
    #[tool(annotations(
        title = "Move note",
        read_only_hint = false,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn move_note(
        &self,
        Parameters(args): Parameters<MoveNoteArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.write(
            "move_note",
            serde_json::to_value(args)
                .map_err(|e| McpError::internal_error(e.to_string(), None))?,
        )
        .await
    }

    /// Rename an existing folder without changing its ID or note assignments. Requires its current revision from list_folders; duplicate and reserved names are rejected. Retry identical arguments after a failure; a requestId is never applied twice.
    #[tool(annotations(
        title = "Rename folder",
        read_only_hint = false,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn rename_folder(
        &self,
        Parameters(args): Parameters<RenameFolderArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.write(
            "rename_folder",
            serde_json::to_value(args)
                .map_err(|e| McpError::internal_error(e.to_string(), None))?,
        )
        .await
    }

    /// Move a note into persistent trash. Requires a current get_note revision. The user can restore it; agents cannot permanently delete trash. Retry identical arguments after a timeout or failure; a requestId is never applied twice.
    #[tool(annotations(
        title = "Delete note",
        read_only_hint = false,
        destructive_hint = true,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn delete_note(
        &self,
        Parameters(args): Parameters<DeleteNoteArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.write(
            "delete_note",
            serde_json::to_value(args)
                .map_err(|e| McpError::internal_error(e.to_string(), None))?,
        )
        .await
    }

    /// Delete an empty folder. Requires a current list_folders revision. Nonempty folders are rejected, including folders containing pinned notes. Move their notes first. Retry identical arguments after a timeout or failure; a requestId is never applied twice.
    #[tool(annotations(
        title = "Delete empty folder",
        read_only_hint = false,
        destructive_hint = true,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn delete_folder(
        &self,
        Parameters(args): Parameters<DeleteFolderArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.write(
            "delete_folder",
            serde_json::to_value(args)
                .map_err(|e| McpError::internal_error(e.to_string(), None))?,
        )
        .await
    }

    /// List the documents an agent can co-edit: files open in Sodilaud's main window, and notes that have comments or that an agent read. Each has its path or noteId, name, version, whether an agent co-edits it and how many owner comments wait for an agent.
    #[tool(annotations(
        title = "List documents",
        read_only_hint = true,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn list_documents(
        &self,
        Parameters(_): Parameters<NoArgs>,
    ) -> Result<CallToolResult, McpError> {
        if let Some(denied) = self.denied("list_documents")? {
            return Ok(denied);
        }
        successful_result(serde_json::json!({ "documents": self.registry.coedit_list() }))
    }

    /// Read a document to co-edit it with the user: a file open in Sodilaud (path) or a note (noteId). Returns the live text, as the user sees it right now, with its version, headings (character offsets) and the comments an agent may act on. The document becomes co-edited: edit it only with apply_edit, passing this version as baseVersion, never with your native file tools. Offsets count Unicode characters; follow nextOffset until it is null.
    #[tool(annotations(
        title = "Read document",
        read_only_hint = true,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn read_document(
        &self,
        Parameters(args): Parameters<ReadDocumentArgs>,
    ) -> Result<CallToolResult, McpError> {
        if let Some(denied) = self.denied("read_document")? {
            return Ok(denied);
        }
        let limit = args.limit.unwrap_or(coedit::DEFAULT_READ_CHARS as u32);
        if limit == 0 || limit as usize > coedit::DEFAULT_READ_CHARS {
            return Err(McpError::invalid_params("limit must be 1-200000", None));
        }
        let doc = match DocRef::parse(args.path.as_deref(), args.note_id.as_deref()) {
            Ok(doc) => doc,
            Err(error) => return Ok(tool_error(error)),
        };
        outcome(
            self.registry
                .coedit_read(&doc, args.offset.unwrap_or(0) as usize, limit as usize),
        )
    }

    /// Edit a co-edited document while the user keeps typing in it. Each edit replaces oldText, copied from the text read_document returned at baseVersion, with newText. Sodilaud finds each oldText (exactly, then ignoring whitespace layout, then a close match), carries it through what the user typed since, and applies all edits that the user did not touch as one change. The user wins: an edit whose text the user changed comes back as a conflict with its currentText. Partial success is normal; reread and retry conflicts. STALE_BASE means baseVersion is too old: call read_document again. Retry identical arguments with the same requestId after a failure.
    #[tool(annotations(
        title = "Apply edit",
        read_only_hint = false,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn apply_edit(
        &self,
        Parameters(args): Parameters<ApplyEditArgs>,
    ) -> Result<CallToolResult, McpError> {
        if let Some(denied) = self.denied("apply_edit")? {
            return Ok(denied);
        }
        check_request_id(&args.request_id)?;
        if args.edits.is_empty() || args.edits.len() > coedit::MAX_EDITS {
            return Err(McpError::invalid_params("edits must hold 1-50 edits", None));
        }
        if args.edits.iter().any(|edit| edit.old_text.is_empty()) {
            return Err(McpError::invalid_params(
                "every oldText must be non-empty",
                None,
            ));
        }
        let doc = match DocRef::parse(args.path.as_deref(), args.note_id.as_deref()) {
            Ok(doc) => doc,
            Err(error) => return Ok(tool_error(error)),
        };
        outcome(
            self.registry
                .coedit_apply(&doc, args.base_version, &args.request_id, &args.edits),
        )
    }

    /// Take the user's comments that wait for an agent, oldest first, and mark them sent. Each has its document, the anchored text with its heading path and two lines of context each side, and the comment. An answer to one of your own comments carries replyTo with your comment. With waitSeconds it waits up to that long (at most 1800) for a comment and returns as soon as one arrives; timedOut is true when none came. Your own comments are never returned. After addressing a comment, call resolve_comment.
    #[tool(annotations(
        title = "Get pending comments",
        read_only_hint = true,
        destructive_hint = false,
        idempotent_hint = false,
        open_world_hint = false
    ))]
    async fn get_pending_comments(
        &self,
        Parameters(args): Parameters<PendingCommentsArgs>,
        cancelled: CancellationToken,
    ) -> Result<CallToolResult, McpError> {
        if let Some(denied) = self.denied("get_pending_comments")? {
            return Ok(denied);
        }
        let wait = args.wait_seconds.unwrap_or(0);
        if wait > MAX_WAIT_SECONDS {
            return Err(McpError::invalid_params("waitSeconds must be 0-1800", None));
        }
        let doc = if args.path.is_some() || args.note_id.is_some() {
            match DocRef::parse(args.path.as_deref(), args.note_id.as_deref()) {
                Ok(doc) => Some(doc),
                Err(error) => return Ok(tool_error(error)),
            }
        } else {
            None
        };
        if let Some(doc) = &doc {
            if let Err(error) = self.registry.coedit_check(doc) {
                return Ok(tool_error(error));
            }
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(wait.into());
        let queued = self.registry.coedit_queued();
        let _listening = (wait > 0).then(|| self.registry.coedit_listen());
        loop {
            let notified = queued.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            // A client that went away must not take comments it will never see.
            if cancelled.is_cancelled() {
                return Ok(tool_error("The request was cancelled".into()));
            }
            let comments = self.registry.coedit_take_pending(doc.as_ref());
            if !comments.is_empty() || tokio::time::Instant::now() >= deadline {
                let timed_out = comments.is_empty() && wait > 0;
                return successful_result(serde_json::json!({
                    "comments": comments,
                    "timedOut": timed_out,
                }));
            }
            tokio::select! {
                _ = &mut notified => {}
                _ = tokio::time::sleep_until(deadline) => {}
                _ = cancelled.cancelled() => {
                    return Ok(tool_error("The request was cancelled".into()));
                }
            }
        }
    }

    /// Leave a comment on a document for the user, to start a review: ask about open questions in a document you wrote or opened. anchorText is exact text in the document now; when it occurs more than once, occurrence (from 1) picks one. The user answers in place, and only the answers come back through get_pending_comments, with replyTo naming your comment. The document becomes co-edited. Retry identical arguments with the same requestId after a failure.
    #[tool(annotations(
        title = "Add comment",
        read_only_hint = false,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn add_comment(
        &self,
        Parameters(args): Parameters<AddCommentArgs>,
    ) -> Result<CallToolResult, McpError> {
        if let Some(denied) = self.denied("add_comment")? {
            return Ok(denied);
        }
        check_request_id(&args.request_id)?;
        let body = args.body.trim();
        if body.is_empty() || body.chars().count() > coedit::MAX_BODY_CHARS {
            return Err(McpError::invalid_params(
                "body must contain 1-2000 characters",
                None,
            ));
        }
        if args.anchor_text.is_empty() || args.occurrence == Some(0) {
            return Err(McpError::invalid_params(
                "anchorText must not be empty and occurrence counts from 1",
                None,
            ));
        }
        let doc = match DocRef::parse(args.path.as_deref(), args.note_id.as_deref()) {
            Ok(doc) => doc,
            Err(error) => return Ok(tool_error(error)),
        };
        outcome(self.registry.coedit_add_comment(
            &doc,
            &args.anchor_text,
            args.occurrence.map(|n| n as usize),
            body,
            &args.request_id,
        ))
    }

    /// Mark a comment addressed, with a one-line note for the user naming what changed, including any other places you changed for consistency. Resolving an answer to your own comment resolves your comment too. Safe to repeat.
    #[tool(annotations(
        title = "Resolve comment",
        read_only_hint = false,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn resolve_comment(
        &self,
        Parameters(args): Parameters<ResolveCommentArgs>,
    ) -> Result<CallToolResult, McpError> {
        if let Some(denied) = self.denied("resolve_comment")? {
            return Ok(denied);
        }
        let note = args.note.trim();
        if args.id.trim().is_empty()
            || note.is_empty()
            || note.chars().count() > coedit::MAX_NOTE_CHARS
        {
            return Err(McpError::invalid_params(
                "id is required and note must contain 1-500 characters",
                None,
            ));
        }
        outcome(self.registry.coedit_resolve(&args.id, note))
    }

    /// List deleted-note metadata in the current collection's trash. Content and permanent deletion are not exposed. Only the user can restore or empty trash in the UI.
    #[tool(annotations(
        title = "List trash",
        read_only_hint = true,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn list_trash(
        &self,
        Parameters(args): Parameters<ListFoldersArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.is_allowed("list_trash")? {
            return Ok(tool_error(
                "Permission for list_trash is disabled. Enable it in MCP Configuration.".into(),
            ));
        }
        let limit = page_size(args.limit, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE)?;
        let offset = args.offset.unwrap_or(0);
        successful_result(self.with_snapshot(|snapshot| {
            TrashPage {
                collection_name: snapshot.collection_name.clone(),
                collection_id: snapshot.collection_id.clone(),
                trash: snapshot
                    .trash
                    .iter()
                    .rev()
                    .skip(offset as usize)
                    .take(limit as usize)
                    .cloned()
                    .collect(),
                next_offset: next_offset(snapshot.trash.len(), offset, limit),
            }
        })?)
    }

    /// List folders in sidebar order, including the number of assigned notes.
    #[tool(annotations(
        title = "List folders",
        read_only_hint = true,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn list_folders(
        &self,
        Parameters(args): Parameters<ListFoldersArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.is_allowed("list_folders")? {
            return Ok(tool_error(
                "Permission for list_folders is disabled. Enable it in MCP Configuration.".into(),
            ));
        }
        let limit = page_size(args.limit, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE)?;
        let page = self.with_snapshot(|snapshot| {
            list_folders_data(snapshot, limit, args.offset.unwrap_or(0))
        })?;
        successful_result(page)
    }

    /// List note metadata and short previews in sidebar order. Use get_note for content.
    #[tool(annotations(
        title = "List notes",
        read_only_hint = true,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn list_notes(
        &self,
        Parameters(args): Parameters<ListNotesArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.is_allowed("list_notes")? {
            return Ok(tool_error(
                "Permission for list_notes is disabled. Enable it in MCP Configuration.".into(),
            ));
        }
        let limit = page_size(args.limit, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE)?;
        let page = self.with_snapshot(|snapshot| {
            list_notes_data(snapshot, &args.folder_id, limit, args.offset.unwrap_or(0))
        })?;
        successful_result(page)
    }

    /// Search note titles and Markdown content for literal text.
    #[tool(annotations(
        title = "Search notes",
        read_only_hint = true,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn search_notes(
        &self,
        Parameters(args): Parameters<SearchNotesArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.is_allowed("search_notes")? {
            return Ok(tool_error(
                "Permission for search_notes is disabled. Enable it in MCP Configuration.".into(),
            ));
        }
        if args.query.trim().is_empty() {
            return Err(McpError::invalid_params("query must not be empty", None));
        }
        let limit = page_size(args.limit, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE)?;
        let page = self.with_snapshot(|snapshot| {
            search_notes_data(
                snapshot,
                &args.query,
                &args.folder_id,
                limit,
                args.offset.unwrap_or(0),
            )
        })?;
        successful_result(page)
    }

    /// Read one note by id, returning a character-addressed chunk of Markdown content.
    #[tool(annotations(
        title = "Get note",
        read_only_hint = true,
        destructive_hint = false,
        idempotent_hint = true,
        open_world_hint = false
    ))]
    async fn get_note(
        &self,
        Parameters(args): Parameters<GetNoteArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.is_allowed("get_note")? {
            return Ok(tool_error(
                "Permission for get_note is disabled. Enable it in MCP Configuration.".into(),
            ));
        }
        if args.id.trim().is_empty() {
            return Err(McpError::invalid_params("id must not be empty", None));
        }
        let limit = page_size(args.limit, MAX_CONTENT_CHARS, DEFAULT_CONTENT_CHARS)?;
        let note = self.with_snapshot(|snapshot| {
            get_note_data(snapshot, &args.id, args.offset.unwrap_or(0), limit)
        })?;
        match note {
            Ok(note) => successful_result(note),
            Err(error) => Ok(tool_error(error)),
        }
    }
}

#[tool_handler]
impl ServerHandler for SodilaudServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("sodilaud-mcp", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Access to the notes collection currently open in Sodilaud, as the editor shows it. Each function requires its permission enabled in MCP Configuration. Read functions start enabled and write functions disabled until the user selects them; choices are remembered across restarts. push_quick_note puts a note into the user's Quick Notes (the From agents folder) and needs no collectionId. open_document opens an absolute .md, .markdown or .txt path in the main window and returns no content. Co-editing: read_document returns a file's or note's live text and version and makes it co-edited; change it only with apply_edit (oldText/newText against that version; the user's typing wins conflicts), never with native file tools. get_pending_comments (with waitSeconds to wait) returns the user's comments anchored to text; address each, then resolve_comment with a one-line note. add_comment asks the user a question on a passage; their answers arrive through get_pending_comments. delete_note moves a note to persistent trash and requires expectedRevision from get_note. delete_folder requires expectedRevision from list_folders and rejects nonempty folders. list_trash lists recovery metadata; only the user can restore or empty trash through the UI. rename_note and move_note require expectedRevision from get_note. rename_folder requires expectedRevision from list_folders. All edits preserve content except append_to_note, which requires the expectedRevision from get_note, appends exact text, and never adds separators; line breaks are stored as \\n. A revision conflict requires rereading; after a failure or timeout, retry identical arguments with the same requestId, which never applies a write twice. Get collectionId from a read result and supply a unique requestId for each write; reuse identical arguments on retries. Retry keys last for this collection session; a switch or app restart invalidates collectionId. Results are paginated; follow nextOffset until it is null. get_note offsets count Unicode characters, not bytes.",
            )
    }

    fn accepted_subscription_filter(
        &self,
        requested: &SubscriptionFilter,
    ) -> Option<SubscriptionFilter> {
        // Some clients establish a modern notification stream even when the
        // server advertises no list-change capabilities. Acknowledge the
        // supported intersection (currently empty) so tool discovery remains
        // usable without claiming that Sodilaud emits change notifications.
        Some(requested.supported_by(&self.get_info().capabilities))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Default)]
    pub(crate) struct McpRecorder(pub(crate) std::sync::Mutex<Vec<McpStateChanged>>);

    impl McpEvents for McpRecorder {
        fn state_changed(&self, event: &McpStateChanged) {
            self.0.lock().unwrap().push(event.clone());
        }
    }
    use tokio::io::{AsyncBufReadExt, BufReader};

    fn snapshot() -> Snapshot {
        Snapshot {
            collection_name: "Project notes".into(),
            collection_id: "test-collection".into(),
            note_revisions: HashMap::from([("one".into(), "revision-one".into())]),
            folder_revisions: HashMap::from([("work".into(), "revision-work".into())]),
            trash: vec![],
            folders: vec![Folder {
                id: "work".into(),
                name: "Work".into(),
            }],
            notes: vec![
                Note {
                    id: "one".into(),
                    title: "First".into(),
                    content: "Live unsaved body with café".into(),
                    updated_at: 20,
                    is_title_locked: true,
                    is_pinned: true,
                    folder_id: Some("work".into()),
                },
                Note {
                    id: "two".into(),
                    title: "Second".into(),
                    content: "Other body".into(),
                    updated_at: 10,
                    is_title_locked: false,
                    is_pinned: false,
                    folder_id: None,
                },
            ],
        }
    }

    /// A registry holding the fixture's notes and folders, under the fixture's
    /// collection id so requests can name it.
    fn registry() -> (SharedRegistry, std::path::PathBuf) {
        let fixture = snapshot();
        let path = crate::store::workspace::tests::temporary_db_path("mcp");
        let mut conn = crate::store::workspace::open(&path).unwrap();
        let notes: Vec<&Note> = fixture.notes.iter().collect();
        crate::store::workspace::save_all(&mut conn, &notes, &fixture.folders, &[]).unwrap();
        drop(conn);
        let registry = SharedRegistry::default();
        registry.open(&path, false).unwrap();
        registry
            .with(|workspace| {
                workspace.id = fixture.collection_id.clone();
                Ok(())
            })
            .unwrap();
        (registry, path)
    }

    fn server() -> (SodilaudServer, Permissions, std::path::PathBuf) {
        let (registry, path) = registry();
        let permissions = Arc::new(RwLock::new(read_permissions()));
        (
            SodilaudServer::new(registry, permissions.clone(), None),
            permissions,
            path,
        )
    }

    fn revision(registry: &SharedRegistry, id: &str) -> String {
        registry
            .with(|workspace| Ok(snapshot_of(workspace).note_revisions[id].clone()))
            .unwrap()
    }

    #[test]
    fn saved_permissions_restore_choices_and_default_new_tools() {
        assert_eq!(saved_permissions(&McpConfig::default()), read_permissions());
        let config = McpConfig {
            enabled: true,
            permissions: [
                ("get_note".to_string(), false),
                ("create_note".to_string(), true),
                ("unknown".to_string(), true),
            ]
            .into(),
            ..McpConfig::default()
        };
        let restored = saved_permissions(&config);
        assert!(!restored.contains("get_note"));
        assert!(restored.contains("create_note"));
        assert!(
            restored.contains("list_notes"),
            "a read missing from the map starts on"
        );
        assert!(
            !restored.contains("append_to_note"),
            "a write missing from the map starts off"
        );
        assert!(!restored.contains("unknown"));
        let saved = McpConfig {
            enabled: true,
            permissions: permission_map(&restored),
            ..McpConfig::default()
        };
        assert_eq!(
            saved.permissions.len(),
            READ_TOOLS.len() + WRITE_TOOLS.len()
        );
        assert_eq!(saved_permissions(&saved), restored);
    }

    fn config_file() -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("sodilaud-mcp-events-{}", Uuid::new_v4().simple()))
            .join(mcp_config::FILE_NAME)
    }

    async fn pretend_running(state: &McpState) {
        *state.running.lock().await = Some(RunningServer {
            cancellation: CancellationToken::new(),
            task: tokio::spawn(async {}),
            connection: McpConnectionInfo {
                command: "/sodilaud".into(),
                args: vec!["--mcp-stdio".into()],
            },
        });
    }

    #[tokio::test]
    async fn permission_changes_and_stopping_tell_every_window() {
        let state = McpState::default();
        let recorder = Arc::new(McpRecorder::default());
        state.set_events(recorder.clone());
        let path = config_file();
        pretend_running(&state).await;

        state
            .set_permissions(&path, vec!["create_note".into(), "list_notes".into()])
            .await
            .unwrap();
        assert!(state
            .set_permissions(&path, vec!["unknown".into()])
            .await
            .is_err());
        state.stop(&path).await.unwrap();

        let events = recorder.0.lock().unwrap().clone();
        let events: Vec<serde_json::Value> = events
            .iter()
            .map(|event| serde_json::to_value(event).unwrap())
            .collect();
        assert_eq!(
            events,
            vec![
                serde_json::json!({ "enabled": true, "tools": ["list_notes", "create_note"], "error": null, "integration": null }),
                serde_json::json!({ "enabled": false, "tools": [], "error": null, "integration": null }),
            ],
            "a refused change announces nothing"
        );
        assert!(!mcp_config::load(&path).enabled);
        assert_eq!(
            mcp_config::load(&path).permissions.get("create_note"),
            Some(&true)
        );
    }

    #[tokio::test]
    async fn function_permissions_are_independent_and_reads_can_be_revoked() {
        let (server, permissions, path) = server();
        assert!(server.is_allowed("get_note").unwrap());
        assert!(!server.is_allowed("create_note").unwrap());
        assert!(permission_set(vec!["unknown".into()]).is_err());
        *permissions.write().unwrap() = permission_set(vec!["create_note".into()]).unwrap();
        assert!(server.is_allowed("create_note").unwrap());
        assert!(!server.is_allowed("create_folder").unwrap());
        assert!(!server.is_allowed("append_to_note").unwrap());
        assert!(server
            .list_folders(Parameters(ListFoldersArgs {
                limit: None,
                offset: None
            }))
            .await
            .unwrap()
            .is_error
            .unwrap());
        assert!(server
            .list_notes(Parameters(ListNotesArgs {
                folder_id: FolderFilter::All,
                limit: None,
                offset: None
            }))
            .await
            .unwrap()
            .is_error
            .unwrap());
        assert!(server
            .search_notes(Parameters(SearchNotesArgs {
                query: "café".into(),
                folder_id: FolderFilter::All,
                limit: None,
                offset: None
            }))
            .await
            .unwrap()
            .is_error
            .unwrap());
        assert!(server
            .get_note(Parameters(GetNoteArgs {
                id: "one".into(),
                offset: None,
                limit: None
            }))
            .await
            .unwrap()
            .is_error
            .unwrap());
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn trash_listing_is_paginated_metadata_only_and_permission_gated() {
        let (server, permissions, path) = server();
        server
            .registry
            .with(|workspace| {
                workspace.trash = (0..3)
                    .map(|index| crate::store::workspace::TrashEntry {
                        id: format!("trash-{index}"),
                        note: Note {
                            id: format!("note-{index}"),
                            title: format!("Deleted {index}"),
                            content: "secret body".into(),
                            updated_at: index,
                            is_title_locked: true,
                            is_pinned: false,
                            folder_id: Some("old-folder".into()),
                        },
                        deleted_at: index,
                        folder_name: Some("Old folder".into()),
                    })
                    .collect();
                Ok(())
            })
            .unwrap();
        let first = server
            .list_trash(Parameters(ListFoldersArgs {
                limit: Some(2),
                offset: None,
            }))
            .await
            .unwrap();
        let value = serde_json::to_value(first).unwrap();
        let page = &value["structuredContent"];
        assert_eq!(page["collectionId"], "test-collection");
        assert_eq!(page["trash"][0]["id"], "trash-2");
        assert_eq!(page["nextOffset"], 2);
        assert!(page["trash"][0].get("content").is_none());
        assert!(page["trash"][0].get("note").is_none());
        let last = server
            .list_trash(Parameters(ListFoldersArgs {
                limit: Some(2),
                offset: Some(2),
            }))
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(last).unwrap()["structuredContent"]["trash"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        permissions.write().unwrap().remove("list_trash");
        assert!(server
            .list_trash(Parameters(ListFoldersArgs {
                limit: None,
                offset: None
            }))
            .await
            .unwrap()
            .is_error
            .unwrap());
        for forbidden in ["empty_trash", "purge_trash", "restore_note"] {
            assert!(permission_set(vec![forbidden.into()]).is_err());
        }
        for operation in ["delete_note", "delete_folder"] {
            assert!(!server.is_allowed(operation).unwrap());
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn move_requires_an_explicit_nullable_destination() {
        let mut args = serde_json::json!({"collectionId":"test-collection", "requestId":"move", "noteId":"one", "expectedRevision":"revision-one"});
        assert!(serde_json::from_value::<MoveNoteArgs>(args.clone()).is_err());
        args["folderId"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<MoveNoteArgs>(args.clone())
            .unwrap()
            .folder_id
            .is_none());
        args["folderId"] = serde_json::json!("work");
        assert_eq!(
            serde_json::from_value::<MoveNoteArgs>(args)
                .unwrap()
                .folder_id
                .as_deref(),
            Some("work")
        );
        let schema = serde_json::to_value(schemars::schema_for!(MoveNoteArgs)).unwrap();
        assert_eq!(
            schema["properties"]["folderId"]["type"],
            serde_json::json!(["string", "null"])
        );
        assert!(schema["required"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("folderId")));
    }

    #[tokio::test]
    async fn organization_tools_enforce_independent_permissions_and_validate_inputs() {
        let (server, permissions, path) = server();
        for (operation, args) in [
            (
                "rename_note",
                serde_json::json!({"collectionId":"test-collection", "requestId":"rename-note", "noteId":"one", "expectedRevision":"revision-one", "title":"New title"}),
            ),
            (
                "move_note",
                serde_json::json!({"collectionId":"test-collection", "requestId":"move", "noteId":"one", "expectedRevision":"revision-one", "folderId":null}),
            ),
            (
                "rename_folder",
                serde_json::json!({"collectionId":"test-collection", "requestId":"rename-folder", "folderId":"work", "expectedRevision":"revision-work", "name":"Projects"}),
            ),
        ] {
            assert!(server
                .write(operation, args.clone())
                .await
                .unwrap()
                .is_error
                .unwrap());
            *permissions.write().unwrap() = permission_set(vec![operation.into()]).unwrap();
            for other in WRITE_TOOLS {
                assert_eq!(server.is_allowed(other).unwrap(), other == operation);
            }
            let mut invalid = args.clone();
            invalid["expectedRevision"] = serde_json::json!("");
            assert!(server.write(operation, invalid).await.is_err());
            let mut invalid = args.clone();
            invalid[match operation {
                "rename_note" => "title",
                "move_note" => "folderId",
                _ => "name",
            }] = serde_json::json!(" ");
            assert!(server.write(operation, invalid).await.is_err());
            // Valid arguments reach the registry, which checks the revision.
            let result = server.write(operation, args).await.unwrap();
            assert!(serde_json::to_string(&result)
                .unwrap()
                .contains("Revision conflict"));
            permissions.write().unwrap().clear();
        }
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn push_quick_note_is_gated_validated_and_lands_in_from_agents() {
        let (server, permissions, path) = server();
        let push = |args: serde_json::Value| {
            server.push_quick_note(Parameters(serde_json::from_value(args).unwrap()))
        };
        let off = push(serde_json::json!({"requestId": "p", "title": "T"}))
            .await
            .unwrap();
        assert_eq!(off.is_error, Some(true));
        permissions
            .write()
            .unwrap()
            .insert("push_quick_note".into());
        for invalid in [
            serde_json::json!({"requestId": "", "title": "T"}),
            serde_json::json!({"requestId": "x".repeat(129), "title": "T"}),
            serde_json::json!({"requestId": "p", "title": "  "}),
            serde_json::json!({"requestId": "p", "title": "t".repeat(201)}),
            serde_json::json!({"requestId": "p", "title": "T", "content": "x".repeat(100_001)}),
        ] {
            assert!(push(invalid).await.is_err());
        }
        let pushed = push(serde_json::json!({"requestId": "p", "title": "T", "show": false}))
            .await
            .unwrap();
        assert_eq!(pushed.is_error, Some(false));
        let result = pushed.structured_content.unwrap();
        assert_eq!(result["collectionId"], "test-collection");
        assert!(result["revision"].is_string());
        let again = push(serde_json::json!({"requestId": "p", "title": "T", "show": true}))
            .await
            .unwrap();
        assert_eq!(
            again.structured_content.unwrap(),
            result,
            "show does not change the request"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn open_document_is_gated_and_checks_the_path_first() {
        let (server, permissions, path) = server();
        let open = |path: &str| {
            server.open_document(Parameters(
                serde_json::from_value(serde_json::json!({ "path": path })).unwrap(),
            ))
        };
        let message = |result: CallToolResult| {
            assert_eq!(result.is_error, Some(true));
            serde_json::to_value(&result.content).unwrap()[0]["text"]
                .as_str()
                .unwrap()
                .to_string()
        };
        assert!(message(open("/tmp/x.md").await.unwrap()).contains("disabled"));
        permissions.write().unwrap().insert("open_document".into());
        assert!(message(open("notes/x.md").await.unwrap()).contains("full path"));
        let missing = std::env::temp_dir().join(format!("sodilaud-missing-{}.md", Uuid::new_v4()));
        assert!(
            message(open(missing.to_str().unwrap()).await.unwrap()).contains("no longer on disk")
        );
        std::fs::remove_file(path).unwrap();
    }

    fn structured(result: CallToolResult) -> serde_json::Value {
        assert_ne!(result.is_error, Some(true), "{:?}", result.content);
        result.structured_content.unwrap()
    }

    fn error_text(result: CallToolResult) -> String {
        assert_eq!(result.is_error, Some(true));
        serde_json::to_value(&result.content).unwrap()[0]["text"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn args<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> Parameters<T> {
        Parameters(serde_json::from_value(value).unwrap())
    }

    #[tokio::test]
    async fn co_editing_tools_read_merge_comment_and_resolve() {
        let (server, permissions, path) = server();
        let read = structured(
            server
                .read_document(args(serde_json::json!({ "noteId": "two" })))
                .await
                .unwrap(),
        );
        assert_eq!(read["content"], "Other body");
        let apply = serde_json::json!({ "noteId": "two", "baseVersion": read["version"],
            "requestId": "e1", "edits": [{ "oldText": "Other", "newText": "Another" }] });
        assert!(
            error_text(server.apply_edit(args(apply.clone())).await.unwrap()).contains("disabled")
        );
        for tool in ["apply_edit", "add_comment", "resolve_comment"] {
            permissions.write().unwrap().insert(tool.into());
        }
        let applied = structured(server.apply_edit(args(apply)).await.unwrap());
        assert_eq!(applied["applied"], serde_json::json!([0]));
        let comment = structured(
            server
                .add_comment(args(
                    serde_json::json!({ "noteId": "two", "anchorText": "body",
                    "body": "Is this right?", "requestId": "c1" }),
                ))
                .await
                .unwrap(),
        );
        let id = comment["comment"]["id"].as_str().unwrap().to_string();
        let listed = structured(
            server
                .list_documents(args(serde_json::json!({})))
                .await
                .unwrap(),
        );
        assert_eq!(listed["documents"][0]["noteId"], "two");
        assert_eq!(listed["documents"][0]["coEdited"], true);
        let resolved = structured(
            server
                .resolve_comment(args(serde_json::json!({ "id": id, "note": "Answered" })))
                .await
                .unwrap(),
        );
        assert_eq!(resolved["comment"]["state"], "resolved");
        assert!(error_text(
            server
                .read_document(args(serde_json::json!({ "path": "relative.md" })))
                .await
                .unwrap()
        )
        .contains("full path"));
        assert!(server
            .apply_edit(args(serde_json::json!({ "noteId": "two", "baseVersion": 0,
                "requestId": "e2", "edits": [] })))
            .await
            .is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn a_long_poll_returns_a_new_comment_and_a_cancelled_one_takes_nothing() {
        let (server, _, path) = server();
        let note = crate::docs::coedit::PageDoc::Note {
            collection_id: "test-collection".into(),
            note_id: "two".into(),
        };
        let empty = structured(
            server
                .get_pending_comments(args(serde_json::json!({})), CancellationToken::new())
                .await
                .unwrap(),
        );
        assert_eq!(
            empty,
            serde_json::json!({ "comments": [], "timedOut": false })
        );
        let registry = server.registry.clone();
        let poll = tokio::spawn({
            let server = server.clone();
            async move {
                server
                    .get_pending_comments(
                        args(serde_json::json!({ "noteId": "two", "waitSeconds": 30 })),
                        CancellationToken::new(),
                    )
                    .await
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(registry.coedit_state().listening);
        registry
            .comment_add(&note, 0, (0, 5), "Tighten this", None)
            .unwrap();
        let woken = structured(
            tokio::time::timeout(std::time::Duration::from_secs(5), poll)
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
        );
        assert_eq!(woken["comments"][0]["body"], "Tighten this");
        assert_eq!(woken["timedOut"], false);
        assert!(!registry.coedit_state().listening);

        let cancelled = CancellationToken::new();
        let poll = tokio::spawn({
            let server = server.clone();
            let cancelled = cancelled.clone();
            async move {
                server
                    .get_pending_comments(args(serde_json::json!({ "waitSeconds": 30 })), cancelled)
                    .await
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        cancelled.cancel();
        assert_eq!(poll.await.unwrap().unwrap().is_error, Some(true));
        registry
            .comment_add(&note, 0, (0, 5), "Later", None)
            .unwrap();
        let later = structured(
            server
                .get_pending_comments(args(serde_json::json!({})), CancellationToken::new())
                .await
                .unwrap(),
        );
        assert_eq!(later["comments"][0]["body"], "Later");
        assert!(server
            .get_pending_comments(
                args(serde_json::json!({ "waitSeconds": 1801 })),
                CancellationToken::new()
            )
            .await
            .is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn an_append_reaches_the_registry_once_per_request_id() {
        let (server, permissions, path) = server();
        permissions.write().unwrap().insert("append_to_note".into());
        let args = serde_json::json!({"collectionId":"test-collection", "requestId":"a1", "noteId":"two",
            "expectedRevision": revision(&server.registry, "two"), "content":" appended"});
        for _ in 0..2 {
            let result = server.write("append_to_note", args.clone()).await.unwrap();
            assert_eq!(result.is_error, Some(false), "{result:?}");
        }
        let content = server
            .registry
            .with(|workspace| Ok(workspace.notes[1].note.content.clone()))
            .unwrap();
        assert_eq!(content, "Other body appended");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn lists_and_searches_the_live_snapshot_in_sidebar_order() {
        let snapshot = snapshot();
        let folders = list_folders_data(&snapshot, 50, 0);
        assert_eq!(folders.collection_name, "Project notes");
        assert_eq!(folders.folders[0].note_count, 1);
        assert_eq!(folders.folders[0].revision, "revision-work");

        let page = list_notes_data(&snapshot, &FolderFilter::All, 1, 0);
        assert_eq!(page.notes[0].id, "one");
        assert_eq!(page.next_offset, Some(1));

        let search = search_notes_data(&snapshot, "CAFÉ", &FolderFilter::All, 50, 0);
        assert_eq!(search.notes.len(), 1);
        assert_eq!(search.notes[0].id, "one");
    }

    #[test]
    fn list_and_search_folder_filters_distinguish_omitted_null_and_id() {
        let all = serde_json::from_value::<ListNotesArgs>(serde_json::json!({})).unwrap();
        assert_eq!(all.folder_id, FolderFilter::All);
        let top_level =
            serde_json::from_value::<ListNotesArgs>(serde_json::json!({"folderId": null})).unwrap();
        assert_eq!(top_level.folder_id, FolderFilter::TopLevel);
        let folder = serde_json::from_value::<SearchNotesArgs>(
            serde_json::json!({"query": "body", "folderId": "work"}),
        )
        .unwrap();
        assert_eq!(folder.folder_id, FolderFilter::Folder("work".into()));
        assert!(
            serde_json::from_value::<ListNotesArgs>(serde_json::json!({"folderId": 42})).is_err()
        );

        let snapshot = snapshot();
        let top_level = list_notes_data(&snapshot, &FolderFilter::TopLevel, 50, 0);
        assert_eq!(
            top_level
                .notes
                .iter()
                .map(|note| note.id.as_str())
                .collect::<Vec<_>>(),
            ["two"]
        );
        let folder = search_notes_data(
            &snapshot,
            "body",
            &FolderFilter::Folder("work".into()),
            50,
            0,
        );
        assert_eq!(
            folder
                .notes
                .iter()
                .map(|note| note.id.as_str())
                .collect::<Vec<_>>(),
            ["one"]
        );

        for schema in [
            schemars::schema_for!(ListNotesArgs),
            schemars::schema_for!(SearchNotesArgs),
        ] {
            let schema = serde_json::to_value(schema).unwrap();
            assert_eq!(
                schema["properties"]["folderId"]["type"],
                serde_json::json!(["string", "null"])
            );
            assert!(!schema["required"]
                .as_array()
                .is_some_and(|required| required.contains(&serde_json::json!("folderId"))));
        }
    }

    #[test]
    fn accept_errors_retry_unless_the_listener_is_unusable() {
        for kind in [
            std::io::ErrorKind::ConnectionAborted,
            std::io::ErrorKind::Other,
            std::io::ErrorKind::PermissionDenied,
        ] {
            assert!(should_retry_accept(&std::io::Error::from(kind)));
        }
        for kind in [
            std::io::ErrorKind::InvalidInput,
            std::io::ErrorKind::NotConnected,
            std::io::ErrorKind::Unsupported,
        ] {
            assert!(!should_retry_accept(&std::io::Error::from(kind)));
        }
    }

    #[test]
    fn reads_unicode_content_by_character_offset() {
        let snapshot = snapshot();
        let note = get_note_data(&snapshot, "one", 23, 4).expect("note should be readable");
        assert_eq!(note.content, "café");
        assert_eq!(note.total_length, 27);
        assert!(!note.truncated);
    }

    #[tokio::test]
    async fn local_channel_rejects_invalid_authentication() {
        let (address, _, _, cancellation, task) = start_test_server().await;
        assert!(connect_to_editor(address, &"b".repeat(64)).await.is_err());
        let connection = connect_to_editor(address, &"a".repeat(64)).await;
        assert!(connection.is_ok());
        cancellation.cancel();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn request_limit_applies_per_line_and_rejects_unterminated_input() {
        let mut reader = BoundedMessageReader::new(&b"abc\ndef\n"[..]);
        let mut content = String::new();
        reader.read_to_string(&mut content).await.unwrap();
        assert_eq!(content, "abc\ndef\n");
        assert_eq!(reader.line_bytes, 0);

        let oversized = vec![b'x'; MAX_REQUEST_BYTES + 1];
        let mut reader = BoundedMessageReader::new(oversized.as_slice());
        assert_eq!(
            reader
                .read_to_end(&mut Vec::new())
                .await
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidData
        );
    }

    #[tokio::test]
    async fn stdio_relay_discovers_tools_reads_live_edits_and_stops_with_editor() {
        let (address, registry, permissions, cancellation, server) = start_test_server().await;
        let stream = connect_to_editor(address, &"a".repeat(64)).await.unwrap();
        let (client, child) = tokio::io::duplex(64 * 1024);
        let (input, output) = tokio::io::split(child);
        let bridge = tokio::spawn(relay_stdio(stream, input, output));
        let mut client = BufReader::new(client);
        send_json(
            &mut client,
            serde_json::json!({
                "jsonrpc":"2.0", "id":1, "method":"initialize",
                "params": {"protocolVersion":"2025-06-18", "capabilities":{},
                    "clientInfo":{"name":"stdio-test","version":"1"}}
            }),
        )
        .await;
        let initialized = receive_json(&mut client).await;
        assert_eq!(initialized["result"]["serverInfo"]["name"], "sodilaud-mcp");
        send_json(
            &mut client,
            serde_json::json!({
                "jsonrpc":"2.0", "method":"notifications/initialized"
            }),
        )
        .await;
        send_json(
            &mut client,
            serde_json::json!({
                "jsonrpc":"2.0", "id":2, "method":"tools/list"
            }),
        )
        .await;
        let tools = receive_json(&mut client).await;
        let tools = tools["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 21);
        for forbidden in ["empty_trash", "purge_trash", "restore_note"] {
            assert!(!tools.iter().any(|tool| tool["name"] == forbidden));
        }
        let move_schema = &tools
            .iter()
            .find(|tool| tool["name"] == "move_note")
            .unwrap()["inputSchema"];
        assert_eq!(
            move_schema["properties"]["folderId"]["type"],
            serde_json::json!(["string", "null"])
        );
        assert!(move_schema["required"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("folderId")));
        for tool in tools {
            assert_eq!(
                tool["annotations"]["readOnlyHint"],
                !WRITE_TOOLS.contains(&tool["name"].as_str().unwrap())
            );
        }
        for (id, method, arguments, field) in [
            (3, "list_folders", serde_json::json!({}), "folders"),
            (4, "list_notes", serde_json::json!({}), "notes"),
            (
                5,
                "search_notes",
                serde_json::json!({"query":"café"}),
                "notes",
            ),
        ] {
            send_json(
                &mut client,
                serde_json::json!({
                    "jsonrpc":"2.0", "id":id, "method":"tools/call",
                    "params":{"name":method, "arguments":arguments}
                }),
            )
            .await;
            let result = receive_json(&mut client).await;
            assert!(!result["result"]["structuredContent"][field]
                .as_array()
                .unwrap()
                .is_empty());
        }
        let old = registry
            .with(|workspace| Ok(workspace.notes[0].note.content.clone()))
            .unwrap();
        registry
            .push(
                "test-collection",
                "one",
                0,
                vec![crate::docs::registry::Update {
                    client_id: "editor".into(),
                    changes: crate::docs::changes::replace_all(&old, "Live café 📝 edit"),
                }],
            )
            .unwrap();
        send_json(
            &mut client,
            serde_json::json!({
                "jsonrpc":"2.0", "id":6, "method":"tools/call",
                "params":{"name":"get_note", "arguments":{"id":"one"}}
            }),
        )
        .await;
        let note = receive_json(&mut client).await;
        assert_eq!(
            note["result"]["structuredContent"]["content"],
            "Live café 📝 edit"
        );

        assert_eq!(
            note["result"]["structuredContent"]["collectionId"],
            "test-collection"
        );
        // Creation is advertised but must fail closed until the app grants it.
        for (id, name, arguments) in [
            (
                7,
                "create_note",
                serde_json::json!({"collectionId":"test-collection", "requestId":"n1", "title":"New"}),
            ),
            (
                8,
                "create_folder",
                serde_json::json!({"collectionId":"test-collection", "requestId":"f1", "name":"New"}),
            ),
            (
                13,
                "push_quick_note",
                serde_json::json!({"requestId":"p1", "title":"Build steps"}),
            ),
            (
                14,
                "open_document",
                serde_json::json!({"path":"/tmp/notes.md"}),
            ),
        ] {
            send_json(
                &mut client,
                serde_json::json!({
                    "jsonrpc":"2.0", "id":id, "method":"tools/call",
                    "params":{"name":name,"arguments":arguments}
                }),
            )
            .await;
            let result = receive_json(&mut client).await;
            assert_eq!(result["result"]["isError"], true);
            assert!(result["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("disabled"));
        }
        permissions
            .write()
            .unwrap()
            .extend(WRITE_TOOLS[..2].iter().map(|s| s.to_string()));
        send_json(&mut client, serde_json::json!({
            "jsonrpc":"2.0", "id":9, "method":"tools/call",
            "params":{"name":"create_note","arguments":{"collectionId":"stale","requestId":"n1","title":"New"}}
        })).await;
        let stale = receive_json(&mut client).await;
        assert_eq!(stale["result"]["isError"], true);
        assert!(stale["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Collection changed"));
        send_json(&mut client, serde_json::json!({
            "jsonrpc":"2.0", "id":10, "method":"tools/call",
            "params":{"name":"create_note","arguments":{"collectionId":"test-collection","requestId":"","title":"New"}}
        })).await;
        assert!(receive_json(&mut client).await["error"].is_object());
        assert_eq!(registry.state().unwrap().notes.len(), 2);

        assert_eq!(
            note["result"]["structuredContent"]["revision"],
            revision(&registry, "one")
        );
        // Creation permission alone must not authorize modification of a note.
        send_json(&mut client, serde_json::json!({
            "jsonrpc":"2.0", "id":11, "method":"tools/call",
            "params":{"name":"append_to_note","arguments":{"collectionId":"test-collection","requestId":"a1","noteId":"one","expectedRevision":"revision-one","content":" appended"}}
        })).await;
        let denied = receive_json(&mut client).await;
        assert_eq!(denied["result"]["isError"], true);
        assert!(denied["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("disabled"));
        permissions.write().unwrap().insert("append_to_note".into());
        send_json(&mut client, serde_json::json!({
            "jsonrpc":"2.0", "id":12, "method":"tools/call",
            "params":{"name":"append_to_note","arguments":{"collectionId":"test-collection","requestId":"a1","noteId":"one","expectedRevision":"","content":" appended"}}
        })).await;
        assert!(receive_json(&mut client).await["error"].is_object());
        assert_eq!(
            registry.state().unwrap().notes[0].note.content,
            "Live café 📝 edit"
        );

        // A second client does not steal the first client's session.
        let second = connect_to_editor(address, &"a".repeat(64)).await.unwrap();
        drop(second);
        cancellation.cancel();
        server.await.unwrap();
        tokio::time::timeout(CONNECTION_TIMEOUT, bridge)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(connect_to_editor(address, &"a".repeat(64)).await.is_err());
        std::fs::remove_file(registry.with(|w| Ok(w.path.clone())).unwrap()).unwrap();
    }

    #[tokio::test]
    async fn stdio_relay_exits_on_client_eof() {
        let (address, _, _, cancellation, server) = start_test_server().await;
        let stream = connect_to_editor(address, &"a".repeat(64)).await.unwrap();
        tokio::time::timeout(
            CONNECTION_TIMEOUT,
            relay_stdio(stream, tokio::io::empty(), tokio::io::sink()),
        )
        .await
        .unwrap()
        .unwrap();
        cancellation.cancel();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn modern_notification_listener_is_acknowledged_over_stdio() {
        let (address, _, _, cancellation, server) = start_test_server().await;
        let stream = connect_to_editor(address, &"a".repeat(64)).await.unwrap();
        let mut client = BufReader::new(stream);
        send_json(
            &mut client,
            serde_json::json!({
                "jsonrpc":"2.0", "id":"listen-test", "method":"subscriptions/listen",
                "params":{
                    "_meta":{
                        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
                        "io.modelcontextprotocol/clientInfo":{"name":"sodilaud-test","version":"1"},
                        "io.modelcontextprotocol/clientCapabilities":{}
                    },
                    "notifications":{"toolsListChanged":true}
                }
            }),
        )
        .await;
        let acknowledgment = receive_json(&mut client).await;
        assert_eq!(
            acknowledgment["method"],
            "notifications/subscriptions/acknowledged"
        );
        assert!(!acknowledgment
            .to_string()
            .contains("toolsListChanged\":true"));
        send_json(
            &mut client,
            serde_json::json!({
                "jsonrpc":"2.0", "id":2, "method":"tools/list"
            }),
        )
        .await;
        assert!(receive_json(&mut client).await["error"].is_object());
        send_json(
            &mut client,
            serde_json::json!({
                "jsonrpc":"2.0", "id":3, "method":"tools/list",
                "params":{"_meta":{
                    "io.modelcontextprotocol/protocolVersion":"2026-07-28",
                    "io.modelcontextprotocol/clientCapabilities":{}
                }}
            }),
        )
        .await;
        let tools = receive_json(&mut client).await;
        assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 21);
        cancellation.cancel();
        server.await.unwrap();
    }

    async fn start_test_server() -> (
        std::net::SocketAddr,
        SharedRegistry,
        Permissions,
        CancellationToken,
        JoinHandle<()>,
    ) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let (registry, _) = registry();
        let permissions = Arc::new(RwLock::new(read_permissions()));
        let cancellation = CancellationToken::new();
        let task = tokio::spawn(serve_local_connections(
            listener,
            registry.clone(),
            permissions.clone(),
            None,
            "a".repeat(64),
            cancellation.clone(),
        ));
        (address, registry, permissions, cancellation, task)
    }

    async fn send_json(stream: &mut (impl AsyncWrite + Unpin), value: serde_json::Value) {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        stream.write_all(&bytes).await.unwrap();
        stream.flush().await.unwrap();
    }

    async fn receive_json(
        stream: &mut (impl tokio::io::AsyncBufRead + Unpin),
    ) -> serde_json::Value {
        let mut line = String::new();
        tokio::time::timeout(CONNECTION_TIMEOUT, stream.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        serde_json::from_str(&line).unwrap()
    }

    #[test]
    fn mcp_token_path_uses_the_supplied_identifier() {
        let identifier = "io.github.borgand.sodilaud.beta";
        assert_eq!(
            mcp_token_path(identifier).unwrap(),
            dirs::config_dir()
                .unwrap()
                .join(identifier)
                .join(MCP_TOKEN_FILE_NAME)
        );
    }

    #[test]
    fn creates_and_reuses_a_private_token() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "sodilaud-mcp-token-{}-{unique}",
            std::process::id()
        ));
        let path = directory.join("token");

        let first = load_or_create_token(&path).expect("token should be created");
        let second = load_or_create_token(&path).expect("token should be reused");
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);

        std::fs::remove_file(path).expect("temporary token should be removable");
        std::fs::remove_dir(directory).expect("temporary directory should be removable");
    }
}
