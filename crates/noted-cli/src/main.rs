use noted_core::{
    SearchMode, SearchOptions, VaultIndex, parse_markdown, search_vault, section_by_heading,
};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process;

fn main() {
    if let Err(error) = run(env::args().skip(1).collect()) {
        eprintln!("error: {error}");
        process::exit(1);
    }
}

fn run(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    match args.first().map(String::as_str) {
        Some("search") => search_command(&args[1..]),
        Some("index") => index_command(&args[1..]),
        Some("outline") => outline_command(&args[1..]),
        Some("section") => section_command(&args[1..]),
        Some("help") | Some("--help") | Some("-h") | None => {
            print_help();
            Ok(())
        }
        Some(command) => Err(format!("unknown command: {command}").into()),
    }
}

fn search_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let mut limit = SearchOptions::default().limit;
    let mut mode = SearchMode::Bm25;
    let mut positionals = Vec::new();
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--limit" | "-n" => {
                index += 1;
                let value = args.get(index).ok_or(
                    "usage: noted search <query> [vault] [--limit n] [--mode bm25|vector]",
                )?;
                limit = value.parse()?;
            }
            "--mode" => {
                index += 1;
                let value = args.get(index).ok_or(
                    "usage: noted search <query> [vault] [--limit n] [--mode bm25|vector]",
                )?;
                mode = parse_search_mode(value)?;
            }
            argument => positionals.push(argument.to_owned()),
        }
        index += 1;
    }

    if positionals.is_empty() {
        return Err("usage: noted search <query> [vault] [--limit n] [--mode bm25|vector]".into());
    }

    let query = &positionals[0];
    let vault = positionals
        .get(1)
        .map(PathBuf::from)
        .unwrap_or(env::current_dir()?);
    let hits = search_vault(vault, query, SearchOptions { limit, mode })?;

    for hit in hits {
        println!(
            "{}:{}\t{:.3}\t{}",
            hit.path.display(),
            hit.line,
            hit.score,
            hit.excerpt
        );
    }

    Ok(())
}

fn parse_search_mode(value: &str) -> Result<SearchMode, Box<dyn std::error::Error>> {
    match value {
        "bm25" => Ok(SearchMode::Bm25),
        "vector" => Ok(SearchMode::Vector),
        _ => Err(format!("unknown search mode: {value}").into()),
    }
}

fn index_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let vault = args
        .first()
        .map(PathBuf::from)
        .unwrap_or(env::current_dir()?);
    let index = VaultIndex::build(&vault)?;
    let stats = index.stats();

    println!("vault: {}", vault.display());
    println!("documents: {}", stats.documents);
    println!("terms: {}", stats.terms);

    for note in index.notes() {
        let title = note.title.as_deref().unwrap_or("(untitled)");
        println!(
            "{}\t{}\t{} bytes",
            note.path.display(),
            title,
            note.byte_len
        );
    }

    Ok(())
}

fn outline_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let path = args
        .first()
        .ok_or("usage: noted outline <note.md>")?
        .as_str();
    let source = fs::read_to_string(path)?;
    let document = parse_markdown(source);

    for heading in document.headings {
        let indent = "  ".repeat(heading.level.saturating_sub(1));
        println!("{indent}- L{} {}", heading.line, heading.title);
    }

    Ok(())
}

fn section_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    if args.len() < 2 {
        return Err("usage: noted section <note.md> <heading>".into());
    }

    let path = &args[0];
    let heading = args[1..].join(" ");
    let source = fs::read_to_string(path)?;
    let section = section_by_heading(&source, &heading)?;

    println!("{}", section.text);

    Ok(())
}

fn print_help() {
    println!(
        "noted\n\nUSAGE:\n  noted index [vault]\n  noted search <query> [vault] [--limit n] [--mode bm25|vector]\n  noted outline <note.md>\n  noted section <note.md> <heading>"
    );
}
