// SPDX-License-Identifier: GPL-3.0-or-later

// Markdown an agent pushed for the user to review, kept in app data until the
// user saves or discards it. Each draft is one folder, `<uuid>/`, holding the
// Markdown file and `draft.json`. The app picks every path; an agent only
// names the title, which is reduced to a plain file name.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const DIRECTORY: &str = "drafts";
pub const META: &str = "draft.json";
pub const TITLE_LIMIT: usize = 200;
pub const CONTENT_LIMIT: usize = 100_000;
const NAME_LIMIT: usize = 100;
/// Bytes, so a name in any script stays under the common 255-byte limit.
const NAME_BYTES: usize = 240;
const RESERVED_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// The fingerprint each (drafts dir, requestId) was used with in this run.
/// Held while creating, so two pushes with one requestId cannot both create a
/// draft, and a late retry cannot bring back a draft saved or discarded since.
static USED: Mutex<BTreeMap<(PathBuf, String), String>> = Mutex::new(BTreeMap::new());

/// Characters that are invisible or reorder text, so a name could read as
/// something else (`invoice\u{202E}gpj.md` shows as `invoicedm.jpg`).
fn is_hidden_char(c: char) -> bool {
    c.is_control()
        || matches!(c,
            '\u{200B}'..='\u{200F}'
            | '\u{2028}'..='\u{2029}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{FEFF}')
}

