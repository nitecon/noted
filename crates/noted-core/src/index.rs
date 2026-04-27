use crate::search::{collect_markdown_paths, first_heading, modified_unix_seconds, tokenize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const INDEX_DIRECTORY: &str = ".noted/index";
const MANIFEST_FILE: &str = "manifest.tsv";
const MANIFEST_VERSION: &str = "noted-index-v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistentIndex {
    entries: Vec<IndexEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEntry {
    pub path: PathBuf,
    pub byte_len: u64,
    pub modified_unix_seconds: Option<u64>,
    pub title: Option<String>,
    pub term_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistentIndexStats {
    pub documents: usize,
    pub terms: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexUpdate {
    pub index: PersistentIndex,
    pub manifest_path: PathBuf,
    pub scanned: usize,
    pub reused: usize,
    pub updated: usize,
    pub removed: usize,
}

impl PersistentIndex {
    pub fn load(vault_root: impl AsRef<Path>) -> io::Result<Option<Self>> {
        let path = manifest_path(vault_root.as_ref());
        if !path.exists() {
            return Ok(None);
        }

        let manifest = fs::read_to_string(path)?;
        let mut lines = manifest.lines();
        match lines.next() {
            Some(MANIFEST_VERSION) => {}
            Some(version) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unsupported index manifest version: {version}"),
                ));
            }
            None => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "empty index manifest",
                ));
            }
        }

        let mut entries = Vec::new();
        for (line_index, line) in lines.enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            entries.push(parse_entry(line).map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid index manifest line {}: {error}", line_index + 2),
                )
            })?);
        }

        Ok(Some(Self { entries }))
    }

    pub fn rebuild(vault_root: impl AsRef<Path>) -> io::Result<IndexUpdate> {
        write_index(vault_root.as_ref(), None)
    }

    pub fn refresh(vault_root: impl AsRef<Path>) -> io::Result<IndexUpdate> {
        let existing = Self::load(vault_root.as_ref())?;
        write_index(vault_root.as_ref(), existing.as_ref())
    }

    pub fn entries(&self) -> &[IndexEntry] {
        &self.entries
    }

    pub fn stats(&self) -> PersistentIndexStats {
        PersistentIndexStats {
            documents: self.entries.len(),
            terms: self.entries.iter().map(|entry| entry.term_count).sum(),
        }
    }
}

pub fn manifest_path(vault_root: impl AsRef<Path>) -> PathBuf {
    vault_root
        .as_ref()
        .join(INDEX_DIRECTORY)
        .join(MANIFEST_FILE)
}

fn write_index(root: &Path, existing: Option<&PersistentIndex>) -> io::Result<IndexUpdate> {
    let manifest_path = manifest_path(root);
    let (index, scanned, reused, updated, removed) = build_index(root, existing)?;
    let index_dir = manifest_path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "index manifest path has no parent directory",
        )
    })?;
    fs::create_dir_all(index_dir)?;

    let temporary_path = manifest_path.with_extension("tmp");
    fs::write(&temporary_path, serialize_manifest(&index))?;
    if manifest_path.exists() {
        fs::remove_file(&manifest_path)?;
    }
    fs::rename(&temporary_path, &manifest_path)?;

    Ok(IndexUpdate {
        index,
        manifest_path,
        scanned,
        reused,
        updated,
        removed,
    })
}

