//! Workspace text search for the Pro mode 찾기 view.
//!
//! Walks `root` with the `ignore` crate, so `.gitignore`, `.ignore` and
//! hidden-file rules apply, and matches line by line with the `regex` crate.
//! Binary files and files over [`MAX_READ_BYTES`] are skipped.

use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::WalkBuilder;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::files::{canonical_root, FsError, MAX_READ_BYTES};

/// Folders never searched, even when no ignore file lists them.
const ALWAYS_SKIPPED: &[&str] = &[".git", "node_modules", "target", ".baton"];

/// A NUL byte within this many leading bytes marks a file as binary.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// Default cap on the number of matches returned.
const DEFAULT_MAX_RESULTS: usize = 2000;

/// Default cap on the number of files returned by `list_files`.
const DEFAULT_MAX_FILES: usize = 20_000;

/// Preview text is trimmed to about this many characters around the first match.
const PREVIEW_CHARS: usize = 200;

/// Characters kept before the first match when a long line is trimmed.
const PREVIEW_CONTEXT_BEFORE: usize = 40;

/// Each new search bumps this, so a search the user has already replaced
/// (for example while still typing) stops early.
static SEARCH_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
    /// Comma-separated globs; when non-empty only matching files are searched.
    pub include: String,
    /// Comma-separated globs of files and folders to leave out.
    pub exclude: String,
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LineMatch {
    /// 1-based line number.
    pub line: usize,
    /// 1-based column of the first match, in UTF-16 code units.
    pub column: usize,
    /// The line, trimmed around the match when long.
    pub preview: String,
    /// `[start, end)` ranges inside `preview`, in UTF-16 code units.
    pub ranges: Vec<[usize; 2]>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileMatches {
    /// Relative to `root`, always `/`-separated.
    pub path: String,
    pub matches: Vec<LineMatch>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub files: Vec<FileMatches>,
    /// More matches exist than were returned.
    pub truncated: bool,
    pub searched_files: usize,
}

fn invalid_query(message: impl Into<String>) -> FsError {
    FsError { kind: "invalid_query", message: message.into() }
}

/// Build the line matcher from the query and the toggles.
pub(crate) fn build_regex(query: &str, opts: &SearchOptions) -> Result<Regex, FsError> {
    let mut pattern = if opts.regex { query.to_string() } else { regex::escape(query) };
    if opts.whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    if !opts.case_sensitive {
        pattern = format!("(?i){pattern}");
    }
    Regex::new(&pattern).map_err(|e| match e {
        regex::Error::CompiledTooBig(_) => invalid_query("정규식이 너무 복잡해요. 조금 더 단순하게 바꿔 주세요."),
        _ => invalid_query("정규식이 올바르지 않아요. 괄호나 특수 문자를 확인해 주세요."),
    })
}

/// Split a comma-separated glob list, keeping commas inside `{a,b}` groups.
pub(crate) fn parse_globs(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut depth = 0usize;
    for ch in raw.chars() {
        match ch {
            '{' => {
                depth += 1;
                cur.push(ch);
            }
            '}' => {
                depth = depth.saturating_sub(1);
                cur.push(ch);
            }
            ',' if depth == 0 => out.push(std::mem::take(&mut cur)),
            _ => cur.push(ch),
        }
    }
    out.push(cur);
    out.into_iter()
        .map(|g| {
            let g = g.trim();
            let g = g.trim_start_matches('!');
            let g = g.strip_prefix("./").unwrap_or(g);
            g.trim_end_matches('/').to_string()
        })
        .filter(|g| !g.is_empty())
        .collect()
}

/// Compile globs with gitignore semantics: `*.ts` matches at any depth,
/// `src/**` is anchored to the root, and a folder name covers its contents.
fn build_globs(root: &Path, raw: &str, label: &str) -> Result<Option<Gitignore>, FsError> {
    let globs = parse_globs(raw);
    if globs.is_empty() {
        return Ok(None);
    }
    let mut builder = GitignoreBuilder::new(root);
    for glob in &globs {
        builder
            .add_line(None, glob)
            .map_err(|_| invalid_query(format!("{label} 패턴이 올바르지 않아요: {glob}")))?;
    }
    builder
        .build()
        .map(Some)
        .map_err(|_| invalid_query(format!("{label} 패턴이 올바르지 않아요.")))
}

fn rel_string(rel: &Path) -> String {
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Read a text file for searching, or `None` when it is too large, binary or unreadable.
fn read_text(path: &Path, len: u64) -> Option<String> {
    if len > MAX_READ_BYTES {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::with_capacity(len as usize);
    file.by_ref().take(MAX_READ_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_READ_BYTES {
        return None;
    }
    let sniff = &bytes[..bytes.len().min(BINARY_SNIFF_BYTES)];
    if sniff.contains(&0) {
        return None;
    }
    Some(match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    })
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Byte offset `n` characters before `from`, but not before `floor`.
fn back_chars(line: &str, from: usize, n: usize, floor: usize) -> usize {
    line[floor..from]
        .char_indices()
        .rev()
        .take(n)
        .last()
        .map_or(from, |(i, _)| floor + i)
}

/// Byte offset `n` characters after `from`, or the end of the line.
fn forward_chars(line: &str, from: usize, n: usize) -> usize {
    line[from..].char_indices().nth(n).map_or(line.len(), |(i, _)| from + i)
}

/// Build the preview for one line from byte ranges of its matches.
pub(crate) fn make_preview(line: &str, spans: &[(usize, usize)]) -> (String, usize, Vec<[usize; 2]>) {
    let first = spans.first().map_or(0, |s| s.0);
    let column = utf16_len(&line[..first]) + 1;
    let lead = (line.len() - line.trim_start().len()).min(first);

    let (start, end) = if line[lead..].chars().count() <= PREVIEW_CHARS {
        (lead, line.len())
    } else {
        let start = back_chars(line, first, PREVIEW_CONTEXT_BEFORE, lead);
        (start, forward_chars(line, start, PREVIEW_CHARS))
    };
    let prefix = if start > lead { "…" } else { "" };
    let suffix = if end < line.len() { "…" } else { "" };
    let preview = format!("{prefix}{}{suffix}", &line[start..end]);

    let shift = utf16_len(prefix);
    let ranges = spans
        .iter()
        .filter(|(s, e)| *e > start && *s < end)
        .map(|&(s, e)| {
            let s = s.max(start);
            let e = e.min(end);
            let a = shift + utf16_len(&line[start..s]);
            [a, a + utf16_len(&line[s..e])]
        })
        .collect();
    (preview, column, ranges)
}

/// Search `root` for `query`. `cancelled` is polled between files.
pub(crate) fn search(
    root: &str,
    query: &str,
    opts: &SearchOptions,
    cancelled: &dyn Fn() -> bool,
) -> Result<SearchResult, FsError> {
    let canon = canonical_root(root)?;
    if query.is_empty() {
        return Ok(SearchResult::default());
    }
    let re = build_regex(query, opts)?;
    let include = build_globs(&canon, &opts.include, "포함할 파일")?;
    let exclude = build_globs(&canon, &opts.exclude, "제외할 파일")?;
    let max = opts.max_results.filter(|&m| m > 0).unwrap_or(DEFAULT_MAX_RESULTS);

    let mut walker = WalkBuilder::new(&canon);
    walker
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .ignore(true)
        .require_git(false)
        .follow_links(false)
        .sort_by_file_name(|a, b| a.cmp(b));
    {
        // Excluded folders are pruned here, so their contents are never visited.
        let root = canon.clone();
        walker.filter_entry(move |entry| {
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            if is_dir && entry.depth() > 0 {
                let name = entry.file_name().to_string_lossy();
                if ALWAYS_SKIPPED.contains(&name.as_ref()) {
                    return false;
                }
            }
            match (&exclude, entry.path().strip_prefix(&root)) {
                (Some(ex), Ok(rel)) if entry.depth() > 0 => !ex.matched(rel, is_dir).is_ignore(),
                _ => true,
            }
        });
    }

    let mut result = SearchResult::default();
    let mut total = 0usize;
    'files: for entry in walker.build() {
        if cancelled() {
            break;
        }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(&canon) else { continue };
        if let Some(inc) = &include {
            if !inc.matched_path_or_any_parents(rel, false).is_ignore() {
                continue;
            }
        }
        let len = entry.metadata().map(|m| m.len()).unwrap_or(u64::MAX);
        let Some(text) = read_text(entry.path(), len) else { continue };
        result.searched_files += 1;

        let mut matches = Vec::new();
        for (idx, raw_line) in text.split('\n').enumerate() {
            let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
            let mut spans = Vec::new();
            for m in re.find_iter(line) {
                if m.start() == m.end() {
                    continue;
                }
                if total == max {
                    result.truncated = true;
                    break;
                }
                total += 1;
                spans.push((m.start(), m.end()));
            }
            if !spans.is_empty() {
                let (preview, column, ranges) = make_preview(line, &spans);
                matches.push(LineMatch { line: idx + 1, column, preview, ranges });
            }
            if result.truncated {
                break;
            }
        }
        if !matches.is_empty() {
            result.files.push(FileMatches { path: rel_string(rel), matches });
        }
        if result.truncated {
            break 'files;
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn search_text(root: String, query: String, opts: SearchOptions) -> Result<SearchResult, FsError> {
    let seq = SEARCH_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    tokio::task::spawn_blocking(move || {
        search(&root, &query, &opts, &|| SEARCH_SEQ.load(Ordering::SeqCst) != seq)
    })
    .await
    .map_err(|e| FsError::io(format!("작업 실행에 실패했어요: {e}")))?
}

/// Walk `root` with the same ignore/hidden rules as [`search`] and return `/`-separated relative file paths.
pub(crate) fn list_files_in(root: &str, limit: Option<usize>) -> Result<Vec<String>, FsError> {
    let canon = canonical_root(root)?;
    let max = limit.filter(|&n| n > 0).unwrap_or(DEFAULT_MAX_FILES);

    let mut walker = WalkBuilder::new(&canon);
    walker
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .ignore(true)
        .require_git(false)
        .follow_links(false)
        .sort_by_file_name(|a, b| a.cmp(b));
    walker.filter_entry(|entry| {
        if entry.depth() > 0 && entry.file_type().is_some_and(|t| t.is_dir()) {
            let name = entry.file_name().to_string_lossy();
            if ALWAYS_SKIPPED.contains(&name.as_ref()) {
                return false;
            }
        }
        true
    });

    let mut files = Vec::new();
    for entry in walker.build() {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(&canon) else { continue };
        files.push(rel_string(rel));
        if files.len() >= max {
            break;
        }
    }
    Ok(files)
}

#[tauri::command]
pub async fn list_files(root: String, limit: Option<usize>) -> Result<Vec<String>, FsError> {
    tokio::task::spawn_blocking(move || list_files_in(&root, limit))
        .await
        .map_err(|e| FsError::io(format!("작업 실행에 실패했어요: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let n = SEQ.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!("baton-search-{tag}-{}-{n}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn write(&self, rel: &str, contents: impl AsRef<[u8]>) {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }

        fn root(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn run(dir: &TempDir, query: &str, opts: SearchOptions) -> SearchResult {
        search(&dir.root(), query, &opts, &|| false).unwrap()
    }

    fn paths(r: &SearchResult) -> Vec<&str> {
        r.files.iter().map(|f| f.path.as_str()).collect()
    }

    fn count(r: &SearchResult) -> usize {
        r.files.iter().flat_map(|f| &f.matches).map(|m| m.ranges.len()).sum()
    }

    #[test]
    fn literal_search_escapes_special_characters() {
        let dir = TempDir::new("literal");
        dir.write("a.txt", "let x = foo(1);\nfoo.bar\nfooXbar\n");
        let r = run(&dir, "foo.bar", SearchOptions::default());
        assert_eq!(paths(&r), ["a.txt"]);
        let m = &r.files[0].matches;
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].line, 2);
        assert_eq!(m[0].column, 1);
        assert_eq!(m[0].ranges, [[0, 7]]);
        assert_eq!(r.searched_files, 1);
        assert!(!r.truncated);

        let r = run(&dir, "foo(1)", SearchOptions::default());
        assert_eq!(r.files[0].matches[0].line, 1);
        assert_eq!(r.files[0].matches[0].column, 9);
    }

    #[test]
    fn case_sensitivity_toggle() {
        let dir = TempDir::new("case");
        dir.write("a.txt", "Hello\nhello\nHELLO\n");
        let r = run(&dir, "hello", SearchOptions::default());
        assert_eq!(count(&r), 3);
        let r = run(&dir, "hello", SearchOptions { case_sensitive: true, ..Default::default() });
        assert_eq!(count(&r), 1);
        assert_eq!(r.files[0].matches[0].line, 2);
    }

    #[test]
    fn whole_word_toggle() {
        let dir = TempDir::new("word");
        dir.write("a.txt", "cat concat cats cat\n");
        let r = run(&dir, "cat", SearchOptions::default());
        assert_eq!(count(&r), 4);
        let r = run(&dir, "cat", SearchOptions { whole_word: true, ..Default::default() });
        assert_eq!(r.files[0].matches[0].ranges, [[0, 3], [16, 19]]);
    }

    #[test]
    fn regex_search() {
        let dir = TempDir::new("regex");
        dir.write("a.rs", "fn alpha() {}\nlet beta = 1;\nfn gamma_2() {}\n");
        let opts = SearchOptions { regex: true, ..Default::default() };
        let r = run(&dir, r"fn \w+\(", opts.clone());
        let lines: Vec<usize> = r.files[0].matches.iter().map(|m| m.line).collect();
        assert_eq!(lines, [1, 3]);
        assert_eq!(r.files[0].matches[1].ranges, [[0, 11]]);
        // Empty matches are skipped instead of flooding results.
        let r = run(&dir, "x*", opts);
        assert!(r.files.is_empty());
    }

    #[test]
    fn invalid_regex_returns_korean_error() {
        let dir = TempDir::new("badregex");
        dir.write("a.txt", "x\n");
        let opts = SearchOptions { regex: true, ..Default::default() };
        let err = search(&dir.root(), "(unclosed", &opts, &|| false).unwrap_err();
        assert_eq!(err.kind, "invalid_query");
        assert!(err.message.contains("정규식이 올바르지 않아요"), "{}", err.message);
        // The same text is fine as a literal search.
        assert!(search(&dir.root(), "(unclosed", &SearchOptions::default(), &|| false).is_ok());
    }

    #[test]
    fn include_and_exclude_globs() {
        let dir = TempDir::new("globs");
        dir.write("src/a.ts", "needle\n");
        dir.write("src/b.tsx", "needle\n");
        dir.write("src/gen/c.ts", "needle\n");
        dir.write("docs/d.md", "needle\n");
        dir.write("e.ts", "needle\n");

        let r = run(&dir, "needle", SearchOptions { include: "*.ts".into(), ..Default::default() });
        assert_eq!(paths(&r), ["e.ts", "src/a.ts", "src/gen/c.ts"]);

        let r = run(&dir, "needle", SearchOptions { include: "src/**, *.md".into(), ..Default::default() });
        assert_eq!(paths(&r), ["docs/d.md", "src/a.ts", "src/b.tsx", "src/gen/c.ts"]);

        let r = run(&dir, "needle", SearchOptions { include: "src".into(), ..Default::default() });
        assert_eq!(paths(&r), ["src/a.ts", "src/b.tsx", "src/gen/c.ts"]);

        let r = run(&dir, "needle", SearchOptions { include: "*.{ts,tsx}".into(), ..Default::default() });
        assert_eq!(paths(&r), ["e.ts", "src/a.ts", "src/b.tsx", "src/gen/c.ts"]);

        let r = run(
            &dir,
            "needle",
            SearchOptions { include: "src/**".into(), exclude: "gen, *.tsx".into(), ..Default::default() },
        );
        assert_eq!(paths(&r), ["src/a.ts"]);
        assert_eq!(r.searched_files, 1);
    }

    #[test]
    fn parse_globs_splits_outside_braces() {
        assert_eq!(parse_globs(" src/**, *.ts ,, ./lib/ "), ["src/**", "*.ts", "lib"]);
        assert_eq!(parse_globs("*.{ts,tsx},docs"), ["*.{ts,tsx}", "docs"]);
        assert!(parse_globs("  ").is_empty());
    }

    #[test]
    fn respects_gitignore_hidden_and_always_skipped_folders() {
        let dir = TempDir::new("ignore");
        dir.write(".gitignore", "dist/\n*.log\n");
        dir.write("keep.txt", "needle\n");
        dir.write("dist/out.js", "needle\n");
        dir.write("debug.log", "needle\n");
        dir.write(".hidden/x.txt", "needle\n");
        dir.write("node_modules/pkg/index.js", "needle\n");
        dir.write("target/debug/y.txt", "needle\n");
        dir.write(".baton/z.txt", "needle\n");
        dir.write("sub/.ignore", "skip.txt\n");
        dir.write("sub/skip.txt", "needle\n");
        dir.write("sub/ok.txt", "needle\n");
        let r = run(&dir, "needle", SearchOptions::default());
        assert_eq!(paths(&r), ["keep.txt", "sub/ok.txt"]);
    }

    #[test]
    fn skips_binary_and_large_files() {
        let dir = TempDir::new("binary");
        let mut bin = b"needle\n".to_vec();
        bin.push(0);
        dir.write("bin.dat", bin);
        let mut big = "needle\n".repeat(10).into_bytes();
        big.resize(MAX_READ_BYTES as usize + 1, b'a');
        dir.write("big.txt", big);
        dir.write("text.txt", "needle\n");
        let r = run(&dir, "needle", SearchOptions::default());
        assert_eq!(paths(&r), ["text.txt"]);
        assert_eq!(r.searched_files, 1);
    }

    #[test]
    fn stops_at_max_results_and_sets_truncated() {
        let dir = TempDir::new("limit");
        dir.write("a.txt", "x x x\nx\n");
        dir.write("b.txt", "x\n");
        let r = run(&dir, "x", SearchOptions { max_results: Some(3), ..Default::default() });
        assert_eq!(count(&r), 3);
        assert!(r.truncated);
        assert_eq!(paths(&r), ["a.txt"]);

        // Exactly at the limit is not truncated.
        let r = run(&dir, "x", SearchOptions { max_results: Some(5), ..Default::default() });
        assert_eq!(count(&r), 5);
        assert!(!r.truncated);
    }

    #[test]
    fn cancelled_search_stops_early() {
        let dir = TempDir::new("cancel");
        dir.write("a.txt", "x\n");
        let r = search(&dir.root(), "x", &SearchOptions::default(), &|| true).unwrap();
        assert!(r.files.is_empty());
    }

    #[test]
    fn missing_root_is_rejected() {
        let err = search("/definitely/not/here/baton", "x", &SearchOptions::default(), &|| false).unwrap_err();
        assert_eq!(err.kind, "not_found");
    }

    #[test]
    fn preview_trims_long_lines_and_shifts_ranges() {
        let line = format!("{}needle{}", "a".repeat(300), "b".repeat(300));
        let (preview, column, ranges) = make_preview(&line, &[(300, 306)]);
        assert_eq!(column, 301);
        assert!(preview.starts_with('…') && preview.ends_with('…'));
        assert_eq!(preview.chars().count(), PREVIEW_CHARS + 2);
        let [s, e] = ranges[0];
        let units: Vec<u16> = preview.encode_utf16().collect();
        assert_eq!(String::from_utf16(&units[s..e]).unwrap(), "needle");
    }

    #[test]
    fn preview_strips_indent_and_counts_utf16() {
        let line = "    const 한글 = \"😀 needle\";";
        let start = line.find("needle").unwrap();
        let (preview, column, ranges) = make_preview(line, &[(start, start + 6)]);
        assert_eq!(preview, "const 한글 = \"😀 needle\";");
        // 4 spaces + `const 한글 = "` (12 units) + emoji (2 units) + space, then 1-based.
        assert_eq!(column, 4 + 12 + 2 + 1 + 1);
        let units: Vec<u16> = preview.encode_utf16().collect();
        assert_eq!(String::from_utf16(&units[ranges[0][0]..ranges[0][1]]).unwrap(), "needle");
    }

    #[test]
    fn list_files_respects_gitignore_hidden_and_always_skipped() {
        let dir = TempDir::new("list-ignore");
        dir.write(".gitignore", "dist/\n*.log\n");
        dir.write("README.md", "hi\n");
        dir.write("src/main.rs", "fn main() {}\n");
        dir.write("dist/bundle.js", "x\n");
        dir.write("app.log", "x\n");
        dir.write(".hidden/secret.txt", "x\n");
        dir.write("node_modules/pkg/index.js", "x\n");
        dir.write("target/debug/bin", "x\n");
        dir.write(".baton/session.json", "x\n");

        let files = list_files_in(&dir.root(), None).unwrap();
        assert_eq!(files, ["README.md", "src/main.rs"]);
    }

    #[test]
    fn list_files_respects_limit() {
        let dir = TempDir::new("list-limit");
        dir.write("a.txt", "1");
        dir.write("b.txt", "2");
        dir.write("c.txt", "3");

        let files = list_files_in(&dir.root(), Some(2)).unwrap();
        assert_eq!(files, ["a.txt", "b.txt"]);
    }

    #[test]
    fn list_files_rejects_missing_root() {
        let err = list_files_in("/definitely/not/here/baton", None).unwrap_err();
        assert_eq!(err.kind, "not_found");
    }
}
