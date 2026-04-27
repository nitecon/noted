use std::env;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use noted_core::{NotedConfig, PersistentIndex, config_path};

#[tauri::command]
fn detect_agent_commands() -> Vec<AgentCommand> {
    ["codex", "gemini", "claude"]
        .into_iter()
        .map(|command| AgentCommand {
            command: command.to_owned(),
            available: command_exists(command),
        })
        .collect()
}

#[tauri::command]
fn get_vault_config() -> Result<VaultConfigState, String> {
    let config = NotedConfig::load().map_err(|error| error.to_string())?;
    Ok(VaultConfigState {
        config_path: config_path()
            .map_err(|error| error.to_string())?
            .display()
            .to_string(),
        vault: config.vault.map(|vault| vault.display().to_string()),
    })
}

#[tauri::command]
fn set_vault_path(path: String) -> Result<VaultOpenState, String> {
    let mut config = NotedConfig::load().map_err(|error| error.to_string())?;
    config.vault = Some(path.clone().into());
    let config_path = config.save().map_err(|error| error.to_string())?;
    let update = PersistentIndex::refresh(&path).map_err(|error| error.to_string())?;
    let stats = update.index.stats();

    Ok(VaultOpenState {
        config_path: config_path.display().to_string(),
        vault: path,
        documents: stats.documents,
        reused: update.reused,
        updated: update.updated,
        removed: update.removed,
    })
}

#[tauri::command]
fn list_vault_tree(path: Option<String>) -> Result<Vec<TreeFolder>, String> {
    let root = match path {
        Some(path) => PathBuf::from(path),
        None => configured_vault()?,
    };
    let mut folders = Vec::new();
    collect_tree_folders(&root, &root, &mut folders).map_err(|error| error.to_string())?;
    folders.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(folders)
}

#[tauri::command]
fn delete_vault_path(relative_path: String, kind: String) -> Result<(), String> {
    if relative_path == "." && kind == "folder" {
        return Err("deleting the vault root is not allowed".to_owned());
    }

    let root = configured_vault()?;
    let path = resolve_existing_vault_path(&root, &relative_path)?;
    match kind.as_str() {
        "folder" => fs::remove_dir_all(path).map_err(|error| error.to_string()),
        "file" => fs::remove_file(path).map_err(|error| error.to_string()),
        _ => Err(format!("unsupported delete kind: {kind}")),
    }
}

#[tauri::command]
fn move_vault_file(relative_path: String, target_folder: String) -> Result<TreeFile, String> {
    let root = configured_vault()?;
    let source = resolve_existing_vault_path(&root, &relative_path)?;
    if !source.is_file() {
        return Err(format!("{relative_path} is not a file"));
    }

    let target_folder_path = resolve_existing_vault_path(&root, &target_folder)?;
    if !target_folder_path.is_dir() {
        return Err(format!("{target_folder} is not a folder"));
    }

    let file_name = source
        .file_name()
        .ok_or_else(|| format!("{relative_path} has no file name"))?;
    let target = target_folder_path.join(file_name);
    if target.exists() {
        return Err(format!(
            "{} already exists",
            relative_display(&root, &target)
        ));
    }

    fs::rename(&source, &target).map_err(|error| error.to_string())?;
    Ok(tree_file(&root, &target))
}

#[tauri::command]
fn move_vault_path(relative_path: String, target_folder: String) -> Result<TreePath, String> {
    if relative_path == "." {
        return Err("moving the vault root is not allowed".to_owned());
    }

    let root = configured_vault()?;
    let source = resolve_existing_vault_path(&root, &relative_path)?;
    let target_folder_path = resolve_existing_vault_path(&root, &target_folder)?;
    if !target_folder_path.is_dir() {
        return Err(format!("{target_folder} is not a folder"));
    }

    if source.is_dir() && target_folder_path.starts_with(&source) {
        return Err("moving a folder into itself is not allowed".to_owned());
    }

    let file_name = source
        .file_name()
        .ok_or_else(|| format!("{relative_path} has no file name"))?;
    let target = target_folder_path.join(file_name);
    if target.exists() {
        return Err(format!(
            "{} already exists",
            relative_display(&root, &target)
        ));
    }

    fs::rename(&source, &target).map_err(|error| error.to_string())?;
    Ok(tree_path(&root, &target))
}

