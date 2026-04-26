use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Heading {
    pub level: usize,
    pub title: String,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    pub heading: Heading,
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownDocument {
    pub source: String,
    pub headings: Vec<Heading>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarkdownError {
    HeadingNotFound(String),
}

impl fmt::Display for MarkdownError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MarkdownError::HeadingNotFound(heading) => {
                write!(f, "heading not found: {heading}")
            }
        }
    }
}

impl std::error::Error for MarkdownError {}

pub fn parse_markdown(source: impl Into<String>) -> MarkdownDocument {
    let source = source.into();
    let headings = parse_headings(&source);
    MarkdownDocument { source, headings }
}

pub fn section_by_heading(source: &str, heading_query: &str) -> Result<Section, MarkdownError> {
    let document = parse_markdown(source);
    let query = normalize_heading(heading_query);
    let heading_index = document
        .headings
        .iter()
        .position(|heading| normalize_heading(&heading.title) == query)
        .ok_or_else(|| MarkdownError::HeadingNotFound(heading_query.to_owned()))?;

    let heading = document.headings[heading_index].clone();
    let end_line = document
        .headings
        .iter()
        .skip(heading_index + 1)
        .find(|candidate| candidate.level <= heading.level)
        .map(|candidate| candidate.line.saturating_sub(1))
        .unwrap_or_else(|| source.lines().count().max(heading.line));

    let text = source
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let line_number = index + 1;
            (line_number >= heading.line && line_number <= end_line).then_some(line)
        })
        .collect::<Vec<_>>()
        .join("\n");

    Ok(Section {
        heading,
        start_line: document.headings[heading_index].line,
        end_line,
        text,
    })
}

fn parse_headings(source: &str) -> Vec<Heading> {
    let mut headings = Vec::new();
    let mut in_fenced_code = false;

    for (index, line) in source.lines().enumerate() {
        let trimmed_start = line.trim_start();
        if trimmed_start.starts_with("```") || trimmed_start.starts_with("~~~") {
            in_fenced_code = !in_fenced_code;
            continue;
        }

        if in_fenced_code {
            continue;
        }

        if let Some(heading) = parse_heading_line(trimmed_start, index + 1) {
            headings.push(heading);
        }
    }

    headings
}

fn parse_heading_line(line: &str, line_number: usize) -> Option<Heading> {
    let level = line
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if !(1..=6).contains(&level) {
        return None;
    }

    let rest = line.get(level..)?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }

    let title = rest.trim().trim_end_matches('#').trim().to_owned();
    if title.is_empty() {
        return None;
    }

    Some(Heading {
        level,
        title,
        line: line_number,
    })
}

fn normalize_heading(heading: &str) -> String {
    heading.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_atx_headings_outside_fenced_code() {
        let document = parse_markdown("# Title\n\n```md\n# Ignored\n```\n## Child\n");

        assert_eq!(
            document.headings,
            vec![
                Heading {
                    level: 1,
                    title: "Title".to_owned(),
                    line: 1
                },
                Heading {
                    level: 2,
                    title: "Child".to_owned(),
                    line: 6
                }
            ]
        );
    }

    #[test]
    fn extracts_section_until_next_same_or_higher_heading() {
        let source = "# Title\nintro\n## Alpha\nfirst\n### Detail\nmore\n## Beta\nsecond\n";

        let section = section_by_heading(source, "alpha").unwrap();

        assert_eq!(section.start_line, 3);
        assert_eq!(section.end_line, 6);
        assert_eq!(section.text, "## Alpha\nfirst\n### Detail\nmore");
    }
}
