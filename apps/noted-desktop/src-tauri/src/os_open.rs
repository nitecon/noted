use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Url};

use noted_core::NotedConfig;

const OPEN_TARGET_EVENT: &str = "open-target";

#[derive(Default)]
pub struct PendingOpenTarget(Mutex<Option<OpenTarget>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTarget {
    pub vault: String,
    pub file: Option<String>,
}

impl PendingOpenTarget {
    pub fn set(&self, target: OpenTarget) {
        if let Ok(mut pending) = self.0.lock() {
            *pending = Some(target);
        }
    }

    pub fn take(&self) -> Option<OpenTarget> {
        self.0.lock().ok().and_then(|mut pending| pending.take())
    }
}

pub fn startup_target() -> Option<OpenTarget> {
    let cwd = std::env::current_dir().ok();
    let args = std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    target_from_args(args, cwd.as_deref())
}

pub fn target_from_single_instance(args: Vec<String>, cwd: String) -> Option<OpenTarget> {
    let cwd = PathBuf::from(cwd);
    let args = args
        .into_iter()
        .skip(1)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    target_from_args(args, Some(&cwd))
}

pub fn target_from_opened_urls(urls: Vec<Url>) -> Option<OpenTarget> {
    let paths = urls
        .into_iter()
        .filter_map(|url| url.to_file_path().ok())
        .collect::<Vec<_>>();
    target_from_paths(paths)
}

pub fn target_from_user_path(path: &str) -> Option<OpenTarget> {
    target_from_paths(vec![PathBuf::from(path)])
}

pub fn emit_open_target(app: &AppHandle, target: OpenTarget) {
    if app.emit(OPEN_TARGET_EVENT, target.clone()).is_err() {
        app.state::<PendingOpenTarget>().set(target);
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn ensure_os_open_integration(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    platform::ensure_os_open_integration(app)
}

fn target_from_args(args: Vec<PathBuf>, cwd: Option<&Path>) -> Option<OpenTarget> {
    let paths = args
        .into_iter()
        .filter(|arg| !looks_like_flag(arg))
        .map(|arg| resolve_argument_path(arg, cwd))
        .collect::<Vec<_>>();
    target_from_paths(paths)
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::process::Command;

    pub fn ensure_os_open_integration(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        let exe = std::env::current_exe()?;
        let exe = exe.display().to_string();
        let command = format!("\"{exe}\" \"%1\"");

        add_shell_command(
            r"HKCU\Software\Classes\Directory\shell\Noted",
            "Open Folder in Noted",
            &exe,
            &command,
        )?;
        add_shell_command(
            r"HKCU\Software\Classes\SystemFileAssociations\.md\shell\Noted",
            "Open in Noted",
            &exe,
            &command,
        )?;
        add_shell_command(
            r"HKCU\Software\Classes\SystemFileAssociations\.markdown\shell\Noted",
            "Open in Noted",
            &exe,
            &command,
        )?;

        let _ = app;
        Ok(())
    }

    fn add_shell_command(
        key: &str,
        label: &str,
        icon: &str,
        command: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        reg_add_default(key, label)?;
        reg_add_value(key, "Icon", icon)?;
        reg_add_default(&format!(r"{key}\command"), command)
    }

    fn reg_add_default(key: &str, data: &str) -> Result<(), Box<dyn std::error::Error>> {
        let status = Command::new("reg")
            .arg("add")
            .arg(key)
            .arg("/f")
            .arg("/ve")
            .arg("/d")
            .arg(data)
            .status()?;

        if status.success() {
            Ok(())
        } else {
            Err(format!("failed to update registry key {key}").into())
        }
    }

    fn reg_add_value(key: &str, name: &str, data: &str) -> Result<(), Box<dyn std::error::Error>> {
        let status = Command::new("reg")
            .arg("add")
            .arg(key)
            .arg("/f")
            .arg("/v")
            .arg(name)
            .arg("/d")
            .arg(data)
            .status()?;

        if status.success() {
            Ok(())
        } else {
            Err(format!("failed to update registry value {key}\\{name}").into())
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use super::*;
    use std::fs;

    pub fn ensure_os_open_integration(_app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        let exe = std::env::current_exe()?;
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or("HOME is not set")?;
        let applications = home.join(".local/share/applications");
        fs::create_dir_all(&applications)?;

        let desktop_file = applications.join("org.whattingh.noted.desktop");
        let content = format!(
            "[Desktop Entry]\nType=Application\nName=Noted\nExec={} %F\nIcon=noted\nTerminal=false\nCategories=Office;TextEditor;\nMimeType=text/markdown;text/x-markdown;inode/directory;\n",
            exe.display()
        );
        fs::write(desktop_file, content)?;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    pub fn ensure_os_open_integration(_app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
mod platform {
    use super::*;

    pub fn ensure_os_open_integration(_app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }
}

fn target_from_paths(paths: Vec<PathBuf>) -> Option<OpenTarget> {
    let configured_vault = NotedConfig::load().ok().and_then(|config| config.vault);

    paths
        .into_iter()
        .find_map(|path| target_from_path(&path, configured_vault.as_deref()))
}

fn target_from_path(path: &Path, configured_vault: Option<&Path>) -> Option<OpenTarget> {
    let path = path.canonicalize().ok()?;
    if path.is_dir() {
        return Some(OpenTarget {
            vault: path.display().to_string(),
            file: None,
        });
    }

    if !path.is_file() {
        return None;
    }

    let configured_vault = configured_vault.and_then(|vault| vault.canonicalize().ok());
    let vault = configured_vault
        .as_deref()
        .filter(|vault| path.starts_with(vault))
        .map(Path::to_path_buf)
        .or_else(|| path.parent().map(Path::to_path_buf))?;
    let file = path.strip_prefix(&vault).ok().map(relative_display)?;

    Some(OpenTarget {
        vault: vault.display().to_string(),
        file: Some(file),
    })
}

fn resolve_argument_path(arg: PathBuf, cwd: Option<&Path>) -> PathBuf {
    if arg.is_absolute() {
        return arg;
    }

    cwd.map(|cwd| cwd.join(&arg)).unwrap_or(arg)
}

fn looks_like_flag(arg: &Path) -> bool {
    arg.to_str()
        .map(|value| value.starts_with('-'))
        .unwrap_or(false)
}

fn relative_display(path: &Path) -> String {
    path.components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/")
}