#[tauri::command]
fn create_vault_note(folder_path: String, file_name: String) -> Result<TreeFile, String> {
    let root = configured_vault()?;
    let folder = resolve_existing_vault_path(&root, &folder_path)?;
    if !folder.is_dir() {
        return Err(format!("{folder_path} is not a folder"));
    }

    validate_child_name(&file_name)?;
    let path = folder.join(file_name);
    ensure_vault_child(&root, &path)?;
    if path.exists() {
        return Err(format!("{} already exists", relative_display(&root, &path)));
    }

    fs::write(&path, "# Untitled\n").map_err(|error| error.to_string())?;
    Ok(tree_file(&root, &path))
}

#[tauri::command]
fn create_vault_folder(parent_path: String, folder_name: String) -> Result<TreeFolder, String> {
    let root = configured_vault()?;
    let parent = resolve_existing_vault_path(&root, &parent_path)?;
    if !parent.is_dir() {
        return Err(format!("{parent_path} is not a folder"));
    }

    validate_child_name(&folder_name)?;
    let path = parent.join(&folder_name);
    ensure_vault_child(&root, &path)?;
    if path.exists() {
        return Err(format!("{} already exists", relative_display(&root, &path)));
    }

    fs::create_dir(&path).map_err(|error| error.to_string())?;
    Ok(TreeFolder {
        name: folder_label(root.as_path(), path.as_path()),
        path: relative_display(&root, &path),
        files: Vec::new(),
    })
}

#[tauri::command]
fn rename_vault_path(relative_path: String, new_name: String) -> Result<TreePath, String> {
    validate_child_name(&new_name)?;
    let root = configured_vault()?;
    let source = resolve_existing_vault_path(&root, &relative_path)?;
    if relative_path == "." {
        return Err("renaming the vault root is not allowed".to_owned());
    }

    let target = source
        .parent()
        .ok_or_else(|| format!("{relative_path} has no parent"))?
        .join(new_name);
    ensure_vault_child(&root, &target)?;
    if target.exists() {
        return Err(format!(
            "{} already exists",
            relative_display(&root, &target)
        ));
    }

    fs::rename(&source, &target).map_err(|error| error.to_string())?;
    Ok(tree_path(&root, &target))
}

#[tauri::command]
fn duplicate_vault_path(relative_path: String) -> Result<TreePath, String> {
    if relative_path == "." {
        return Err("duplicating the vault root is not allowed".to_owned());
    }

    let root = configured_vault()?;
    let source = resolve_existing_vault_path(&root, &relative_path)?;
    let target = next_copy_path(&source)?;
    ensure_vault_child(&root, &target)?;
    copy_path(&source, &target).map_err(|error| error.to_string())?;
    Ok(tree_path(&root, &target))
}

#[tauri::command]
fn paste_vault_path(source_path: String, target_folder: String) -> Result<TreePath, String> {
    if source_path == "." {
        return Err("copying the vault root is not allowed".to_owned());
    }

    let root = configured_vault()?;
    let source = resolve_existing_vault_path(&root, &source_path)?;
    let folder = resolve_existing_vault_path(&root, &target_folder)?;
    if !folder.is_dir() {
        return Err(format!("{target_folder} is not a folder"));
    }

    let file_name = source
        .file_name()
        .ok_or_else(|| format!("{source_path} has no file name"))?;
    let target = unique_child_path(&folder.join(file_name));
    ensure_vault_child(&root, &target)?;
    copy_path(&source, &target).map_err(|error| error.to_string())?;
    Ok(tree_path(&root, &target))
}

#[tauri::command]
fn read_vault_file(relative_path: String) -> Result<FileContentState, String> {
    let root = configured_vault()?;
    let path = resolve_existing_vault_path(&root, &relative_path)?;
    if !path.is_file() {
        return Err(format!("{relative_path} is not a file"));
    }

    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    Ok(FileContentState {
        path: relative_display(&root, &path),
        content,
    })
}

#[tauri::command]
fn write_vault_file(relative_path: String, content: String) -> Result<FileWriteState, String> {
    let root = configured_vault()?;
    let path = resolve_existing_vault_path(&root, &relative_path)?;
    if !path.is_file() {
        return Err(format!("{relative_path} is not a file"));
    }

    fs::write(&path, content.as_bytes()).map_err(|error| error.to_string())?;
    Ok(FileWriteState {
        path: relative_display(&root, &path),
        bytes: content.len(),
    })
}

#[tauri::command]
async fn run_agent_headless(request: AgentRunRequest) -> Result<AgentRunResponse, String> {
    tauri::async_runtime::spawn_blocking(move || run_agent_headless_blocking(request))
        .await
        .map_err(|error| error.to_string())?
}

