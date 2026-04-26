pub mod markdown;
pub mod search;

pub use markdown::{
    Heading, MarkdownDocument, MarkdownError, Section, parse_markdown, section_by_heading,
};
pub use search::{
    IndexStats, NoteDocument, SearchHit, SearchMode, SearchOptions, VaultIndex, search_vault,
};
