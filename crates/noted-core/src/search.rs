use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone)]
pub struct SearchOptions {
    pub limit: usize,
    pub mode: SearchMode,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            limit: 20,
            mode: SearchMode::Bm25,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchMode {
    Bm25,
    Vector,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub path: PathBuf,
    pub score: f64,
    pub line: usize,
    pub excerpt: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexStats {
    pub documents: usize,
    pub terms: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteDocument {
    pub path: PathBuf,
    pub title: Option<String>,
    pub byte_len: u64,
    pub modified_unix_seconds: Option<u64>,
    pub term_count: usize,
}

#[derive(Debug, Clone)]
pub struct VaultIndex {
    documents: Vec<IndexedDocument>,
    document_frequencies: HashMap<String, usize>,
    average_length: f64,
}

impl VaultIndex {
    pub fn build(vault_root: impl AsRef<Path>) -> io::Result<Self> {
        let documents = load_documents(vault_root.as_ref())?;
        let document_count = documents.len() as f64;
        let average_length = if documents.is_empty() {
            0.0
        } else {
            documents
                .iter()
                .map(|document| document.terms.len() as f64)
                .sum::<f64>()
                / document_count
        };
        let document_frequencies = document_frequencies(&documents);

        Ok(Self {
            documents,
            document_frequencies,
            average_length,
        })
    }

    pub fn stats(&self) -> IndexStats {
        IndexStats {
            documents: self.documents.len(),
            terms: self.document_frequencies.values().copied().sum::<usize>(),
        }
    }

    pub fn notes(&self) -> Vec<NoteDocument> {
        self.documents
            .iter()
            .map(|document| NoteDocument {
                path: document.path.clone(),
                title: document.title.clone(),
                byte_len: document.byte_len,
                modified_unix_seconds: document.modified_unix_seconds,
                term_count: document.terms.len(),
            })
            .collect()
    }

    pub fn search(&self, query: &str, options: SearchOptions) -> Vec<SearchHit> {
        let query_terms = tokenize(query);
        if query_terms.is_empty() || self.documents.is_empty() {
            return Vec::new();
        }

        let document_count = self.documents.len() as f64;
        let mut hits = self
            .documents
            .iter()
            .filter_map(|document| {
                let score = match options.mode {
                    SearchMode::Bm25 => bm25_score(
                        document,
                        &query_terms,
                        &self.document_frequencies,
                        document_count,
                        self.average_length,
                    ),
                    SearchMode::Vector => {
                        vector_score(document, &query_terms, &self.document_frequencies)
                    }
                };
                (score > 0.0).then(|| SearchHit {
                    path: document.path.clone(),
                    score,
                    line: best_line(&document.text, &query_terms),
                    excerpt: best_excerpt(&document.text, &query_terms),
                })
            })
            .collect::<Vec<_>>();

        hits.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(Ordering::Equal)
                .then_with(|| left.path.cmp(&right.path))
        });
        hits.truncate(options.limit);

        hits
    }
}

#[derive(Debug, Clone)]
struct IndexedDocument {
    path: PathBuf,
    title: Option<String>,
    byte_len: u64,
    modified_unix_seconds: Option<u64>,
    text: String,
    terms: Vec<String>,
    term_counts: HashMap<String, usize>,
}

pub fn search_vault(
    vault_root: impl AsRef<Path>,
    query: &str,
    options: SearchOptions,
) -> io::Result<Vec<SearchHit>> {
    Ok(VaultIndex::build(vault_root)?.search(query, options))
}

fn load_documents(root: &Path) -> io::Result<Vec<IndexedDocument>> {
    let mut paths = Vec::new();
    collect_markdown_paths(root, &mut paths)?;
    paths.sort();

    paths
        .into_iter()
        .map(|path| {
            let metadata = fs::metadata(&path)?;
            let text = fs::read_to_string(&path)?;
            let terms = tokenize(&text);
            let term_counts = term_counts(&terms);
            Ok(IndexedDocument {
                title: first_heading(&text),
                byte_len: metadata.len(),
                modified_unix_seconds: modified_unix_seconds(&metadata),
                path,
                text,
                terms,
                term_counts,
            })
        })
        .collect()
}

pub(crate) fn collect_markdown_paths(path: &Path, paths: &mut Vec<PathBuf>) -> io::Result<()> {
    if path.is_file() {
        if is_markdown(path) {
            paths.push(path.to_path_buf());
        }
        return Ok(());
    }

    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() && !is_ignored_directory(&path) {
            collect_markdown_paths(&path, paths)?;
        } else if is_markdown(&path) {
            paths.push(path);
        }
    }

    Ok(())
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown"))
        .unwrap_or(false)
}

fn is_ignored_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| matches!(name, ".git" | ".noted" | "target" | "node_modules"))
        .unwrap_or(false)
}

pub(crate) fn first_heading(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let line = line.trim_start();
        let level = line
            .chars()
            .take_while(|character| *character == '#')
            .count();
        if !(1..=6).contains(&level) {
            return None;
        }
        let title = line.get(level..)?.trim().trim_end_matches('#').trim();
        (!title.is_empty()).then(|| title.to_owned())
    })
}