#[derive(serde::Serialize)]
struct AgentCommand {
    command: String,
    available: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultConfigState {
    config_path: String,
    vault: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultOpenState {
    config_path: String,
    vault: String,
    documents: usize,
    reused: usize,
    updated: usize,
    removed: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeFolder {
    name: String,
    path: String,
    files: Vec<TreeFile>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeFile {
    name: String,
    path: String,
    kind: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TreePath {
    name: String,
    path: String,
    kind: String,
    item_type: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileContentState {
    path: String,
    content: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileWriteState {
    path: String,
    bytes: usize,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRunRequest {
    agent: String,
    model: String,
    prompt: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRunResponse {
    agent: String,
    model: String,
    command: String,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
}

fn run_agent_headless_blocking(request: AgentRunRequest) -> Result<AgentRunResponse, String> {
    if request.prompt.trim().is_empty() {
        return Err("prompt is empty".to_owned());
    }
    if !matches!(request.agent.as_str(), "codex" | "gemini" | "claude") {
        return Err(format!("unsupported agent: {}", request.agent));
    }
    if !command_exists(&request.agent) {
        return Err(format!("{} was not found in PATH", request.agent));
    }

    let root = configured_vault().ok();
    let mut command = Command::new(&request.agent);
    if let Some(root) = root.as_ref() {
        command.current_dir(root);
    }

    let write_prompt_to_stdin = request.agent != "codex";
    let args = agent_headless_args(
        &request.agent,
        &request.model,
        root.as_deref(),
        &request.prompt,
    );
    command.args(&args);
    if write_prompt_to_stdin {
        command.stdin(Stdio::piped());
    }
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|error| error.to_string())?;
    if write_prompt_to_stdin && let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(request.prompt.as_bytes())
            .map_err(|error| error.to_string())?;
    }

    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            format!(
                "{} exited with status {:?}",
                request.agent,
                output.status.code()
            )
        } else {
            stderr
        });
    }

    Ok(AgentRunResponse {
        command: format!("{} {}", request.agent, args.join(" ")),
        agent: request.agent,
        model: request.model,
        stdout,
        stderr,
        exit_code: output.status.code(),
    })
}

fn agent_headless_args(agent: &str, model: &str, root: Option<&Path>, prompt: &str) -> Vec<String> {
    match agent {
        "codex" => {
            let mut args = Vec::new();
            push_model_args(&mut args, model);
            args.extend(["exec".to_owned(), "--ephemeral".to_owned()]);
            if let Some(root) = root {
                args.extend([
                    "--cd".to_owned(),
                    root.display().to_string(),
                    "--skip-git-repo-check".to_owned(),
                ]);
            }
            args.push(prompt.to_owned());
            args
        }
        "claude" => {
            let mut args = vec!["--print".to_owned()];
            push_model_args(&mut args, model);
            args.extend([
                "--output-format".to_owned(),
                "text".to_owned(),
                "--no-session-persistence".to_owned(),
                "--permission-mode".to_owned(),
                "plan".to_owned(),
            ]);
            args
        }
        "gemini" => {
            let mut args = Vec::new();
            push_model_args(&mut args, model);
            args.extend([
                "--prompt".to_owned(),
                "Respond to the Noted request using the context provided on stdin.".to_owned(),
                "--output-format".to_owned(),
                "text".to_owned(),
                "--approval-mode".to_owned(),
                "plan".to_owned(),
            ]);
            args
        }
        _ => Vec::new(),
    }
}

fn push_model_args(args: &mut Vec<String>, model: &str) {
    if model != "default" {
        args.extend(["--model".to_owned(), model.to_owned()]);
    }
}

fn command_exists(command: &str) -> bool {
    let Some(paths) = env::var_os("PATH") else {
        return false;
    };

    env::split_paths(&paths).any(|path| {
        executable_candidates(&path, command)
            .iter()
            .any(|candidate| candidate.is_file())
    })
}

fn executable_candidates(path: &Path, command: &str) -> Vec<std::path::PathBuf> {
    #[cfg(windows)]
    {
        let extensions = env::var_os("PATHEXT")
            .and_then(|value| value.into_string().ok())
            .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_owned());
        extensions
            .split(';')
            .map(|extension| path.join(format!("{command}{extension}")))
            .chain(std::iter::once(path.join(command)))
            .collect()
    }

    #[cfg(not(windows))]
    {
        vec![path.join(command)]
    }
}

fn configured_vault() -> Result<PathBuf, String> {
    NotedConfig::load()
        .map_err(|error| error.to_string())?
        .vault
        .ok_or_else(|| "no vault is configured".to_owned())
}

fn collect_tree_folders(
    root: &Path,
    path: &Path,
    folders: &mut Vec<TreeFolder>,
) -> std::io::Result<()> {
    if is_ignored_directory(path) {
        return Ok(());
    }

    let mut files = Vec::new();
    let mut child_dirs = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let child_path = entry.path();
        if child_path.is_dir() {
            if !is_ignored_directory(&child_path) {
                child_dirs.push(child_path);
            }
        } else if child_path.is_file() {
            files.push(tree_file(root, &child_path));
        }
    }

    files.sort_by(|left, right| left.path.cmp(&right.path));
    child_dirs.sort();

    folders.push(TreeFolder {
        name: folder_label(root, path),
        path: relative_display(root, path),
        files,
    });

    for child_dir in child_dirs {
        collect_tree_folders(root, &child_dir, folders)?;
    }

    Ok(())
}

fn folder_label(root: &Path, path: &Path) -> String {
    if path == root {
        return "Vault root".to_owned();
    }

    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled")
        .to_owned()
}

fn tree_file(root: &Path, path: &Path) -> TreeFile {
    TreeFile {
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Untitled")
            .to_owned(),
        path: relative_display(root, path),
        kind: file_kind(path),
    }
}

fn tree_path(root: &Path, path: &Path) -> TreePath {
    let kind = if path.is_dir() {
        "folder".to_owned()
    } else {
        file_kind(path)
    };

    TreePath {
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Untitled")
            .to_owned(),
        path: relative_display(root, path),
        kind,
        item_type: if path.is_dir() { "folder" } else { "file" }.to_owned(),
    }
}

fn file_kind(path: &Path) -> String {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);

    match extension.as_deref() {
        Some("md" | "markdown") => "markdown",
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "svg") => "asset",
        _ => "code",
    }
    .to_owned()
}