fn cut_to_bytes(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// `title` as a file name that stays in its draft folder on every platform:
/// no separators or other characters a file system refuses, no invisible or
/// direction-changing characters, no leading or trailing dots or spaces, no
/// reserved device name, and at most 100 characters and 240 bytes.
pub fn file_name(title: &str) -> String {
    let replaced: String = title
        .chars()
        .map(|c| {
            if is_hidden_char(c)
                || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trim = |text: &str| {
        text.trim_matches(|c: char| c.is_whitespace() || c == '.')
            .to_string()
    };
    let capped: String = trim(&replaced).chars().take(NAME_LIMIT).collect();
    let mut stem = trim(cut_to_bytes(&capped, NAME_BYTES));
    if stem.is_empty() {
        stem = "Draft".to_string();
    }
    let device = stem.split('.').next().unwrap_or_default().to_lowercase();
    if RESERVED_NAMES.contains(&device.as_str()) {
        stem = stem.chars().take(NAME_LIMIT - 1).collect::<String>() + "-";
    }
    format!("{stem}.md")
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub path: String,
    pub name: String,
    /// Milliseconds since the epoch.
    pub created_at: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Created {
    New(Draft),
    Existing(Draft),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    request_id: String,
    fingerprint: String,
    created_at: u64,
    /// Secret to the app: keeps the Quick Notes request id from being guessed
    /// by an agent that can see the draft's path.
    #[serde(default)]
    save_token: String,
}

fn fingerprint(title: &str, content: &str) -> String {
    let digest = Sha256::digest(format!("{title}\0{content}").as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

fn read_meta(folder: &Path) -> Option<Meta> {
    serde_json::from_slice(&fs::read(folder.join(META)).ok()?).ok()
}

/// The one Markdown file in a draft folder.
fn markdown_in(folder: &Path) -> Option<PathBuf> {
    let mut found = fs::read_dir(folder).ok()?.flatten().filter(|entry| {
        entry.file_type().is_ok_and(|kind| kind.is_file())
            && Path::new(&entry.file_name())
                .extension()
                .is_some_and(|ext| ext == "md")
    });
    let first = found.next()?;
    found.next().is_none().then(|| first.path())
}

fn draft_in(folder: &Path) -> Option<Draft> {
    let file = markdown_in(folder)?;
    let created_at = read_meta(folder)
        .map(|meta| meta.created_at)
        .or_else(|| {
            let modified = fs::metadata(&file).ok()?.modified().ok()?;
            Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
        })
        .unwrap_or_default();
    Some(Draft {
        name: super::io::file_name(&file),
        path: file.to_string_lossy().to_string(),
        created_at,
    })
}

fn folders(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect()
}

#[cfg(unix)]
fn restrict_folder(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("Could not restrict permissions on {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn restrict_folder(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn write_owner_only(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::write(path, bytes).map_err(|e| format!("Could not write the draft: {e}"))?;
    crate::restrict_to_owner(path)
}

/// Writes a new draft, or returns the one an earlier call with the same
/// `request_id` and arguments made.
pub fn create(dir: &Path, request_id: &str, title: &str, content: &str) -> Result<Created, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() || trimmed.chars().count() > TITLE_LIMIT || content.len() > CONTENT_LIMIT
    {
        return Err(
            "title must contain 1-200 characters and content at most 100000 UTF-8 bytes".into(),
        );
    }
    let mut used = USED.lock().unwrap_or_else(|e| e.into_inner());
    fs::create_dir_all(dir).map_err(|e| format!("Could not create the drafts folder: {e}"))?;
    restrict_folder(dir)?;
    let dir = dir
        .canonicalize()
        .map_err(|e| format!("Could not open the drafts folder: {e}"))?;
    let wanted = fingerprint(title, content);
    let key = (dir.clone(), request_id.to_string());
    for folder in folders(&dir) {
        let Some(meta) = read_meta(&folder) else {
            continue;
        };
        if meta.request_id != request_id {
            continue;
        }
        if meta.fingerprint != wanted {
            return Err("requestId was already used with different arguments.".into());
        }
        if let Some(draft) = draft_in(&folder) {
            return Ok(Created::Existing(draft));
        }
    }
    match used.get(&key) {
        Some(used) if *used == wanted => {
            return Err(
                "This draft was already saved or discarded. Use a new requestId for a new draft."
                    .into(),
            )
        }
        Some(_) => return Err("requestId was already used with different arguments.".into()),
        None => {}
    }
    let folder = dir.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&folder).map_err(|e| format!("Could not create the draft: {e}"))?;
    let file = folder.join(file_name(title));
    let created_at = now_ms();
    let meta = Meta {
        request_id: request_id.to_string(),
        fingerprint: wanted.clone(),
        created_at,
        save_token: String::new(),
    };
    let written = restrict_folder(&folder)
        .and_then(|()| write_owner_only(&file, content.as_bytes()))
        .and_then(|()| {
            let bytes = serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?;
            write_owner_only(&folder.join(META), &bytes)
        });
    if let Err(error) = written {
        let _ = fs::remove_dir_all(&folder);
        return Err(error);
    }
    used.insert(key, wanted);
    Ok(Created::New(Draft {
        name: super::io::file_name(&file),
        path: file.to_string_lossy().to_string(),
        created_at,
    }))
}

/// The token for the draft at `path`, made on first use and kept in its
/// `draft.json`, so a retried save presents the same one.
pub fn save_token(path: &Path) -> Result<String, String> {
    let folder = path.parent().ok_or("The draft has no folder.")?;
    let mut meta = match read_meta(folder) {
        Some(meta) => meta,
        None => Meta {
            request_id: String::new(),
            fingerprint: String::new(),
            created_at: draft_in(folder).map_or_else(now_ms, |draft| draft.created_at),
            save_token: String::new(),
        },
    };
    if meta.save_token.is_empty() {
        meta.save_token = uuid::Uuid::new_v4().simple().to_string();
        let bytes = serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?;
        let temp = folder.join(format!("{META}.tmp"));
        write_owner_only(&temp, &bytes)?;
        fs::rename(&temp, folder.join(META)).map_err(|e| {
            let _ = fs::remove_file(&temp);
            format!("Could not write the draft: {e}")
        })?;
    }
    Ok(meta.save_token)
}

/// Every draft in `dir`, newest first.
pub fn list(dir: &Path) -> Vec<Draft> {
    let Ok(dir) = dir.canonicalize() else {
        return Vec::new();
    };
    let mut drafts: Vec<Draft> = folders(&dir)
        .iter()
        .filter_map(|folder| draft_in(folder))
        .collect();
    drafts.sort_by_key(|draft| std::cmp::Reverse(draft.created_at));
    drafts
}

/// Whether `path`, after resolving `..` and symbolic links, is the Markdown
/// file of a draft folder directly in `dir`.
pub fn is_draft(dir: &Path, path: &Path) -> bool {
    let (Ok(dir), Ok(path)) = (dir.canonicalize(), path.canonicalize()) else {
        return false;
    };
    let in_draft_folder = path
        .parent()
        .and_then(Path::parent)
        .is_some_and(|parent| parent == dir);
    in_draft_folder
        && path.is_file()
        && path.extension().is_some_and(|ext| ext == "md")
        && path.parent().and_then(markdown_in).as_deref() == Some(path.as_path())
}

/// Deletes the draft folder `path` is in.
pub fn remove(dir: &Path, path: &Path) -> Result<(), String> {
    if !is_draft(dir, path) {
        return Err(format!("{} is not a draft.", super::io::file_name(path)));
    }
    let file = path
        .canonicalize()
        .map_err(|e| format!("Could not remove the draft: {e}"))?;
    let folder = file
        .parent()
        .ok_or_else(|| "Could not remove the draft.".to_string())?;
    fs::remove_dir_all(folder).map_err(|e| format!("Could not remove the draft: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "sodilaud-drafts-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&directory).unwrap();
        directory.canonicalize().unwrap()
    }

    fn draft(created: Created) -> Draft {
        match created {
            Created::New(draft) | Created::Existing(draft) => draft,
        }
    }

    #[test]
    fn a_title_becomes_a_safe_file_name() {
        assert_eq!(file_name("Plan: a/b"), "Plan- a-b.md");
        assert_eq!(file_name("   "), "Draft.md");
        let long = file_name(&"a".repeat(300));
        assert_eq!(long, format!("{}.md", "a".repeat(100)));
        for (title, expected) in [
            ("..", "Draft.md"),
            ("../../etc/passwd", "-..-etc-passwd.md"),
            ("..\\..\\x", "-..-x.md"),
            (".hidden", "hidden.md"),
            ("a\0b\nc", "a-b-c.md"),
            ("CON", "CON-.md"),
            ("nul.txt", "nul.txt-.md"),
            ("Console", "Console.md"),
            ("com1", "com1-.md"),
            ("trailing. ", "trailing.md"),
            ("invoice\u{202E}gpj", "invoice-gpj.md"),
            ("a\u{200B}b\u{2028}c\u{2066}d\u{FEFF}", "a-b-c-d-.md"),
        ] {
            assert_eq!(file_name(title), expected, "{title:?}");
        }
        for title in [
            "..",
            "../x",
            "a/../../b",
            "/abs",
            "C:\\x",
            "\\\\server\\share",
        ] {
            let name = file_name(title);
            assert!(!name.contains(['/', '\\', ':']), "{name}");
            assert!(!name.starts_with('.'), "{name}");
            assert_eq!(Path::new(&name).components().count(), 1, "{name}");
        }
    }

    #[test]
    fn a_name_in_any_script_fits_the_file_system_limit() {
        for title in [
            "界".repeat(100),
            "😀".repeat(100),
            "界".repeat(300),
            "a😀".repeat(80),
        ] {
            let name = file_name(&title);
            assert!(name.len() <= 255, "{} bytes", name.len());
            assert!(name.ends_with(".md"));
            assert!(name.chars().count() <= 103);
        }
        assert_eq!(
            file_name(&"界".repeat(100)),
            format!("{}.md", "界".repeat(80))
        );
    }

    #[test]
    fn a_late_retry_does_not_bring_back_a_saved_or_discarded_draft() {
        let dir = scratch("late");
        let made = draft(create(&dir, "r", "T", "body").unwrap());
        remove(&dir, Path::new(&made.path)).unwrap();
        assert!(create(&dir, "r", "T", "body")
            .unwrap_err()
            .contains("already saved or discarded"));
        assert_eq!(
            create(&dir, "r", "T", "other").unwrap_err(),
            "requestId was already used with different arguments."
        );
        assert!(list(&dir).is_empty());
        assert!(matches!(
            create(&dir, "r2", "T", "body").unwrap(),
            Created::New(_)
        ));
    }

    #[test]
    fn a_save_token_is_made_once_per_draft_and_kept() {
        let dir = std::env::temp_dir().join(format!("sodilaud-token-{}", uuid::Uuid::new_v4()));
        let new = |request: &str| match create(&dir, request, "Plan", request).unwrap() {
            Created::New(draft) | Created::Existing(draft) => PathBuf::from(draft.path),
        };
        let (first, second) = (new("one"), new("two"));
        let token = save_token(&first).unwrap();
        assert_eq!(token.len(), 32);
        assert_eq!(save_token(&first).unwrap(), token);
        assert_ne!(save_token(&second).unwrap(), token);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_draft_with_damaged_details_still_gets_a_stable_save_token() {
        let dir = std::env::temp_dir().join(format!("sodilaud-token-{}", uuid::Uuid::new_v4()));
        for damage in [None, Some("{not json")] {
            let path = match create(&dir, &format!("d{damage:?}"), "Plan", "x").unwrap() {
                Created::New(draft) | Created::Existing(draft) => PathBuf::from(draft.path),
            };
            let meta = path.parent().unwrap().join(META);
            match damage {
                Some(text) => fs::write(&meta, text).unwrap(),
                None => fs::remove_file(&meta).unwrap(),
            }
            let token = save_token(&path).unwrap();
            assert_eq!(token.len(), 32);
            assert_eq!(save_token(&path).unwrap(), token);
            assert!(!path.parent().unwrap().join("draft.json.tmp").exists());
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn creating_writes_the_text_and_meta() {
        let dir = scratch("create").join(DIRECTORY);
        let made = draft(create(&dir, "r1", "Plan: week", "# Plan\n").unwrap());
        let path = PathBuf::from(&made.path);
        assert_eq!(made.name, "Plan- week.md");
        assert_eq!(fs::read_to_string(&path).unwrap(), "# Plan\n");
        let folder = path.parent().unwrap();
        assert_eq!(folder.parent().unwrap(), dir.canonicalize().unwrap());
        let meta: serde_json::Value =
            serde_json::from_slice(&fs::read(folder.join(META)).unwrap()).unwrap();
        assert_eq!(meta["requestId"], "r1");
        assert_eq!(meta["createdAt"], made.created_at);
        assert!(meta["fingerprint"].as_str().unwrap().len() == 64);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&path), 0o600);
            assert_eq!(mode(&folder.join(META)), 0o600);
            assert_eq!(mode(folder), 0o700);
        }
        assert!(create(&dir, "r2", " ", "").is_err());
        assert!(create(&dir, "r2", "T", &"x".repeat(CONTENT_LIMIT + 1)).is_err());
        assert!(create(&dir, "r2", &"t".repeat(TITLE_LIMIT + 1), "").is_err());
    }

    #[test]
    fn a_repeated_request_returns_the_same_draft() {
        let dir = scratch("repeat");
        let first = create(&dir, "r", "T", "body").unwrap();
        let Created::New(first) = first else {
            panic!("the first call creates");
        };
        assert_eq!(
            create(&dir, "r", "T", "body").unwrap(),
            Created::Existing(first)
        );
        assert_eq!(list(&dir).len(), 1);
    }

    #[test]
    fn a_reused_request_id_with_other_text_is_refused() {
        let dir = scratch("reuse");
        create(&dir, "r", "T", "body").unwrap();
        assert_eq!(
            create(&dir, "r", "T", "other").unwrap_err(),
            "requestId was already used with different arguments."
        );
        assert_eq!(
            create(&dir, "r", "Other", "body").unwrap_err(),
            "requestId was already used with different arguments."
        );
        assert_eq!(list(&dir).len(), 1);
    }

    #[test]
    fn drafts_are_listed_newest_first_and_survive_damaged_meta() {
        let dir = scratch("list");
        let old = draft(create(&dir, "a", "Old", "").unwrap());
        std::thread::sleep(std::time::Duration::from_millis(5));
        let new = draft(create(&dir, "b", "New", "").unwrap());
        let listed = list(&dir);
        assert_eq!(listed, [new.clone(), old.clone()]);

        let damaged = Path::new(&old.path).parent().unwrap().join(META);
        fs::write(&damaged, "{not json").unwrap();
        let listed = list(&dir);
        assert_eq!(listed.len(), 2);
        let old_again = listed.iter().find(|d| d.path == old.path).unwrap();
        assert!(old_again.created_at > 0);

        fs::remove_file(&damaged).unwrap();
        assert_eq!(list(&dir).len(), 2);

        let empty = dir.join("empty");
        fs::create_dir(&empty).unwrap();
        let two = dir.join("two");
        fs::create_dir(&two).unwrap();
        fs::write(two.join("a.md"), "").unwrap();
        fs::write(two.join("b.md"), "").unwrap();
        fs::write(dir.join("loose.md"), "").unwrap();
        assert_eq!(list(&dir).len(), 2);
        assert!(list(&dir.join("missing")).is_empty());
    }

    #[test]
    fn only_a_draft_can_be_removed() {
        let base = scratch("remove");
        let dir = base.join(DIRECTORY);
        let made = draft(create(&dir, "r", "T", "").unwrap());
        let path = PathBuf::from(&made.path);
        assert!(is_draft(&dir, &path));

        let loose = dir.join("x.md");
        fs::write(&loose, "").unwrap();
        let outside = base.join("outside.md");
        fs::write(&outside, "").unwrap();
        let deeper = path.parent().unwrap().join("sub");
        fs::create_dir(&deeper).unwrap();
        fs::write(deeper.join("d.md"), "").unwrap();
        let meta = path.parent().unwrap().join(META);
        let dotted = PathBuf::from(format!("{}/../{}", dir.display(), "outside.md"));
        for refused in [&loose, &outside, &deeper.join("d.md"), &meta, &dotted, &dir] {
            assert!(!is_draft(&dir, refused), "{}", refused.display());
            assert!(remove(&dir, refused).is_err(), "{}", refused.display());
            assert!(refused.exists(), "{}", refused.display());
        }
        #[cfg(unix)]
        {
            let elsewhere = base.join("elsewhere");
            fs::create_dir(&elsewhere).unwrap();
            fs::write(elsewhere.join("e.md"), "").unwrap();
            std::os::unix::fs::symlink(&elsewhere, dir.join("link")).unwrap();
            let linked = dir.join("link/e.md");
            assert!(!is_draft(&dir, &linked));
            assert!(remove(&dir, &linked).is_err());
            assert!(elsewhere.join("e.md").exists());
        }
        fs::remove_dir_all(&deeper).unwrap();
        remove(&dir, &path).unwrap();
        assert!(!path.parent().unwrap().exists());
        assert!(dir.exists());
    }
}
