use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NotedConfig {
    pub vault: Option<PathBuf>,
}

impl NotedConfig {
    pub fn load() -> io::Result<Self> {
        let path = config_path()?;
        if !path.exists() {
            return Ok(Self::default());
        }

        parse_config(&fs::read_to_string(path)?)
    }

    pub fn save(&self) -> io::Result<PathBuf> {
        let path = config_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, serialize_config(self))?;
        Ok(path)
    }

    pub fn resolve_vault(&self, path: Option<&str>) -> io::Result<PathBuf> {
        match path {
            Some(path) => absolute_path(path),
            None => self.vault.clone().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "no vault configured; run `noted config set-vault <path>` or `noted <path>`",
                )
            }),
        }
    }
}

pub fn config_path() -> io::Result<PathBuf> {
    home_dir().map(|home| home.join(".noted").join("config.yml"))
}

fn absolute_path(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    let path = path.as_ref();
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()?.join(path)
    };

    fs::canonicalize(&absolute).or(Ok(absolute))
}

fn home_dir() -> io::Result<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home directory not found"))
}

fn parse_config(source: &str) -> io::Result<NotedConfig> {
    let mut config = NotedConfig::default();
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };

        if key.trim() == "vault" {
            let value = value.trim().trim_matches('"').trim_matches('\'');
            if !value.is_empty() {
                config.vault = Some(PathBuf::from(value));
            }
        }
    }

    Ok(config)
}

fn serialize_config(config: &NotedConfig) -> String {
    let mut output = String::new();
    if let Some(vault) = &config.vault {
        output.push_str("vault: \"");
        output.push_str(
            &vault
                .to_string_lossy()
                .replace('\\', "\\\\")
                .replace('"', "\\\""),
        );
        output.push_str("\"\n");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vault_from_minimal_yaml() {
        let config = parse_config("vault: \"/tmp/notes\"\n").unwrap();

        assert_eq!(config.vault, Some(PathBuf::from("/tmp/notes")));
    }

    #[test]
    fn serializes_vault_as_yaml() {
        let config = NotedConfig {
            vault: Some(PathBuf::from("/tmp/notes")),
        };

        assert_eq!(serialize_config(&config), "vault: \"/tmp/notes\"\n");
    }
}
