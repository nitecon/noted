use noted_core::{
    NotedConfig, PersistentIndex, SearchMode, SearchOptions, config_path, parse_markdown,
    search_vault, section_by_heading,
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
        Some("config") => config_command(&args[1..]),
        Some("outline") => outline_command(&args[1..]),
        Some("section") => section_command(&args[1..]),
        Some("help") | Some("--help") | Some("-h") => {
            print_help();
            Ok(())
        }
        Some(path) if !path.starts_with('-') => open_vault_command(Some(path)),
        None => open_vault_command(None),
        Some(command) => Err(format!("unknown option: {command}").into()),
    }
}

fn open_vault_command(path: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    let config = NotedConfig::load()?;
    let vault = config.resolve_vault(path)?;
    let update = PersistentIndex::refresh(&vault)?;
    let stats = update.index.stats();

    println!("vault: {}", vault.display());
    println!("index: {}", update.manifest_path.display());
    println!("documents: {}", stats.documents);
    println!(
        "scan: {} files, {} reused, {} updated, {} removed",
        update.scanned, update.reused, update.updated, update.removed
    );
    println!("desktop: launch integration pending; use `cd apps/noted-desktop && npm run dev`");

    Ok(())
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
    let mut rebuild = false;
    let mut refresh = false;
    let mut positionals = Vec::new();

    for argument in args {
        match argument.as_str() {
            "--rebuild" => rebuild = true,
            "--refresh" => refresh = true,
            "--help" | "-h" => {
                println!("usage: noted index [vault] [--refresh|--rebuild]");
                return Ok(());
            }
            argument if argument.starts_with('-') => {
                return Err(format!("unknown index option: {argument}").into());
            }
            argument => positionals.push(argument.to_owned()),
        }
    }

    if rebuild && refresh {
        return Err("usage: noted index [vault] [--refresh|--rebuild]".into());
    }
    if positionals.len() > 1 {
        return Err("usage: noted index [vault] [--refresh|--rebuild]".into());
    }

    let vault = positionals
        .first()
        .map(PathBuf::from)
        .unwrap_or(env::current_dir()?);
    let update = if rebuild {
        PersistentIndex::rebuild(&vault)?
    } else {
        PersistentIndex::refresh(&vault)?
    };
    let stats = update.index.stats();

    println!("vault: {}", vault.display());
    println!("index: {}", update.manifest_path.display());
    println!("documents: {}", stats.documents);
    println!("terms: {}", stats.terms);
    println!(
        "scan: {} files, {} reused, {} updated, {} removed",
        update.scanned, update.reused, update.updated, update.removed
    );

    for entry in update.index.entries() {
        let title = entry.title.as_deref().unwrap_or("(untitled)");
        println!(
            "{}\t{}\t{} bytes\t{} terms",
            vault.join(&entry.path).display(),
            title,
            entry.byte_len,
            entry.term_count
        );
    }

    Ok(())
}

fn config_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match args.first().map(String::as_str) {
        Some("set-vault") => {
            let path = args.get(1).ok_or("usage: noted config set-vault <path>")?;
            let mut config = NotedConfig::load()?;
            let vault = if PathBuf::from(path).is_absolute() {
                PathBuf::from(path)
            } else {
                env::current_dir()?.join(path)
            };
            config.vault = Some(vault.clone());
            let path = config.save()?;

            println!("config: {}", path.display());
            println!("vault: {}", vault.display());
            Ok(())
        }
        Some("path") => {
            println!("{}", config_path()?.display());
            Ok(())
        }
        Some("show") | None => {
            let config = NotedConfig::load()?;
            println!("config: {}", config_path()?.display());
            if let Some(vault) = config.vault {
                println!("vault: {}", vault.display());
            } else {
                println!("vault: (not configured)");
            }
            Ok(())
        }
        Some(command) => Err(format!("unknown config command: {command}").into()),
    }
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
        "noted\n\nUSAGE:\n  noted [vault]\n  noted config show\n  noted config set-vault <path>\n  noted index [vault] [--refresh|--rebuild]\n  noted search <query> [vault] [--limit n] [--mode bm25|vector]\n  noted outline <note.md>\n  noted section <note.md> <heading>"
    );
}
