pub mod config;
pub mod index;
pub mod markdown;
pub mod search;

pub use config::{NotedConfig, config_path};
pub use index::{IndexEntry, IndexUpdate, PersistentIndex, PersistentIndexStats, manifest_path};
pub use markdown::{
    Heading, MarkdownDocument, MarkdownError, Section, parse_markdown, section_by_heading,
};
pub use search::{
    IndexStats, NoteDocument, SearchHit, SearchMode, SearchOptions, VaultIndex, search_vault,
};
