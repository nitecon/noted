use std::path::{Path, PathBuf};
use std::process::Command;

pub fn open_in_desktop(path: Option<&Path>) -> Result<(), Box<dyn std::error::Error>> {
    let path = path
        .map(resolve_path)
        .transpose()?
        .unwrap_or(std::env::current_dir()?);

    open_path(&path)
}

fn resolve_path(path: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };

    Ok(path)
}

#[cfg(target_os = "macos")]
fn open_path(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let status = Command::new("open")
        .arg("-a")
        .arg("Noted")
        .arg("--args")
        .arg(path)
        .status()?;

    if status.success() {
        Ok(())
    } else {
        Err("failed to launch Noted with `open -a Noted`".into())
    }
}

#[cfg(target_os = "windows")]
fn open_path(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    for executable in windows_desktop_candidates()? {
        if executable.exists() && spawn_detached(&executable, path).is_ok() {
            return Ok(());
        }
    }

    spawn_detached(Path::new("noted-desktop.exe"), path)
        .or_else(|_| spawn_detached(Path::new("Noted.exe"), path))
        .map_err(|_| "failed to launch Noted desktop executable".into())
}

#[cfg(target_os = "windows")]
fn windows_desktop_candidates() -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
    let exe = std::env::current_exe()?;
    let dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    Ok(vec![
        dir.join("Noted.exe"),
        dir.join("noted-desktop.exe"),
        dir.join("noted-desktop"),
    ])
}

#[cfg(target_os = "windows")]
fn spawn_detached(executable: &Path, path: &Path) -> std::io::Result<()> {
    Command::new(executable).arg(path).spawn().map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_path(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    for executable in linux_desktop_candidates()? {
        if executable.exists() && spawn_detached(&executable, path).is_ok() {
            return Ok(());
        }
    }

    spawn_detached(Path::new("noted-desktop"), path)
        .or_else(|_| spawn_detached(Path::new("Noted"), path))
        .map_err(|_| "failed to launch Noted desktop executable".into())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn linux_desktop_candidates() -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
    let exe = std::env::current_exe()?;
    let dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    Ok(vec![
        dir.join("noted-desktop"),
        dir.join("Noted"),
        PathBuf::from("/usr/bin/noted-desktop"),
        PathBuf::from("/usr/local/bin/noted-desktop"),
    ])
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_detached(executable: &Path, path: &Path) -> std::io::Result<()> {
    Command::new(executable).arg(path).spawn().map(|_| ())
}

#[cfg(not(any(target_os = "macos", target_os = "windows", unix)))]
fn open_path(_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    Err("opening Noted desktop is not supported on this platform".into())
}
