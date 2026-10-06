// SPDX-License-Identifier: GPL-3.0-or-later

//! The `sodilaud` command: a small shell script in `~/.local/bin` that opens
//! files in the running Sodilaud from a terminal. On macOS it goes through
//! `open -a`, the same route as Finder "Open With"; on Linux it runs the
//! executable, whose single-instance handoff reaches the running app. Every
//! function takes its paths, so tests never touch the real home folder.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) const MARKER: &str = "# sodilaud-cli: installed by Sodilaud. Update or remove it from the Sodilaud menu (Command Line Tool).";

/// What the script launches.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Target {
    /// A macOS app bundle, opened through Launch Services.
    App(PathBuf),
    /// An executable that hands its arguments to the running instance.
    Executable(PathBuf),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum State {
    Missing,
    /// Ours and identical to what installing would write.
    Current,
    /// Ours, from another copy or version of Sodilaud.
    Outdated,
    /// Something else is there; it is never touched.
    Foreign,
}

const BODY: &str = r#"
fail() {
  printf 'sodilaud: %s\n' "$1" >&2
  exit 1
}

usage() {
  echo "Usage: sodilaud FILE..."
  echo "Opens Markdown and text files (.md, .markdown, .txt) in Sodilaud and returns at once."
  echo "A file that does not exist is created empty."
}

if [ "$#" -eq 0 ]; then
  usage >&2
  exit 2
fi

