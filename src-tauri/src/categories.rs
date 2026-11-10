//! Rule-based file and directory categorisation.
//!
//! Rules live in a JSON file so the community can extend them without touching
//! Rust. The AI layer is only asked about things these rules could not explain,
//! which keeps token usage (and therefore cost) down.
//!
//! ## Why directories are classified by their contents
//!
//! The first version classified files by extension and directories by path
//! fragment. That produced a screen of "other": a directory has no extension,
//! and the only directories that matched were ones sitting under a path we had
//! written out by hand. Users look at directories, so nearly everything was
//! grey.
//!
//! The fix is to let a directory inherit the composition of its contents: if
//! 77 GB of a folder is video, the folder is video. Explicit rules still win
//! (a Steam library is "game" even though it is mostly `.vpk` data blocks),
//! so the two mechanisms are ordered, not mixed.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

const RULES_JSON: &str = include_str!("../../rules/categories.json");

/// Share of a directory's bytes one category must reach for the directory to
/// be labelled with it. 0.5 means "most of this folder is X", which is the
/// reading a user expects from a colour. Lower values make folders look mixed
/// and noisy; higher values push too much back into "other".
const DOMINANCE: f64 = 0.5;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub zh: String,
    pub en: String,
    pub verdict: String,
    pub color: String,
    pub explain_zh: String,
    pub explain_en: String,
    /// Path rules beat extension rules for this category. Set for categories
    /// where the location is the whole story (a `.dll` under system32 is
    /// system, not "program file"; a `.txt` under steamapps is a game).
    #[serde(default)]
    pub path_over_ext: bool,
    /// Unrecognised children of a folder matched by an explicit rule inherit
    /// this category. Set for content owners where everything inside belongs to
    /// the same thing (a game's asset folder, a program's data folder). Left
    /// false for deletion-oriented categories (`cache`, `temp`): calling an
    /// unknown 80 GB blob "safe cache" is exactly the mistake this tool must
    /// not make.
    #[serde(default)]
    pub inherit: bool,
    /// This category is only a *guess at what owns the bytes*, not a claim
    /// about the place. A Steam game's asset folder is full of extensionless
    /// data blocks, so both "this is program data" and "this is part of a
    /// game" are true; the container wins because it is the thing the user
    /// can actually act on ("uninstall the game", not "delete 40 GB of .pak").
    #[serde(default)]
    pub weak: bool,
    #[serde(default)]
    pub path_any: Vec<String>,
    #[serde(default)]
    pub dir_any: Vec<String>,
    #[serde(default)]
    pub dir_has_any: Vec<String>,
    #[serde(default)]
    pub name_any: Vec<String>,
    #[serde(default)]
    pub name_has_any: Vec<String>,
    #[serde(default)]
    pub ext_any: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RuleFile {
    #[allow(dead_code)]
    version: u32,
    #[allow(dead_code)]
    note: String,
    categories: Vec<Category>,
}

pub fn all() -> &'static Vec<Category> {
    static CACHE: OnceLock<Vec<Category>> = OnceLock::new();
    CACHE.get_or_init(|| {
        serde_json::from_str::<RuleFile>(RULES_JSON)
            .map(|f| f.categories)
            .unwrap_or_default()
    })
}

/// Rules are matched by id in a few places; a linear scan over ~20 entries is
/// cheaper than keeping a second index in sync with the JSON.
pub fn by_id(id: &str) -> Option<&'static Category> {
    all().iter().find(|c| c.id == id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
}

fn basename(path_lower: &str) -> &str {
    path_lower.rsplit(['\\', '/']).next().unwrap_or(path_lower)
}

/// Does `path` contain the path fragment `frag` at a folder boundary?
///
/// A plain `contains` is too loose and caused real misclassifications: the
/// rule `\cache` also matched `\cache_pc`, so a 52 GB game was
/// labelled app cache and dragged its parent folder with it. Requiring a
/// separator (or end of path) after the fragment fixes that while keeping
/// `\\temp\\` style fragments working.
fn path_hit(path: &str, frag: &str) -> bool {
    // Fragments that already end in a separator carry their own boundary.
    let needs_tail = !frag.ends_with(['\\', '/']);
    let bytes = path.as_bytes();
    let mut from = 0;
    while let Some(i) = path[from..].find(frag) {
        let end = from + i + frag.len();
        if !needs_tail || end == bytes.len() || bytes[end] == b'\\' || bytes[end] == b'/' {
            return true;
        }
        // Fragments start with an ASCII separator, so +1 stays on a boundary.
        from += i + 1;
    }
    false
}

