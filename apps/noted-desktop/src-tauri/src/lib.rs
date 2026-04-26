use std::env;
use std::path::Path;

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

#[derive(serde::Serialize)]
struct AgentCommand {
    command: String,
    available: bool,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![detect_agent_commands])
        .run(tauri::generate_context!())
        .expect("failed to run Noted desktop application");
}