fn relative_display(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    if relative.as_os_str().is_empty() {
        return ".".to_owned();
    }

    relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn resolve_existing_vault_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let path = vault_child_path(root, relative_path)?;
    if !path.exists() {
        return Err(format!("{relative_path} does not exist"));
    }

    ensure_vault_child(root, &path)?;
    Ok(path)
}

fn vault_child_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute() {
        return Err("absolute paths are not allowed".to_owned());
    }

    let mut path = root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(value) => path.push(value),
            Component::CurDir => {}
            _ => return Err("path traversal is not allowed".to_owned()),
        }
    }

    Ok(path)
}

fn validate_child_name(name: &str) -> Result<(), String> {
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(value)), None) if !value.is_empty() => Ok(()),
        _ => Err("name must be a single file or folder name".to_owned()),
    }
}

fn next_copy_path(source: &Path) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| "source path has no parent".to_owned())?;
    let file_stem = source
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("Untitled");
    let extension = source.extension().and_then(|extension| extension.to_str());
    let base = if source.is_dir() {
        source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Untitled")
            .to_owned()
    } else {
        file_stem.to_owned()
    };

    let mut counter = 1;
    loop {
        let name = match extension {
            Some(extension) if !source.is_dir() => format!("{base} copy {counter}.{extension}"),
            _ => format!("{base} copy {counter}"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
        counter += 1;
    }
}

fn unique_child_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }

    next_copy_path(path).unwrap_or_else(|_| path.to_path_buf())
}

fn copy_path(source: &Path, target: &Path) -> std::io::Result<()> {
    if source.is_dir() {
        fs::create_dir(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_path(&entry.path(), &target.join(entry.file_name()))?;
        }
        return Ok(());
    }

    fs::copy(source, target).map(|_| ())
}

fn ensure_vault_child(root: &Path, path: &Path) -> Result<(), String> {
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let canonical_path = if path.exists() {
        path.canonicalize().map_err(|error| error.to_string())?
    } else {
        path.parent()
            .ok_or_else(|| "path has no parent".to_owned())?
            .canonicalize()
            .map_err(|error| error.to_string())?
    };

    if canonical_path.starts_with(canonical_root) {
        Ok(())
    } else {
        Err("path is outside the configured vault".to_owned())
    }
}

fn is_ignored_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| matches!(name, ".git" | ".noted" | "target" | "node_modules"))
        .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            detect_agent_commands,
            get_vault_config,
            set_vault_path,
            list_vault_tree,
            delete_vault_path,
            move_vault_file,
            move_vault_path,
            create_vault_note,
            create_vault_folder,
            rename_vault_path,
            duplicate_vault_path,
            paste_vault_path,
            read_vault_file,
            write_vault_file,
            run_agent_headless
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Noted desktop application");
}