/// Turn a stored id back into the static reference the rule set owns.
///
/// Node stores its category as an owned `String` so the tree stays `Serialize`
/// and cheap to clone; aggregation needs the `&'static str` keys the rules use.
pub fn id_ref(id: &str) -> &'static str {
    by_id(id).map(|c| c.id.as_str()).unwrap_or("other")
}

/// Classify one entry from its lowercase full path, lowercased extension and
/// whether it is a directory.
///
/// Directories are matched against explicit directory rules only; if nothing
/// hits, `None` is returned and the caller is expected to fall back to
/// `compose` with the children's sizes. That split is deliberate: only the
/// caller has the children.
pub fn classify(path_lower: &str, ext_lower: &str, kind: Kind) -> Option<&'static Category> {
    let base = basename(path_lower);

    // 1. Exact file names (pagefile.sys, hiberfil.sys ...). Cheap and exact.
    if kind == Kind::File {
        for c in all() {
            if c.name_any.iter().any(|n| base == n.as_str()) {
                return Some(c);
            }
        }
    }

    // 2. Path rules that outrank extensions (steamapps, system32, downloads).
    for c in all() {
        if !c.path_over_ext {
            continue;
        }
        if c.path_any.iter().any(|p| path_hit(path_lower, p)) {
            return Some(c);
        }
    }

    // 3. Directory rules: exact name, then name substring.
    if kind == Kind::Dir {
        for c in all() {
            if c.dir_any.iter().any(|d| base == d.as_str()) {
                return Some(c);
            }
        }
        for c in all() {
            if c.dir_has_any.iter().any(|d| base.contains(d.as_str())) {
                return Some(c);
            }
        }
    }

    // 4. Extension rules.
    if kind == Kind::File && !ext_lower.is_empty() {
        for c in all() {
            if c.ext_any.iter().any(|e| e == ext_lower) {
                return Some(c);
            }
        }
    }

    // 5. File-name substrings ("Setup.exe", "xxx-install").
    if kind == Kind::File {
        for c in all() {
            if c.name_has_any.iter().any(|n| base.contains(n.as_str())) {
                return Some(c);
            }
        }
    }

    // 6. Path rules that do not outrank extensions.
    for c in all() {
        if c.path_over_ext {
            continue;
        }
        if c.path_any.iter().any(|p| path_hit(path_lower, p)) {
            return Some(c);
        }
    }

    None
}

/// Per-category byte totals of one directory's direct children, keyed by id.
pub type Composition = HashMap<&'static str, u64>;

