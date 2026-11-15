// SPDX-License-Identifier: GPL-3.0-or-later

//! `sodilaud --wait FILE...`: the command returns only when every file it
//! opened is closed in Sodilaud, so it can serve as `$EDITOR`. The installed
//! script opens the files as usual, then runs the executable with [`FLAG`].
//! That process asks the app over the authenticated loopback channel agent
//! access already runs, and the app answers once each file has been open and
//! is closed again. A dropped connection means Sodilaud quit first.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::mcp::{connect_to_editor, MAX_REQUEST_BYTES, MCP_PORT};

pub const FLAG: &str = "--wait-for-close";
/// The byte after the token that asks for a wait session instead of MCP.
pub(crate) const MODE: u8 = b'w';
/// How long a file may take to show up in a window, Sodilaud's launch included.
const OPEN_WITHIN: Duration = Duration::from_secs(60);
/// How long to keep trying to reach Sodilaud while it starts.
const CONNECT_WITHIN: Duration = Duration::from_secs(30);
const RETRY: Duration = Duration::from_millis(250);

const UNREACHABLE: &str = "could not reach Sodilaud to wait for the files. --wait needs Agent access: turn it On in the Sodilaud menu, then try again.";
const QUIT: &str = "Sodilaud quit, or Agent access was turned off, before the files were closed.";

/// Every window's open files, once the file lists exist.
pub(crate) type OpenFiles = Arc<dyn Fn() -> Option<watch::Receiver<Vec<String>>> + Send + Sync>;

#[derive(Serialize, Deserialize)]
struct Request {
    paths: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Reply {
    Closed,
    Error(String),
}

/// Which of the awaited files have been open. A file is done once it was
/// open and is not any more; one open before the wait counts as seen.
struct Tracker {
    files: Vec<(String, bool)>,
}

impl Tracker {
    fn new(paths: Vec<String>) -> Self {
        let mut files: Vec<(String, bool)> = Vec::new();
        for path in paths {
            if !files.iter().any(|(known, _)| *known == path) {
                files.push((path, false));
            }
        }
        Self { files }
    }

    /// Takes in the open files and returns whether every file is closed.
    fn observe(&mut self, open: &[String]) -> bool {
        for (path, seen) in &mut self.files {
            if open.contains(path) {
                *seen = true;
            }
        }
        self.files
            .iter()
            .all(|(path, seen)| *seen && !open.contains(path))
    }