files_only=
for arg do
  shift
  if [ -z "$files_only" ]; then
    case $arg in
      --) files_only=1; continue ;;
      -h|--help) usage; exit 0 ;;
      -*) printf 'sodilaud: unknown option %s\n' "$arg" >&2; usage >&2; exit 2 ;;
    esac
  fi
  case $arg in
    /*) path=$arg ;;
    *) path=$PWD/$arg ;;
  esac
  case $path in
    *.[Mm][Dd]|*.[Mm][Aa][Rr][Kk][Dd][Oo][Ww][Nn]|*.[Tt][Xx][Tt]) ;;
    *) fail "$arg is not a Markdown or text file. Sodilaud opens .md, .markdown and .txt files." ;;
  esac
  if [ -d "$path" ]; then
    fail "$arg is a folder. Sodilaud opens files."
  fi
  if [ ! -e "$path" ]; then
    parent=$(dirname -- "$path")
    [ -d "$parent" ] || fail "cannot create $arg: the folder $parent does not exist."
  fi
  set -- "$@" "$path"
done

if [ "$#" -eq 0 ]; then
  usage >&2
  exit 2
fi

for path do
  if [ ! -e "$path" ]; then
    ( : >> "$path" ) 2>/dev/null || fail "could not create $path."
  fi
done

launch "$@"
"#;

/// Quotes a value for `sh`, so any path survives as one word.
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn utf8(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| format!("{} is not a valid Unicode path", path.display()))
}

pub(crate) fn script(target: &Target) -> Result<String, String> {
    let launcher = match target {
        Target::App(bundle) => format!(
            r#"app={}

launch() {{
  [ -d "$app" ] || fail "Sodilaud is no longer at $app. Open Sodilaud and choose Command Line Tool in its menu to update this command."
  exec open -a "$app" "$@"
}}
"#,
            quote(utf8(bundle)?)
        ),
        Target::Executable(executable) => format!(
            r#"exe={}

launch() {{
  [ -x "$exe" ] || fail "Sodilaud is no longer at $exe. Open Sodilaud and choose Command Line Tool in its menu to update this command."
  if command -v setsid >/dev/null 2>&1; then
    setsid "$exe" "$@" </dev/null >/dev/null 2>&1 &
  else
    nohup "$exe" "$@" </dev/null >/dev/null 2>&1 &
  fi
}}
"#,
            quote(utf8(executable)?)
        ),
    };
    Ok(format!(
        "#!/bin/sh\n{MARKER}\n# Opens Markdown and text files in Sodilaud: sodilaud FILE...\n\n{launcher}{BODY}"
    ))
}

/// The `.app` bundle an executable runs from: `X.app/Contents/MacOS/binary`.
pub(crate) fn app_bundle(executable: &Path) -> Option<PathBuf> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = macos.file_name() == Some(OsStr::new("MacOS"))
        && contents.file_name() == Some(OsStr::new("Contents"))
        && bundle.extension() == Some(OsStr::new("app"));
    is_bundle.then(|| bundle.to_path_buf())
}

/// What a script installed from this build should launch, or why it cannot.
pub(crate) fn target_for(executable: &Path) -> Result<Target, String> {
    if cfg!(windows) {
        return Err("The sodilaud command is available on macOS and Linux only.".into());
    }
    if cfg!(target_os = "macos") {
        let bundle = app_bundle(executable).ok_or(
            "This copy of Sodilaud does not run from an app bundle (a development build), so it cannot install the sodilaud command. Install it from Sodilaud.app.",
        )?;
        if bundle.to_string_lossy().contains("/AppTranslocation/") {
            return Err("Move Sodilaud to the Applications folder and open it from there, then install the sodilaud command. macOS runs it from a temporary location until then.".into());
        }
        return Ok(Target::App(bundle));
    }
    Ok(Target::Executable(executable.to_path_buf()))
}

pub(crate) fn install_path(home: &Path) -> PathBuf {
    home.join(".local").join("bin").join("sodilaud")
}

pub(crate) fn state(path: &Path, script: &str) -> State {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return State::Missing;
    };
    if !metadata.is_file() {
        return State::Foreign;
    }
    match fs::read_to_string(path) {
        Ok(found) if found == script => State::Current,
        Ok(found) if found.lines().take(3).any(|line| line == MARKER) => State::Outdated,
        _ => State::Foreign,
    }
}

fn foreign(path: &Path) -> String {
    format!(
        "{} already exists and was not installed by Sodilaud. Nothing was changed. Rename or remove it, then try again.",
        path.display()
    )
}

/// Writes the script, replacing only an earlier one of ours.
pub(crate) fn install(path: &Path, script: &str) -> Result<(), String> {
    match state(path, script) {
        State::Current => return Ok(()),
        State::Foreign => return Err(foreign(path)),
        State::Missing | State::Outdated => {}
    }
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent folder", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    let temporary = parent.join(format!(".sodilaud.{}.tmp", uuid::Uuid::new_v4().simple()));
    let written = fs::write(&temporary, script)
        .and_then(|()| executable_mode(&temporary))
        .and_then(|()| fs::rename(&temporary, path));
    written.map_err(|e| {
        let _ = fs::remove_file(&temporary);
        format!("Could not write {}: {e}", path.display())
    })
}

#[cfg(unix)]
fn executable_mode(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

#[cfg(not(unix))]
fn executable_mode(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Removes our script. Returns whether there was one.
pub(crate) fn remove(path: &Path) -> Result<bool, String> {
    match state(path, "") {
        State::Missing => Ok(false),
        State::Foreign => Err(foreign(path)),
        State::Current | State::Outdated => fs::remove_file(path)
            .map(|()| true)
            .map_err(|e| format!("Could not remove {}: {e}", path.display())),
    }
}

pub(crate) fn on_path(directory: &Path, path_variable: &OsStr) -> bool {
    std::env::split_paths(path_variable).any(|entry| entry == directory)
}

pub(crate) fn path_hint(shell: Option<&str>) -> String {
    let name = shell
        .and_then(|shell| Path::new(shell).file_name())
        .and_then(OsStr::to_str);
    let export = r#"export PATH="$HOME/.local/bin:$PATH""#;
    let how = match name {
        Some("fish") => "Run this once in a terminal:\n\nfish_add_path ~/.local/bin".to_string(),
        Some("zsh") => format!("Add this line to ~/.zshrc:\n\n{export}"),
        Some("bash") if cfg!(target_os = "macos") => {
            format!("Add this line to ~/.bash_profile:\n\n{export}")
        }
        Some("bash") => format!("Add this line to ~/.bashrc:\n\n{export}"),
        _ => format!("Add this line to your shell's startup file:\n\n{export}"),
    };
    format!("~/.local/bin is not on your PATH yet. {how}\n\nThen open a new terminal window.")
}

/// The PATH an interactive login shell sets up. A Finder- or desktop-launched
/// app inherits a minimal PATH, so its own is not what the terminal has.
fn login_shell_path(shell: &str) -> Option<std::ffi::OsString> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let mut child = Command::new(shell)
        .args(["-ilc", r#"printf '\n%s' "$PATH""#])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut output = String::new();
        let _ = stdout.read_to_string(&mut output);
        let _ = sender.send(output);
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    let output = receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()));
    let _ = child.kill();
    let _ = child.wait();
    let output = output.ok()?;
    let last = output.trim_end().rsplit('\n').next()?.trim();
    (!last.is_empty()).then(|| last.into())
}

mod dialog {
    use super::*;
    use tauri::AppHandle;

    const INSTALL: &str = "Install";
    const UPDATE: &str = "Update";
    const REMOVE: &str = "Remove";
    const CANCEL: &str = "Cancel";
    const CLOSE: &str = "Close";
    const TITLE: &str = "Command Line Tool";

    struct Context {
        path: PathBuf,
        shown: String,
        script: Result<String, String>,
        on_path: bool,
        shell: Option<String>,
    }

    fn context() -> Result<Context, String> {
        let home = dirs::home_dir().ok_or("Could not find your home folder")?;
        let path = install_path(&home);
        let executable = crate::mcp::executable()?;
        let script = target_for(Path::new(&executable)).and_then(|target| script(&target));
        let directory = path.parent().map(Path::to_path_buf).unwrap_or_default();
        let shell = std::env::var("SHELL").ok();
        let on_path = std::env::var_os("PATH").is_some_and(|value| on_path(&directory, &value))
            || shell
                .as_deref()
                .and_then(login_shell_path)
                .is_some_and(|value| on_path(&directory, &value));
        Ok(Context {
            shown: "~/.local/bin/sodilaud".into(),
            path,
            script,
            on_path,
            shell,
        })
    }

    fn alert(message: &str) {
        rfd::MessageDialog::new()
            .set_title(TITLE)
            .set_description(message)
            .set_buttons(rfd::MessageButtons::Ok)
            .show();
    }

    fn chose(
        result: &rfd::MessageDialogResult,
        label: &str,
        fallback: rfd::MessageDialogResult,
    ) -> bool {
        match result {
            rfd::MessageDialogResult::Custom(chosen) => chosen == label,
            other => *other == fallback,
        }
    }

    fn installed_message(context: &Context) -> String {
        let mut message = format!(
            "Installed {}. In a terminal, run:\n\nsodilaud notes.md",
            context.shown
        );
        if !context.on_path {
            message.push_str("\n\n");
            message.push_str(&path_hint(context.shell.as_deref()));
        }
        message
    }

    fn run(context: Context) {
        let script = match &context.script {
            Ok(script) => script.clone(),
            Err(reason) => {
                // An unsupported build can still remove a script it finds.
                if state(&context.path, "") == State::Outdated {
                    return offer_remove(&context, reason);
                }
                return alert(reason);
            }
        };
        let result = match state(&context.path, &script) {
            State::Foreign => Err(foreign(&context.path)),
            State::Missing => {
                let answer = rfd::MessageDialog::new()
                    .set_title(TITLE)
                    .set_description(format!(
                        "Install the sodilaud command? It opens files in Sodilaud from a terminal:\n\nsodilaud notes.md\n\nIt is a small script at {}. No administrator password is needed.",
                        context.shown
                    ))
                    .set_buttons(rfd::MessageButtons::OkCancelCustom(INSTALL.into(), CANCEL.into()))
                    .show();
                if !chose(&answer, INSTALL, rfd::MessageDialogResult::Ok) {
                    return;
                }
                install(&context.path, &script).map(|()| installed_message(&context))
            }
            State::Current => {
                let mut description =
                    format!("The sodilaud command is installed at {}.", context.shown);
                if !context.on_path {
                    description.push_str("\n\n");
                    description.push_str(&path_hint(context.shell.as_deref()));
                }
                let answer = rfd::MessageDialog::new()
                    .set_title(TITLE)
                    .set_description(description)
                    .set_buttons(rfd::MessageButtons::OkCancelCustom(
                        REMOVE.into(),
                        CLOSE.into(),
                    ))
                    .show();
                if !chose(&answer, REMOVE, rfd::MessageDialogResult::Ok) {
                    return;
                }
                remove(&context.path).map(|_| format!("Removed {}.", context.shown))
            }
            State::Outdated => {
                let answer = rfd::MessageDialog::new()
                    .set_title(TITLE)
                    .set_description(format!(
                        "The sodilaud command at {} was installed by another copy or version of Sodilaud. Update it to open this one?",
                        context.shown
                    ))
                    .set_buttons(rfd::MessageButtons::YesNoCancelCustom(
                        UPDATE.into(),
                        REMOVE.into(),
                        CLOSE.into(),
                    ))
                    .show();
                if chose(&answer, UPDATE, rfd::MessageDialogResult::Yes) {
                    install(&context.path, &script).map(|()| installed_message(&context))
                } else if chose(&answer, REMOVE, rfd::MessageDialogResult::No) {
                    remove(&context.path).map(|_| format!("Removed {}.", context.shown))
                } else {
                    return;
                }
            }
        };
        match result {
            Ok(message) => alert(&message),
            Err(error) => alert(&error),
        }
    }

    fn offer_remove(context: &Context, reason: &str) {
        let answer = rfd::MessageDialog::new()
            .set_title(TITLE)
            .set_description(format!(
                "{reason}\n\nThe sodilaud command at {} can still be removed.",
                context.shown
            ))
            .set_buttons(rfd::MessageButtons::OkCancelCustom(
                REMOVE.into(),
                CLOSE.into(),
            ))
            .show();
        if chose(&answer, REMOVE, rfd::MessageDialogResult::Ok) {
            match remove(&context.path) {
                Ok(_) => alert(&format!("Removed {}.", context.shown)),
                Err(error) => alert(&error),
            }
        }
    }

    /// Checks the install off the main thread (asking the login shell can take
    /// a moment), then shows the dialogs on it.
    pub(crate) fn offer(app: &AppHandle) {
        let app = app.clone();
        std::thread::spawn(move || {
            let context = context();
            let _ = app.run_on_main_thread(move || match context {
                Ok(context) => run(context),
                Err(error) => alert(&error),
            });
        });
    }
}

pub(crate) use dialog::offer;

#[tauri::command]
pub(crate) fn cli_tool_offer(app: tauri::AppHandle) {
    offer(&app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{Duration, Instant};

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "sodilaud-cli-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    const BUNDLE: &str = "/Applications/Sodilaud.app";

    #[test]
    fn the_script_is_marked_and_opens_the_bundle_through_launch_services() {
        let text = script(&Target::App(BUNDLE.into())).unwrap();
        assert!(text.starts_with("#!/bin/sh\n"));
        assert_eq!(text.lines().nth(1), Some(MARKER));
        assert!(text.contains("app='/Applications/Sodilaud.app'"));
        assert!(text.contains(r#"exec open -a "$app" "$@""#));
        assert!(!text.contains('\u{2014}'));
    }

    #[test]
    fn the_linux_script_runs_the_executable_detached() {
        let text = script(&Target::Executable("/opt/Sodilaud.AppImage".into())).unwrap();
        assert!(text.contains("exe='/opt/Sodilaud.AppImage'"));
        assert!(text.contains(r#"setsid "$exe" "$@" </dev/null >/dev/null 2>&1 &"#));
        assert!(!text.contains("open -a"));
    }

    #[test]
    fn baked_paths_are_quoted_for_the_shell() {
        let text = script(&Target::App("/Users/o'neil/My Apps/Sodilaud.app".into())).unwrap();
        assert!(text.contains(r"app='/Users/o'\''neil/My Apps/Sodilaud.app'"));
    }

    #[test]
    fn finds_the_bundle_an_executable_runs_from() {
        assert_eq!(
            app_bundle(Path::new(
                "/Applications/Sodilaud.app/Contents/MacOS/sodilaud"
            )),
            Some(PathBuf::from(BUNDLE))
        );
        for loose in [
            "/Users/me/sodilaud/src-tauri/target/debug/sodilaud",
            "/Applications/Sodilaud/Contents/MacOS/sodilaud",
            "/sodilaud",
        ] {
            assert_eq!(app_bundle(Path::new(loose)), None, "{loose}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_macos_build_outside_a_bundle_cannot_install() {
        let refused = target_for(Path::new("/Users/me/sodilaud/target/debug/sodilaud"));
        assert!(refused.unwrap_err().contains("development build"));
        let translocated = target_for(Path::new(
            "/private/var/folders/x/AppTranslocation/ABC/d/Sodilaud.app/Contents/MacOS/sodilaud",
        ));
        assert!(translocated.unwrap_err().contains("Applications folder"));
        assert_eq!(
            target_for(Path::new(
                "/Applications/Sodilaud.app/Contents/MacOS/sodilaud"
            )),
            Ok(Target::App(BUNDLE.into()))
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_launches_the_executable_itself() {
        assert_eq!(
            target_for(Path::new("/usr/bin/sodilaud")),
            Ok(Target::Executable("/usr/bin/sodilaud".into()))
        );
    }

    #[test]
    fn installs_once_updates_ours_and_removes_only_ours() {
        let home = scratch("install");
        let path = install_path(&home);
        let script = script(&Target::App(BUNDLE.into())).unwrap();
        assert_eq!(state(&path, &script), State::Missing);
        install(&path, &script).unwrap();
        assert_eq!(state(&path, &script), State::Current);
        assert_eq!(fs::read_to_string(&path).unwrap(), script);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
        install(&path, &script).unwrap();
        let leftovers = fs::read_dir(path.parent().unwrap()).unwrap().count();
        assert_eq!(leftovers, 1, "no temporary files are left behind");

        let moved = super::script(&Target::App("/elsewhere/Sodilaud.app".into())).unwrap();
        assert_eq!(state(&path, &moved), State::Outdated);
        install(&path, &moved).unwrap();
        assert_eq!(state(&path, &moved), State::Current);

        assert_eq!(remove(&path), Ok(true));
        assert_eq!(state(&path, &script), State::Missing);
        assert_eq!(remove(&path), Ok(false), "removing twice is fine");
    }

    #[test]
    fn a_command_that_is_not_ours_is_never_touched() {
        let home = scratch("foreign");
        let path = install_path(&home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let other = "#!/bin/sh\necho someone else's sodilaud\n";
        fs::write(&path, other).unwrap();
        let script = script(&Target::App(BUNDLE.into())).unwrap();
        assert_eq!(state(&path, &script), State::Foreign);
        assert!(install(&path, &script)
            .unwrap_err()
            .contains("not installed by Sodilaud"));
        assert!(remove(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), other);

        fs::remove_file(&path).unwrap();
        fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(
            state(&path, &script),
            State::Foreign,
            "a binary is not ours"
        );
        #[cfg(unix)]
        {
            fs::remove_file(&path).unwrap();
            let target = home.join("ours-looking");
            fs::write(&target, &script).unwrap();
            std::os::unix::fs::symlink(&target, &path).unwrap();
            assert_eq!(
                state(&path, &script),
                State::Foreign,
                "a link is the owner's"
            );
        }
    }

    #[test]
    fn checks_the_path_entries_exactly() {
        let directory = Path::new("/home/me/.local/bin");
        let joined = std::env::join_paths(["/usr/bin", "/home/me/.local/bin/", "/bin"]).unwrap();
        assert!(on_path(directory, &joined));
        let without = std::env::join_paths(["/usr/bin", "/home/me/.local/bin/x", "/bin"]).unwrap();
        assert!(!on_path(directory, &without));
        assert!(!on_path(directory, OsStr::new("")));
    }

    #[test]
    fn the_path_hint_names_the_shells_startup_file() {
        assert!(path_hint(Some("/bin/zsh")).contains("~/.zshrc"));
        assert!(path_hint(Some("/usr/bin/fish")).contains("fish_add_path ~/.local/bin"));
        let bash = path_hint(Some("/bin/bash"));
        if cfg!(target_os = "macos") {
            assert!(bash.contains("~/.bash_profile"));
        } else {
            assert!(bash.contains("~/.bashrc"));
        }
        let other = path_hint(None);
        assert!(other.contains(r#"export PATH="$HOME/.local/bin:$PATH""#));
        assert!(other.contains("new terminal"));
    }

    /// Runs the real script with a fake Sodilaud that records its arguments.
    struct Run {
        status: i32,
        stderr: String,
        stdout: String,
        launched: Option<Vec<String>>,
    }

    fn run(directory: &Path, args: &[&str]) -> Run {
        let bin = directory.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let record = directory.join("launched");
        let _ = fs::remove_file(&record);
        let fake = bin.join("fake-sodilaud");
        fs::write(
            &fake,
            format!(
                "#!/bin/sh\nfor a do printf '%s\\n' \"$a\"; done > '{0}.tmp'\nmv '{0}.tmp' '{0}'\n",
                record.display()
            ),
        )
        .unwrap();
        executable_mode(&fake).unwrap();
        let command = bin.join("sodilaud");
        let _ = fs::remove_file(&command);
        install(&command, &script(&Target::Executable(fake)).unwrap()).unwrap();
        let work = directory.join("work");
        fs::create_dir_all(&work).unwrap();
        let output = Command::new("sh")
            .arg(&command)
            .args(args)
            .current_dir(&work)
            .env("PWD", work.to_str().unwrap())
            .output()
            .unwrap();
        let status = output.status.code().unwrap();
        let mut launched = None;
        if status == 0 && output.stdout.is_empty() {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if let Ok(text) = fs::read_to_string(&record) {
                    launched = Some(text.lines().map(str::to_string).collect());
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        } else {
            std::thread::sleep(Duration::from_millis(100));
            assert!(!record.exists(), "a refused run launches nothing");
        }
        Run {
            status,
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            launched,
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_script_opens_absolute_paths_and_creates_missing_files() {
        let directory = scratch("run");
        let work = directory.join("work");
        fs::create_dir_all(work.join("docs")).unwrap();
        fs::write(work.join("docs/existing.md"), "kept\n").unwrap();
        let absolute = directory.join("Absolute Notes.TXT");
        let result = run(
            &directory,
            &[
                "docs/existing.md",
                "new.markdown",
                absolute.to_str().unwrap(),
                "--",
                "-dash.md",
            ],
        );
        assert_eq!(result.status, 0, "{}", result.stderr);
        let launched = result.launched.expect("the fake Sodilaud should run");
        let work = work.to_str().unwrap();
        assert_eq!(
            launched,
            [
                format!("{work}/docs/existing.md"),
                format!("{work}/new.markdown"),
                absolute.to_str().unwrap().to_string(),
                format!("{work}/-dash.md"),
            ]
        );
        assert_eq!(
            fs::read_to_string(format!("{work}/docs/existing.md")).unwrap(),
            "kept\n"
        );
        assert_eq!(
            fs::read_to_string(format!("{work}/new.markdown")).unwrap(),
            ""
        );
        assert!(absolute.exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_script_refuses_before_creating_or_launching_anything() {
        let directory = scratch("refuse");
        let work = directory.join("work");

        let wrong = run(&directory, &["fresh.md", "image.png"]);
        assert_eq!(wrong.status, 1);
        assert!(
            wrong
                .stderr
                .contains("image.png is not a Markdown or text file"),
            "{}",
            wrong.stderr
        );
        assert!(
            !work.join("fresh.md").exists(),
            "nothing is created when one argument fails"
        );

        let orphan = run(&directory, &["missing/notes.md"]);
        assert_eq!(orphan.status, 1);
        assert!(
            orphan.stderr.contains("does not exist"),
            "{}",
            orphan.stderr
        );
        assert!(
            !work.join("missing").exists(),
            "parent folders are not created"
        );

        fs::create_dir_all(work.join("folder.md")).unwrap();
        let folder = run(&directory, &["folder.md"]);
        assert_eq!(folder.status, 1);
        assert!(folder.stderr.contains("is a folder"), "{}", folder.stderr);

        let option = run(&directory, &["--wait", "a.md"]);
        assert_eq!(option.status, 2);
        assert!(
            option.stderr.contains("unknown option --wait"),
            "{}",
            option.stderr
        );

        let empty = run(&directory, &[]);
        assert_eq!(empty.status, 2);
        assert!(empty.stderr.contains("Usage: sodilaud FILE..."));

        let help = run(&directory, &["--help"]);
        assert_eq!(help.status, 0);
        assert!(help.stdout.contains("Usage: sodilaud FILE..."));
    }
}