/// Pick the category that owns most of a directory's bytes.
///
/// Returns `None` when nothing reaches `DOMINANCE` — a folder that is 40%
/// video and 40% documents really is mixed, and colouring it as either would
/// be a lie. Callers render that as "mixed" rather than guessing.
pub fn compose(comp: &Composition, total: u64) -> Option<&'static Category> {
    if total == 0 {
        return None;
    }
    let (id, bytes) = comp.iter().max_by_key(|(_, b)| **b)?;
    if (*bytes as f64) / (total as f64) < DOMINANCE {
        return None;
    }
    // "other" dominating means we still do not know what this is; letting it
    // win would paint the folder grey, which is what we are fixing.
    if *id == "other" {
        return None;
    }
    by_id(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat(path: &str, ext: &str, kind: Kind) -> Option<&'static str> {
        classify(&path.to_lowercase(), ext, kind).map(|c| c.id.as_str())
    }

    #[test]
    fn steam_library_is_a_game_even_though_it_is_data_blocks() {
        assert_eq!(cat("d:\\steam\\steamapps\\common\\pubg\\x.pak", "pak", Kind::File), Some("game"));
        // The library root itself has no extension: the dir rule must catch it.
        assert_eq!(cat("d:\\steam", "", Kind::Dir), Some("game"));
    }

    /// A Steam library can live outside the default folder (E:\SteamLibrary),
    /// so matching only "\steam\steamapps" labels the whole library "other".
    #[test]
    fn a_steam_library_is_recognised_wherever_it_lives() {
        assert_eq!(
            cat("e:\\steamlibrary\\steamapps\\common\\space marine 2\\x.pak", "pak", Kind::File),
            Some("game")
        );
        assert_eq!(cat("e:\\steamlibrary\\steamapps", "", Kind::Dir), Some("game"));
    }

    /// Steam writes its own shadercache next to the games. It used to be caught
    /// by the browser rule (Chrome's ShaderCache) and reported as safe-to-delete
    /// browser cache, which is the wrong advice for 643 MB of game shaders.
    #[test]
    fn steam_shadercache_is_a_game_not_a_browser_cache() {
        assert_eq!(cat("e:\\steamlibrary\\steamapps\\shadercache", "", Kind::Dir), Some("game"));
        // A generic "cache" folder is no longer assumed to be a browser's.
        assert_ne!(cat("d:\\someapp\\cache", "", Kind::Dir), Some("browser"));
    }

    #[test]
    fn downloads_are_recognised_from_the_folder_name() {
        assert_eq!(cat("d:\\baidunetdiskdownload", "", Kind::Dir), Some("dl"));
        assert_eq!(cat("d:\\磁力链接下载", "", Kind::Dir), Some("dl"));
        assert_eq!(cat("c:\\users\\me\\downloads", "", Kind::Dir), Some("dl"));
    }

    #[test]
    fn system_path_outranks_the_dll_extension() {
        assert_eq!(cat("c:\\windows\\system32\\ntdll.dll", "dll", Kind::File), Some("system"));
        // ...but a dll copied to a normal folder is just a program file.
        assert_eq!(cat("d:\\tools\\helper.dll", "dll", Kind::File), Some("programs"));
    }

    #[test]
    fn media_and_archive_rules_still_work_by_extension() {
        assert_eq!(cat("d:\\x\\a.mkv", "mkv", Kind::File), Some("video"));
        assert_eq!(cat("d:\\x\\a.7z", "7z", Kind::File), Some("archive"));
        assert_eq!(cat("d:\\x\\a.PDF", "pdf", Kind::File), Some("doc"));
    }

    #[test]
    fn composition_labels_a_mostly_video_folder_as_video() {
        let mut comp = Composition::new();
        comp.insert("video", 900);
        comp.insert("doc", 100);
        assert_eq!(compose(&comp, 1000).map(|c| c.id.as_str()), Some("video"));
    }

    #[test]
    fn composition_refuses_to_guess_when_mixed() {
        let mut comp = Composition::new();
        comp.insert("video", 400);
        comp.insert("doc", 350);
        comp.insert("archive", 250);
        assert!(compose(&comp, 1000).is_none(), "40/35/25 是混合，不该硬贴标签");
    }

    /// Regression: the rule `\cache` used to match `\cache_pc` by plain
    /// substring, so a 52 GB game folder was labelled app cache.
    #[test]
    fn cache_rule_stops_at_a_folder_boundary() {
        assert_eq!(cat("d:\\adrive\\ghost of tsushima\\cache_pc\\psarc", "psarc", Kind::Dir), None);
        assert_eq!(cat("d:\\app\\cache", "", Kind::Dir), Some("cache"));
        assert_eq!(cat("d:\\app\\cachefiles\\x.dat", "dat", Kind::File), Some("data")); // .dat 是 data 扩展名，这里只验证 cachefiles 不触发 cache 规则
    }

    #[test]
    fn composition_does_not_let_other_win() {
        let mut comp = Composition::new();
        comp.insert("other", 900);
        comp.insert("doc", 100);
        assert!(compose(&comp, 1000).is_none());
    }

    #[test]
    fn every_rule_has_the_fields_the_ui_needs() {
        for c in all() {
            assert!(!c.zh.is_empty(), "{} 缺中文名", c.id);
            assert!(!c.en.is_empty(), "{} 缺英文名", c.id);
            assert!(
                ["safe", "confirm", "never"].contains(&c.verdict.as_str()),
                "{} 的 verdict 非法: {}",
                c.id,
                c.verdict
            );
            assert!(c.color.starts_with('#') && c.color.len() == 7, "{} 的颜色非法", c.id);
            assert!(!c.explain_zh.is_empty(), "{} 缺中文解释", c.id);
        }
    }
}