    fn unopened(&self) -> Vec<&str> {
        self.files
            .iter()
            .filter(|(_, seen)| !seen)
            .map(|(path, _)| path.as_str())
            .collect()
    }
}

/// The form the file lists use: symbolic links and `..` resolved.
fn canonical(path: String) -> String {
    crate::files::grants::canonical(Path::new(&path))
        .map(|resolved| resolved.to_string_lossy().into_owned())
        .unwrap_or(path)
}

/// Waits until every file has been open and is closed again. `None` when the
/// file lists went away, which only happens as Sodilaud quits.
async fn closed(
    paths: Vec<String>,
    open_files: &OpenFiles,
    open_within: Duration,
) -> Option<Reply> {
    let deadline = Instant::now() + open_within;
    let mut open = loop {
        if let Some(open) = open_files() {
            break open;
        }
        if Instant::now() >= deadline {
            return Some(Reply::Error("Sodilaud did not finish starting.".into()));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let mut tracker = Tracker::new(paths);
    loop {
        let done = tracker.observe(&open.borrow_and_update());
        if done {
            return Some(Reply::Closed);
        }
        let unopened = tracker.unopened();
        if unopened.is_empty() {
            open.changed().await.ok()?;
            continue;
        }
        let message = format!("{} did not open in Sodilaud.", unopened.join(", "));
        tokio::select! {
            changed = open.changed() => changed.ok()?,
            () = tokio::time::sleep_until(deadline) => return Some(Reply::Error(message)),
        }
    }
}

/// One wait session, after authentication: a JSON request line in, one JSON
/// reply line out. A client that goes away ends the session.
pub(crate) async fn serve(
    stream: TcpStream,
    open_files: OpenFiles,
    cancellation: CancellationToken,
) {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    let mut limited = (&mut reader).take(MAX_REQUEST_BYTES as u64);
    let read = tokio::select! {
        read = tokio::time::timeout(
            crate::mcp::CONNECTION_TIMEOUT,
            limited.read_line(&mut line),
        ) => read,
        () = cancellation.cancelled() => return,
    };
    if !matches!(read, Ok(Ok(count)) if count > 0) {
        return;
    }
    let reply = match serde_json::from_str::<Request>(&line) {
        Err(_) => Some(Reply::Error("The wait request is not valid.".into())),
        Ok(request) if request.paths.is_empty() => {
            Some(Reply::Error("No files to wait for.".into()))
        }
        Ok(request) => {
            let paths = request.paths.into_iter().map(canonical).collect();
            let mut byte = [0u8; 1];
            tokio::select! {
                reply = closed(paths, &open_files, OPEN_WITHIN) => reply,
                _ = reader.read(&mut byte) => return,
                () = cancellation.cancelled() => return,
            }
        }
    };
    let Some(reply) = reply else { return };
    let Ok(mut bytes) = serde_json::to_vec(&reply) else {
        return;
    };
    bytes.push(b'\n');
    let _ = writer.write_all(&bytes).await;
    let _ = writer.shutdown().await;
}

async fn wait_at(
    address: std::net::SocketAddr,
    token: &str,
    paths: Vec<String>,
    connect_within: Duration,
) -> Result<(), String> {
    let started = Instant::now();
    let stream = loop {
        match connect_to_editor(address, token, MODE).await {
            Ok(stream) => break stream,
            Err(_) if started.elapsed() < connect_within => tokio::time::sleep(RETRY).await,
            Err(_) => return Err(UNREACHABLE.into()),
        }
    };
    let (reader, mut writer) = stream.into_split();
    let mut request = serde_json::to_vec(&Request { paths }).map_err(|e| e.to_string())?;
    request.push(b'\n');
    writer
        .write_all(&request)
        .await
        .map_err(|_| QUIT.to_string())?;
    let mut line = String::new();
    let read = BufReader::new(reader)
        .take(MAX_REQUEST_BYTES as u64)
        .read_line(&mut line)
        .await;
    if !matches!(read, Ok(count) if count > 0) {
        return Err(QUIT.into());
    }
    match serde_json::from_str::<Reply>(&line) {
        Ok(Reply::Closed) => Ok(()),
        Ok(Reply::Error(message)) => Err(message),
        Err(_) => Err(QUIT.into()),
    }
}

/// Runs `sodilaud --wait-for-close FILE...` and returns the exit code: 0 once
/// every file is closed, 1 when Sodilaud cannot be reached or quits first.
pub fn run_wait(identifier: &str, paths: Vec<String>) -> i32 {
    match wait(identifier, paths) {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("sodilaud: {message}");
            1
        }
    }
}

fn wait(identifier: &str, paths: Vec<String>) -> Result<(), String> {
    let token_path = crate::mcp::mcp_token_path(identifier)?;
    let token = std::fs::read_to_string(token_path).map_err(|_| UNREACHABLE.to_string())?;
    let token = crate::mcp::validate_token(token.trim())?;
    let paths = paths
        .into_iter()
        .map(|path| {
            std::path::absolute(&path)
                .map(|absolute| absolute.to_string_lossy().into_owned())
                .unwrap_or(path)
        })
        .collect();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("could not start: {error}"))?;
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], MCP_PORT));
    runtime.block_on(wait_at(address, token, paths, CONNECT_WITHIN))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn strings(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|path| path.to_string()).collect()
    }

    #[test]
    fn a_file_is_done_once_it_was_open_and_is_closed() {
        let mut tracker = Tracker::new(strings(&["/a.md", "/b.md", "/a.md"]));
        assert!(!tracker.observe(&[]), "not open yet is not closed");
        assert_eq!(tracker.unopened(), ["/a.md", "/b.md"]);
        assert!(!tracker.observe(&strings(&["/a.md", "/c.md"])));
        assert!(!tracker.observe(&strings(&["/c.md"])), "b.md never opened");
        assert!(!tracker.observe(&strings(&["/b.md"])));
        assert!(tracker.unopened().is_empty());
        assert!(tracker.observe(&strings(&["/c.md"])));
    }

    fn lists(open: &[&str]) -> (watch::Sender<Vec<String>>, OpenFiles) {
        let (sender, receiver) = watch::channel(strings(open));
        (sender, Arc::new(move || Some(receiver.clone())))
    }

    async fn settle() {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn waits_for_every_file_including_one_open_before_the_wait() {
        let (sender, open_files) = lists(&["/w/old.md"]);
        let waiting = tokio::spawn(async move {
            closed(
                strings(&["/w/old.md", "/w/new.md"]),
                &open_files,
                OPEN_WITHIN,
            )
            .await
        });
        settle().await;
        sender.send_replace(strings(&["/w/old.md", "/w/new.md"]));
        settle().await;
        sender.send_replace(strings(&["/w/new.md"]));
        settle().await;
        assert!(!waiting.is_finished(), "new.md is still open");
        sender.send_replace(strings(&["/w/new.md", "/w/other.md"]));
        settle().await;
        assert!(
            !waiting.is_finished(),
            "a moved or reordered file stays open"
        );
        sender.send_replace(strings(&["/w/other.md"]));
        assert_eq!(waiting.await.unwrap(), Some(Reply::Closed));
    }

    #[tokio::test]
    async fn a_file_that_never_opens_is_reported_and_quitting_answers_nothing() {
        let (_sender, open_files) = lists(&[]);
        let reply = closed(
            strings(&["/w/lost.md"]),
            &open_files,
            Duration::from_millis(100),
        )
        .await;
        assert_eq!(
            reply,
            Some(Reply::Error("/w/lost.md did not open in Sodilaud.".into()))
        );

        let (sender, open_files) = lists(&["/w/a.md"]);
        let waiting =
            tokio::spawn(
                async move { closed(strings(&["/w/a.md"]), &open_files, OPEN_WITHIN).await },
            );
        settle().await;
        drop(sender);
        assert_eq!(waiting.await.unwrap(), None);

        let none: OpenFiles = Arc::new(|| None);
        let reply = closed(strings(&["/w/a.md"]), &none, Duration::from_millis(150)).await;
        assert_eq!(
            reply,
            Some(Reply::Error("Sodilaud did not finish starting.".into()))
        );
    }

    #[tokio::test]
    async fn the_command_returns_when_the_files_close_over_the_local_channel() {
        let directory =
            std::env::temp_dir().join(format!("sodilaud-wait-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&directory).unwrap();
        let file = canonical(
            directory
                .join("COMMIT_EDITMSG.md")
                .to_string_lossy()
                .into_owned(),
        );
        let (sender, open_files) = lists(&[&file]);
        let (address, _, _, cancellation, server) =
            crate::mcp::tests::start_test_server_with(open_files).await;
        let waiting = tokio::spawn({
            let file = file.clone();
            async move { wait_at(address, TOKEN, vec![file], Duration::ZERO).await }
        });
        settle().await;
        assert!(!waiting.is_finished());
        sender.send_replace(Vec::new());
        assert_eq!(waiting.await.unwrap(), Ok(()));

        let waiting = tokio::spawn({
            let file = file.clone();
            async move { wait_at(address, TOKEN, vec![file], Duration::ZERO).await }
        });
        settle().await;
        sender.send_replace(vec![file]);
        settle().await;
        cancellation.cancel();
        assert_eq!(
            waiting.await.unwrap(),
            Err(QUIT.into()),
            "the app went away"
        );
        server.await.unwrap();
        assert_eq!(
            wait_at(address, TOKEN, strings(&["/w/a.md"]), Duration::ZERO).await,
            Err(UNREACHABLE.into())
        );
    }

    #[tokio::test]
    async fn a_wrong_token_or_an_empty_request_is_refused() {
        let (_sender, open_files) = lists(&[]);
        let (address, _, _, cancellation, server) =
            crate::mcp::tests::start_test_server_with(open_files).await;
        assert_eq!(
            wait_at(
                address,
                &"b".repeat(64),
                strings(&["/w/a.md"]),
                Duration::ZERO
            )
            .await,
            Err(UNREACHABLE.into())
        );
        assert_eq!(
            wait_at(address, TOKEN, Vec::new(), Duration::ZERO).await,
            Err("No files to wait for.".into())
        );
        cancellation.cancel();
        server.await.unwrap();
    }
}