pub(crate) fn modified_unix_seconds(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

pub(crate) fn tokenize(text: &str) -> Vec<String> {
    text.split(|character: char| !character.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(|term| term.to_lowercase())
        .collect()
}

fn term_counts(terms: &[String]) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for term in terms {
        *counts.entry(term.clone()).or_insert(0) += 1;
    }
    counts
}

fn document_frequencies(documents: &[IndexedDocument]) -> HashMap<String, usize> {
    let mut frequencies = HashMap::new();
    for document in documents {
        let unique_terms = document.terms.iter().collect::<HashSet<_>>();
        for term in unique_terms {
            *frequencies.entry(term.clone()).or_insert(0) += 1;
        }
    }
    frequencies
}

fn bm25_score(
    document: &IndexedDocument,
    query_terms: &[String],
    document_frequencies: &HashMap<String, usize>,
    document_count: f64,
    average_length: f64,
) -> f64 {
    const K1: f64 = 1.5;
    const B: f64 = 0.75;

    let document_length = document.terms.len() as f64;
    query_terms
        .iter()
        .map(|term| {
            let term_frequency = *document.term_counts.get(term).unwrap_or(&0) as f64;
            if term_frequency == 0.0 {
                return 0.0;
            }

            let document_frequency = *document_frequencies.get(term).unwrap_or(&0) as f64;
            let idf = ((document_count - document_frequency + 0.5) / (document_frequency + 0.5)
                + 1.0)
                .ln();
            let denominator =
                term_frequency + K1 * (1.0 - B + B * (document_length / average_length.max(1.0)));

            idf * (term_frequency * (K1 + 1.0)) / denominator
        })
        .sum()
}

fn vector_score(
    document: &IndexedDocument,
    query_terms: &[String],
    document_frequencies: &HashMap<String, usize>,
) -> f64 {
    let mut query_counts = HashMap::new();
    for term in query_terms {
        *query_counts.entry(term).or_insert(0usize) += 1;
    }

    let mut dot = 0.0;
    let mut query_norm = 0.0;
    let mut document_norm = 0.0;

    for (term, query_count) in query_counts {
        let document_count = *document.term_counts.get(term).unwrap_or(&0) as f64;
        if document_count == 0.0 {
            continue;
        }

        let idf = inverse_document_frequency(term, document_frequencies);
        let query_weight = query_count as f64 * idf;
        let document_weight = document_count * idf;

        dot += query_weight * document_weight;
        query_norm += query_weight.powi(2);
    }

    for (term, document_count) in &document.term_counts {
        let weight =
            *document_count as f64 * inverse_document_frequency(term, document_frequencies);
        document_norm += weight.powi(2);
    }

    if query_norm == 0.0 || document_norm == 0.0 {
        return 0.0;
    }

    dot / (query_norm.sqrt() * document_norm.sqrt())
}

fn inverse_document_frequency(term: &str, document_frequencies: &HashMap<String, usize>) -> f64 {
    let document_frequency = *document_frequencies.get(term).unwrap_or(&0) as f64;
    (1.0 / (document_frequency + 1.0)).ln_1p() + 1.0
}

fn best_line(text: &str, query_terms: &[String]) -> usize {
    text.lines()
        .enumerate()
        .find(|(_, line)| {
            let normalized = line.to_lowercase();
            query_terms.iter().any(|term| normalized.contains(term))
        })
        .map(|(index, _)| index + 1)
        .unwrap_or(1)
}

fn best_excerpt(text: &str, query_terms: &[String]) -> String {
    text.lines()
        .find(|line| {
            let normalized = line.to_lowercase();
            query_terms.iter().any(|term| normalized.contains(term))
        })
        .unwrap_or_else(|| text.lines().next().unwrap_or(""))
        .trim()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn searches_markdown_files_with_bm25_scores() {
        let root = std::env::temp_dir().join(format!(
            "noted-search-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("alpha.md"), "# Alpha\nrust rust notes\n").unwrap();
        fs::write(root.join("beta.md"), "# Beta\nother notes\n").unwrap();
        fs::write(root.join("ignore.txt"), "rust").unwrap();

        let hits = search_vault(&root, "rust", SearchOptions::default()).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path.file_name().unwrap(), "alpha.md");
        assert_eq!(hits[0].line, 2);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn builds_index_with_note_metadata_and_respects_limit() {
        let root = std::env::temp_dir().join(format!(
            "noted-index-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("alpha.md"), "# Alpha\nshared term\n").unwrap();
        fs::write(root.join("beta.markdown"), "# Beta\nshared term\n").unwrap();
        fs::write(
            root.join(".git").join("hidden.md"),
            "# Hidden\nshared term\n",
        )
        .unwrap();

        let index = VaultIndex::build(&root).unwrap();
        let notes = index.notes();
        let hits = index.search(
            "shared",
            SearchOptions {
                limit: 1,
                ..SearchOptions::default()
            },
        );

        assert_eq!(index.stats().documents, 2);
        assert_eq!(notes.len(), 2);
        assert!(
            notes
                .iter()
                .any(|note| note.title.as_deref() == Some("Alpha"))
        );
        assert_eq!(hits.len(), 1);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn supports_vector_search_mode() {
        let root = std::env::temp_dir().join(format!(
            "noted-vector-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("alpha.md"), "# Alpha\nagent agent context\n").unwrap();
        fs::write(root.join("beta.md"), "# Beta\nrecipes garden cooking\n").unwrap();

        let hits = search_vault(
            &root,
            "agent context",
            SearchOptions {
                limit: 10,
                mode: SearchMode::Vector,
            },
        )
        .unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path.file_name().unwrap(), "alpha.md");
        assert!(hits[0].score > 0.0);

        fs::remove_dir_all(root).unwrap();
    }
}
