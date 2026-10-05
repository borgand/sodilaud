// SPDX-License-Identifier: GPL-3.0-or-later

// Reading and writing user files without changing anything the user did not
// edit: the byte-order mark and CRLF line endings are kept, and a write replaces
// the file atomically, keeping its permissions.

use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::FileError;

pub const MAX_BYTES: u64 = 10 * 1024 * 1024;
const BOM: &[u8] = b"\xEF\xBB\xBF";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    Lf,
    Crlf,
}

/// A content hash, used only to recognize Sodilaud's own writes.
pub fn hash(bytes: &[u8]) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Splits a file into registry text, which uses `\n` only as CM6 does, the
/// line ending most of its lines use, and whether it had a BOM.
pub fn decode_normalized(bytes: &[u8]) -> Result<(String, LineEnding, bool), FileError> {
    let (body, bom) = match bytes.strip_prefix(BOM) {
        Some(rest) => (rest, true),
        None => (bytes, false),
    };
    let text = std::str::from_utf8(body).map_err(|_| FileError::not_utf8())?;
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    let line_ending = if crlf > lf {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    };
    let text = crate::docs::changes::normalize_newlines(text).into_owned();
    Ok((text, line_ending, bom))
}

pub fn encode(text: &str, line_ending: LineEnding, bom: bool) -> Vec<u8> {
    let body = match line_ending {
        LineEnding::Lf => text.to_string(),
        LineEnding::Crlf => text.replace("\r\n", "\n").replace('\n', "\r\n"),
    };
    let mut bytes = Vec::with_capacity(body.len() + BOM.len());
    if bom {
        bytes.extend_from_slice(BOM);
    }
    bytes.extend_from_slice(body.as_bytes());
    bytes
}

pub fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// The bytes of a regular file of at most `MAX_BYTES`.
pub fn read_bytes(path: &Path) -> Result<Vec<u8>, FileError> {
    let metadata = fs::metadata(path).map_err(|error| FileError::io(path, &error))?;
    if !metadata.is_file() {
        return Err(FileError::not_found(path));
    }
    if metadata.len() > MAX_BYTES {
        return Err(FileError::too_large(path));
    }
    fs::read(path).map_err(|error| FileError::io(path, &error))
}

/// Writes `text` to a temporary file beside `path`, then renames it over `path`,
/// so a crash leaves either the old file or the new one. Returns the hash of the
/// bytes written.
pub fn write_atomic(
    path: &Path,
    text: &str,
    line_ending: LineEnding,
    bom: bool,
) -> Result<String, FileError> {
    let bytes = encode(text, line_ending, bom);
    let directory = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let temporary = directory.join(format!(
        ".{}.sodilaud-{}-{nanos}.tmp",
        file_name(path),
        std::process::id()
    ));
    let result = (|| {
        let mut file = File::create(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        if let Ok(original) = fs::metadata(path) {
            fs::set_permissions(&temporary, original.permissions())?;
        }
        fs::rename(&temporary, path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(FileError::io(path, &error));
    }
    Ok(hash(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::FileErrorCode;

    fn scratch(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("sodilaud-files-{name}-{nanos}"));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn a_crlf_file_round_trips_byte_for_byte() {
        let path = scratch("crlf").join("notes.md");
        fs::write(&path, b"# Title\r\n\r\n- one\r\n").unwrap();
        let (text, line_ending, bom) = decode_normalized(&read_bytes(&path).unwrap()).unwrap();
        assert_eq!(text, "# Title\n\n- one\n");
        assert_eq!(line_ending, LineEnding::Crlf);
        write_atomic(&path, &format!("{text}- two\n"), line_ending, bom).unwrap();
        assert_eq!(
            fs::read(&path).unwrap(),
            b"# Title\r\n\r\n- one\r\n- two\r\n"
        );
    }

    #[test]
    fn a_bom_is_kept() {
        let path = scratch("bom").join("bom.txt");
        fs::write(&path, b"\xEF\xBB\xBFhello\n").unwrap();
        let (text, line_ending, bom) = decode_normalized(&read_bytes(&path).unwrap()).unwrap();
        assert_eq!(text, "hello\n");
        assert!(bom);
        write_atomic(&path, "hello world\n", line_ending, bom).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBFhello world\n");
    }

    #[test]
    fn registry_text_is_normalized_and_keeps_the_majority_ending() {
        let (text, line_ending, bom) = decode_normalized(b"\xEF\xBB\xBFa\r\nb\r\nc\n").unwrap();
        assert_eq!(
            (text.as_str(), line_ending, bom),
            ("a\nb\nc\n", LineEnding::Crlf, true)
        );
        let (text, line_ending, _) = decode_normalized(b"a\r\nb\nc\n").unwrap();
        assert_eq!((text.as_str(), line_ending), ("a\nb\nc\n", LineEnding::Lf));
    }

    #[cfg(unix)]
    #[test]
    fn a_write_keeps_the_file_mode() {
        use std::os::unix::fs::PermissionsExt;
        let path = scratch("mode").join("private.md");
        fs::write(&path, b"secret\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        write_atomic(&path, "still secret\n", LineEnding::Lf, false).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn a_write_leaves_no_temporary_file_and_reports_its_hash() {
        let directory = scratch("temp");
        let path = directory.join("a.md");
        let written = write_atomic(&path, "new\n", LineEnding::Lf, false).unwrap();
        assert_eq!(written, hash(b"new\n"));
        let names: Vec<_> = fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["a.md".to_string()]);
    }

    #[test]
    fn a_file_that_is_not_utf8_is_refused() {
        let path = scratch("latin1").join("latin1.txt");
        fs::write(&path, b"caf\xE9\n").unwrap();
        let bytes = read_bytes(&path).unwrap();
        assert_eq!(
            decode_normalized(&bytes).unwrap_err().code,
            FileErrorCode::NotUtf8
        );
    }

    #[test]
    fn a_file_over_ten_megabytes_is_refused() {
        let path = scratch("large").join("large.md");
        let file = File::create(&path).unwrap();
        file.set_len(MAX_BYTES + 1).unwrap();
        assert_eq!(read_bytes(&path).unwrap_err().code, FileErrorCode::TooLarge);
    }
}