fn build_index(
    root: &Path,
    existing: Option<&PersistentIndex>,
) -> io::Result<(PersistentIndex, usize, usize, usize, usize)> {
    let mut paths = Vec::new();
    collect_markdown_paths(root, &mut paths)?;
    paths.sort();

    let existing_entries = existing
        .map(|index| {
            index
                .entries
                .iter()
                .map(|entry| (entry.path.clone(), entry.clone()))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();

    let mut entries = Vec::new();
    let mut reused = 0usize;
    let mut updated = 0usize;
    let mut current_paths = HashSet::new();

    for path in paths {
        let metadata = fs::metadata(&path)?;
        let relative_path = relative_path(root, &path);
        current_paths.insert(relative_path.clone());
        let byte_len = metadata.len();
        let modified = modified_unix_seconds(&metadata);

        if let Some(existing_entry) = existing_entries.get(&relative_path)
            && existing_entry.byte_len == byte_len
            && existing_entry.modified_unix_seconds == modified
        {
            entries.push(existing_entry.clone());
            reused += 1;
            continue;
        }

        let text = fs::read_to_string(&path)?;
        entries.push(IndexEntry {
            path: relative_path,
            byte_len,
            modified_unix_seconds: modified,
            title: first_heading(&text),
            term_count: tokenize(&text).len(),
        });
        updated += 1;
    }

    entries.sort_by(|left, right| left.path.cmp(&right.path));
    let removed = existing_entries
        .keys()
        .filter(|path| !current_paths.contains(*path))
        .count();

    let scanned = entries.len();
    Ok((
        PersistentIndex { entries },
        scanned,
        reused,
        updated,
        removed,
    ))
}

fn relative_path(root: &Path, path: &Path) -> PathBuf {
    path.strip_prefix(root).unwrap_or(path).to_path_buf()
}

fn serialize_manifest(index: &PersistentIndex) -> String {
    let mut manifest = String::from(MANIFEST_VERSION);
    manifest.push('\n');

    for entry in &index.entries {
        manifest.push_str(&escape_field(&entry.path.to_string_lossy()));
        manifest.push('\t');
        manifest.push_str(&entry.byte_len.to_string());
        manifest.push('\t');
        if let Some(modified) = entry.modified_unix_seconds {
            manifest.push_str(&modified.to_string());
        }
        manifest.push('\t');
        if let Some(title) = &entry.title {
            manifest.push_str(&escape_field(title));
        }
        manifest.push('\t');
        manifest.push_str(&entry.term_count.to_string());
        manifest.push('\n');
    }

    manifest
}

fn parse_entry(line: &str) -> Result<IndexEntry, String> {
    let fields = line.split('\t').collect::<Vec<_>>();
    if fields.len() != 5 {
        return Err(format!("expected 5 fields, found {}", fields.len()));
    }

    let path = PathBuf::from(unescape_field(fields[0])?);
    let byte_len = fields[1]
        .parse()
        .map_err(|error| format!("invalid byte length: {error}"))?;
    let modified_unix_seconds = if fields[2].is_empty() {
        None
    } else {
        Some(
            fields[2]
                .parse()
                .map_err(|error| format!("invalid modified timestamp: {error}"))?,
        )
    };
    let title = if fields[3].is_empty() {
        None
    } else {
        Some(unescape_field(fields[3])?)
    };
    let term_count = fields[4]
        .parse()
        .map_err(|error| format!("invalid term count: {error}"))?;

    Ok(IndexEntry {
        path,
        byte_len,
        modified_unix_seconds,
        title,
        term_count,
    })
}

fn escape_field(field: &str) -> String {
    let mut escaped = String::new();
    for character in field.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '\t' => escaped.push_str("\\t"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            _ => escaped.push(character),
        }
    }
    escaped
}

fn unescape_field(field: &str) -> Result<String, String> {
    let mut unescaped = String::new();
    let mut characters = field.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            unescaped.push(character);
            continue;
        }

        match characters.next() {
            Some('\\') => unescaped.push('\\'),
            Some('t') => unescaped.push('\t'),
            Some('n') => unescaped.push('\n'),
            Some('r') => unescaped.push('\r'),
            Some(other) => return Err(format!("unknown escape sequence: \\{other}")),
            None => return Err("trailing escape character".to_owned()),
        }
    }

    Ok(unescaped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn rebuild_writes_manifest_with_metadata() {
        let root = temporary_root("noted-persist-rebuild");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("alpha.md"), "# Alpha\nrust notes\n").unwrap();
        fs::write(root.join("ignore.txt"), "rust notes\n").unwrap();

        let update = PersistentIndex::rebuild(&root).unwrap();
        let loaded = PersistentIndex::load(&root).unwrap().unwrap();

        assert_eq!(update.scanned, 1);
        assert_eq!(update.reused, 0);
        assert_eq!(update.updated, 1);
        assert_eq!(update.removed, 0);
        assert!(update.manifest_path.ends_with(".noted/index/manifest.tsv"));
        assert_eq!(loaded.entries().len(), 1);
        assert_eq!(loaded.entries()[0].path, PathBuf::from("alpha.md"));
        assert_eq!(loaded.entries()[0].title.as_deref(), Some("Alpha"));
        assert_eq!(loaded.entries()[0].term_count, 3);
        assert_eq!(loaded.stats().documents, 1);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refresh_reuses_unchanged_entries_and_removes_deleted_files() {
        let root = temporary_root("noted-persist-refresh");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("alpha.md"), "# Alpha\nrust notes\n").unwrap();
        fs::write(root.join("beta.md"), "# Beta\nsearch notes\n").unwrap();

        PersistentIndex::rebuild(&root).unwrap();
        fs::remove_file(root.join("beta.md")).unwrap();

        let update = PersistentIndex::refresh(&root).unwrap();

        assert_eq!(update.scanned, 1);
        assert_eq!(update.reused, 1);
        assert_eq!(update.updated, 0);
        assert_eq!(update.removed, 1);
        assert_eq!(update.index.entries()[0].path, PathBuf::from("alpha.md"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manifest_round_trips_escaped_fields() {
        let index = PersistentIndex {
            entries: vec![IndexEntry {
                path: PathBuf::from("folder/tab\tname.md"),
                byte_len: 10,
                modified_unix_seconds: Some(42),
                title: Some("Title\twith\ncontrols\\slash".to_owned()),
                term_count: 4,
            }],
        };

        let manifest = serialize_manifest(&index);
        let line = manifest.lines().nth(1).unwrap();
        let parsed = parse_entry(line).unwrap();

        assert_eq!(parsed, index.entries[0]);
    }

    fn temporary_root(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{}-{}",
            prefix,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
}
