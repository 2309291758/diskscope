//! Directory scanner.
//!
//! Semantics deliberately match Windows Explorer: every directory entry is
//! counted, including hard links (Explorer does the same), junctions and
//! symlinks are skipped so the same data cannot be counted twice, and
//! directories we are not allowed to read are recorded instead of silently
//! dropped. That last point matters: a cleanup tool that quietly under-reports
//! is worse than one that says "I could not look here".

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: u64,
    pub ext: String,
    /// Category id, decided in `finalize` once sizes are known.
    pub category: String,
    /// Share of this node's bytes owned by `category` (0.0–1.0). For a file
    /// it is 1.0; for a directory it says how homogeneous the folder is, which
    /// the UI shows as "77% 视频".
    pub share: f64,
    /// Files and folders *inside* this node, rolled up. A file counts itself
    /// as one file, so the tree table can show TreeSize-style counts on every
    /// row without walking the tree per row.
    pub files: u64,
    pub dirs: u64,
    #[serde(skip)]
    pub unreadable: bool,
    pub children: Vec<Node>,
}

impl Node {
    fn file(name: String, path: String, size: u64, mtime: u64, ext: String) -> Node {
        Node {
            name,
            path,
            is_dir: false,
            size,
            mtime,
            ext,
            category: "other".into(),
            share: 1.0,
            files: 1,
            dirs: 0,
            unreadable: false,
            children: Vec::new(),
        }
    }

    fn dir(name: String, path: String, mtime: u64) -> Node {
        Node {
            name,
            path,
            is_dir: true,
            size: 0,
            mtime,
            ext: String::new(),
            category: "other".into(),
            share: 0.0,
            files: 0,
            dirs: 0,
            unreadable: false,
            children: Vec::new(),
        }
    }

    /// Roll child sizes up, classify, and sort largest-first so the UI never
    /// has to.
    ///
    /// Classification happens here rather than during the walk because a
    /// directory's category depends on its children's sizes, which only exist
    /// after the children are done. Doing it bottom-up also means a folder
    /// inherits an already-classified child contribution instead of re-deriving
    /// it from individual files.
    ///
    /// `inherited` is the category of the nearest ancestor that matched an
    /// explicit `inherit` rule, if any.
    fn finalize(&mut self, inherited: Option<&'static str>) {
        if !self.is_dir {
            return;
        }
        // Resolve this folder's own rule first: children need to know whether
        // they inherit from it.
        let lower = self.path.to_lowercase();
        let hit = crate::categories::classify(&lower, "", crate::categories::Kind::Dir);
        let pass_down = match hit {
            Some(c) if c.inherit => Some(c.id.as_str()),
            Some(_) => None,
            None => inherited,
        };

        let mut total = 0u64;
        let mut files = 0u64;
        let mut dirs = 0u64;
        for child in self.children.iter_mut() {
            child.finalize(pass_down);
            total += child.size;
            files += child.files;
            dirs += child.dirs + u64::from(child.is_dir);
        }
        self.size = total;
        self.files = files;
        self.dirs = dirs;

        // Explicit rules win over the content picture: a Steam library full of
        // .vpk blobs is still "game", and Downloads stays "downloads" no matter
        // what was downloaded. Only unclassified folders get composed.
        match hit {
            Some(c) => {
                self.category = c.id.clone();
                // `share` answers "how much of this folder's bytes actually
                // agreed with the label". A folder matched on its name alone
                // (Overwatch: 83 GB of extensionless data blocks) honestly gets
                // 0.0, and the UI says "按名称判定" instead of inventing 100%.
                let mut own = 0u64;
                for child in &self.children {
                    if child.category == c.id {
                        own += child.size;
                    }
                }
                self.share = if total > 0 { own as f64 / total as f64 } else { 0.0 };
            }
            None => {
                let mut comp: crate::categories::Composition = Default::default();
                for child in &self.children {
                    if child.size == 0 {
                        continue;
                    }
                    let entry = comp.entry(crate::categories::id_ref(&child.category)).or_insert(0);
                    *entry += child.size;
                }
                // An inherited parent claims what nothing else could explain,
                // *before* composition runs: a subfolder inside D:\Overwatch\data
                // is part of the game even though its files have no extension.
                // Only categories that opt in via `inherit` do this, so an
                // unknown blob inside a cache folder is never called safe.
                if let Some(parent) = inherited {
                    let unexplained = comp.remove("other").unwrap_or(0);
                    *comp.entry(parent).or_insert(0) += unexplained;
                }
                match crate::categories::compose(&comp, total) {
                    Some(c) => {
                        // A "weak" label says what the bytes *are* (program
                        // data blocks), not who owns them. Inside a container
                        // we do know -- a game, an install -- the container is
                        // the thing the user can act on ("uninstall the game",
                        // not "delete 40 GB of .pak"), so it wins. This is the
                        // fix for a Steam library's asset folders reporting as
                        // program data instead of part of the game.
                        let winner = match inherited {
                            Some(parent) => match (crate::categories::by_id(parent), c.weak) {
                                (Some(p), true) if !p.weak => p,
                                _ => c,
                            },
                            None => c,
                        };
                        let mut own = comp.get(winner.id.as_str()).copied().unwrap_or(0);
                        if winner.id != c.id {
                            // The overridden weak bytes still belong to the
                            // container, so they count towards its share.
                            own += comp.get(c.id.as_str()).copied().unwrap_or(0);
                        }
                        self.category = winner.id.clone();
                        self.share = if total > 0 { own as f64 / total as f64 } else { 0.0 };
                    }
                    None => {
                        // Nothing owns most of this folder's bytes. If it
                        // holds an executable at its top level it is still a
                        // program install (portable apps, tool folders),
                        // which is worth more than "other".
                        self.category = if self.has_direct_exe() { "programs" } else { "other" }.into();
                        self.share = 0.0;
                    }
                }
            }
        }

        self.children.sort_unstable_by(|a, b| b.size.cmp(&a.size));
    }

    pub fn find(&self, path: &str) -> Option<&Node> {
        if self.path == path {
            return Some(self);
        }
        if !self.is_dir || !path.starts_with(&self.path) {
            return None;
        }
        for child in &self.children {
            if let Some(found) = child.find(path) {
                return Some(found);
            }
        }
        None
    }

    pub fn count(&self) -> u64 {
        if !self.is_dir {
            return 1;
        }
        1 + self.children.iter().map(|c| c.count()).sum::<u64>()
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct ScanSummary {
    pub root: String,
    pub total_bytes: u64,
    pub total_files: u64,
    pub total_dirs: u64,
    pub unreadable_dirs: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ScanProgress {
    pub files: u64,
    pub bytes: u64,
    pub current: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct NodeView {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: u64,
    pub ext: String,
    pub category: String,
    pub share: f64,
    pub child_count: u64,
    pub files: u64,
    pub dirs: u64,
    pub has_children: bool,
    pub percent: f64,
    pub unreadable: bool,
}

#[derive(Debug, Default)]
pub struct Counters {
    pub files: AtomicU64,
    pub dirs: AtomicU64,
    pub unreadable: AtomicU64,
}

pub struct Tree {
    pub node: Node,
    pub counters: Counters,
    pub elapsed_ms: u64,
}

impl Node {
    /// Is this folder itself an application install?
    ///
    /// Portable apps and tool folders often mix `.dll`, `.dat`, `.pak` and
    /// loose assets, so no single category dominates and composition gives up.
    /// A top-level `.exe` is a strong enough signal to call it "programs"
    /// rather than letting it fall into "other".
    fn has_direct_exe(&self) -> bool {
        self.children.iter().any(|c| !c.is_dir && c.ext == "exe" && c.size > 0)
    }

    /// Byte totals per category for this node's *direct* children.
    ///
    /// The side panel used to total the whole tree, which is useless when you
    /// are standing in one folder: it shows "this disk is 30% video" while you
    /// are looking at a Games folder. Totals are per-directory.
    pub fn composition(&self) -> Vec<(String, u64)> {
        let mut acc: std::collections::HashMap<&'static str, u64> = Default::default();
        for c in &self.children {
            if c.size == 0 {
                continue;
            }
            *acc.entry(crate::categories::id_ref(&c.category)).or_insert(0) += c.size;
        }
        let mut v: Vec<(String, u64)> = acc.into_iter().map(|(k, b)| (k.to_string(), b)).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1));
        v
    }
}

impl Tree {
    pub fn summary(&self) -> ScanSummary {
        let mut dirs = 0u64;
        self.node.count_dirs(&mut dirs);
        ScanSummary {
            root: self.node.path.clone(),
            total_bytes: self.node.size,
            total_files: self.counters.files.load(Ordering::Relaxed),
            total_dirs: dirs,
            unreadable_dirs: self.counters.unreadable.load(Ordering::Relaxed),
            elapsed_ms: self.elapsed_ms,
        }
    }
}

impl Node {
    fn count_dirs(&self, acc: &mut u64) {
        if self.is_dir {
            *acc += 1;
        }
        for c in &self.children {
            c.count_dirs(acc);
        }
    }
}

fn mtime_of(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn is_reparse(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

/// A drive root is not a *kind of content* — it is the container itself.
///
/// Every other directory gets its category inferred from the bytes inside it
/// when no rule matches, which is right for a folder but wrong for `E:\`:
/// it produced "E: 是游戏文件 55.7%", a sentence with no meaning. The root is
/// labelled by position instead, and the UI explains it rather than guessing.
fn is_drive_root(p: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::Component;
        let mut parts = p.components();
        matches!(
            (parts.next(), parts.next(), parts.next()),
            (Some(Component::Prefix(_)), Some(Component::RootDir), None)
        )
    }
    #[cfg(not(windows))]
    {
        p.parent().is_none()
    }
}

/// Windows needs the \\?\ prefix to address paths longer than MAX_PATH.
pub fn long_path(p: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if s.starts_with("\\\\?\\") || s.starts_with("\\\\.\\") {
            return p.to_path_buf();
        }
        if s.len() >= 240 {
            let abs = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
            let s = abs.to_string_lossy().replace('/', "\\");
            return PathBuf::from(format!("\\\\?\\{}", s.trim_start_matches("\\\\?\\")));
        }
    }
    p.to_path_buf()
}

fn ext_of(name: &str) -> String {
    match name.rsplit_once('.') {
        // ".gitignore" is a basename, not an extension.
        Some((stem, e)) if !stem.is_empty() && !e.is_empty() && e.len() <= 12 => {
            e.to_ascii_lowercase()
        }
        _ => String::new(),
    }
}

fn scan_dir(dir: &Path, depth: u32, ctx: &Ctx) -> Node {
    let meta = match std::fs::symlink_metadata(dir) {
        Ok(m) => m,
        Err(_) => {
            ctx.counters.unreadable.fetch_add(1, Ordering::Relaxed);
            let mut n = Node::dir(
                dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| dir.display().to_string()),
                dir.display().to_string(),
                0,
            );
            n.unreadable = true;
            return n;
        }
    };

    let mut node = Node::dir(
        dir.file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| dir.display().to_string()),
        dir.display().to_string(),
        mtime_of(&meta),
    );

    let reader = match std::fs::read_dir(long_path(dir)) {
        Ok(r) => r,
        Err(_) => {
            ctx.counters.unreadable.fetch_add(1, Ordering::Relaxed);
            node.unreadable = true;
            return node;
        }
    };

    let mut files: Vec<Node> = Vec::new();
    let mut subdirs: Vec<PathBuf> = Vec::new();

    for entry in reader.flatten() {
        if ctx.cancel.load(Ordering::Relaxed) {
            break;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let md = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if is_reparse(&md) {
            // Junctions and symlinks are skipped: following them inflates totals
            // and on Windows can loop.
            continue;
        }
        if md.is_dir() {
            subdirs.push(path);
        } else {
            if ctx.should_report() {
                ctx.report(path.to_string_lossy().to_string());
            }
            let size = md.len();
            ctx.counters.files.fetch_add(1, Ordering::Relaxed);
            ctx.bytes.fetch_add(size, Ordering::Relaxed);
            let ext = ext_of(&name);
            let full = path.display().to_string();
            let mut node = Node::file(name, full, size, mtime_of(&md), ext);
            // Files can be classified immediately: extension, basename and the
            // full path are all known here, and a file has no children to
            // derive a composition from.
            let lower = node.path.to_lowercase();
            if let Some(c) = crate::categories::classify(
                &lower,
                &node.ext,
                crate::categories::Kind::File,
            ) {
                node.category = c.id.clone();
            }
            files.push(node);
        }
    }

    let children: Vec<Node> = subdirs
        .par_iter()
        .map(|p| {
            ctx.counters.dirs.fetch_add(1, Ordering::Relaxed);
            if ctx.should_report() {
                ctx.report(p.to_string_lossy().to_string());
            }
            scan_dir(p, depth + 1, ctx)
        })
        .collect();

    node.children = files;
    node.children.extend(children);
    node
}

struct Ctx {
    counters: Counters,
    bytes: AtomicU64,
    cancel: Arc<AtomicBool>,
    last_report: Mutex<Instant>,
    progress: Box<dyn Fn(ScanProgress) + Send + Sync>,
}

impl Ctx {
    fn should_report(&self) -> bool {
        let mut last = self.last_report.lock().unwrap();
        if last.elapsed() >= Duration::from_millis(200) {
            *last = Instant::now();
            true
        } else {
            false
        }
    }

    fn report(&self, current: String) {
        (self.progress)(ScanProgress {
            files: self.counters.files.load(Ordering::Relaxed),
            bytes: self.bytes.load(Ordering::Relaxed),
            current,
        });
    }
}

pub fn scan<F>(root: &str, cancel: Arc<AtomicBool>, progress: F) -> Result<Tree, String>
where
    F: Fn(ScanProgress) + Send + Sync + 'static,
{
    let path = PathBuf::from(root);
    if !path.exists() {
        return Err(format!("路径不存在: {}", root));
    }
    let started = Instant::now();
    let ctx = Ctx {
        counters: Counters::default(),
        bytes: AtomicU64::new(0),
        cancel,
        last_report: Mutex::new(Instant::now() - Duration::from_secs(1)),
        progress: Box::new(progress),
    };
    let mut node = scan_dir(&path, 0, &ctx);
    node.finalize(None);
    if is_drive_root(&path) {
        node.category = "root".into();
        // Not a share of anything: the root is all of it. The UI skips the
        // "N% 的字节属于这一类" suffix for this one category.
        node.share = 1.0;
    }
    Ok(Tree {
        node,
        counters: ctx.counters,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `std::env::temp_dir` is not reliably writable (sandboxed machines deny
    /// it), so tests build their fixtures inside the crate's own target dir.
    fn tmp(name: &str) -> PathBuf {
        let d = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("test-tmp").join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn totals_match_file_sizes() {
        let d = tmp("diskscope_test_totals");
        std::fs::create_dir_all(d.join("a/b")).unwrap();
        std::fs::write(d.join("a/x.bin"), vec![0u8; 1000]).unwrap();
        std::fs::write(d.join("a/b/y.bin"), vec![0u8; 2000]).unwrap();
        std::fs::write(d.join("top.txt"), vec![0u8; 500]).unwrap();

        let tree = scan(d.to_str().unwrap(), Arc::new(AtomicBool::new(false)), |_| {}).unwrap();
        assert_eq!(tree.node.size, 3500, "根目录应等于所有文件之和");
        assert_eq!(tree.counters.files.load(Ordering::Relaxed), 3);

        let a = tree
            .node
            .find(&d.join("a").display().to_string())
            .expect("应该能找到 a 目录");
        assert_eq!(a.size, 3000);
        assert_eq!(a.children[0].size, 2000, "子目录应排在前面（最大优先）");

        // Rolled-up counts: the tree table shows them per row, so they must
        // never disagree with the tree itself.
        assert_eq!(a.files, 2);
        assert_eq!(a.dirs, 1, "a 里只有 b 一个子目录");
        assert_eq!(tree.node.files, 3);
        assert_eq!(tree.node.dirs, 2, "a 和 a/b");

        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_path_is_an_error() {
        let r = scan(
            "Z:\\definitely\\not\\here",
            Arc::new(AtomicBool::new(false)),
            |_| {},
        );
        assert!(r.is_err());
    }

    /// A game's asset folder is all extensionless data blocks. Both "this is
    /// program data" and "this belongs to the game" are true; the container
    /// must win, otherwise every Steam library reads as 程序数据.
    #[test]
    fn a_game_container_claims_the_data_blocks_inside_it() {
        let mut data = Node::dir("data".into(), "d:\\overwatch\\data".into(), 0);
        let mut blob = Node::file("0000000a.dat".into(), "d:\\overwatch\\data\\0000000a.dat".into(), 900, 0, "dat".into());
        blob.category = "data".into();
        data.children.push(blob);

        // Without a container the weak label stands: we genuinely do not know
        // who owns these bytes.
        let mut alone = data.clone();
        alone.finalize(None);
        assert_eq!(alone.category, "data");

        // Inside a game, the game owns them.
        let mut inside = data.clone();
        inside.finalize(Some("game"));
        assert_eq!(inside.category, "game");
        assert!((inside.share - 1.0).abs() < 1e-9, "被接管的字节也算进 share");
    }

    /// `E:\` is a container, not a kind of content. Inferring from the bytes
    /// inside produced "E: 是游戏文件 55.7%", which reads like a claim about the
    /// drive. Only a true drive root gets relabelled; a folder that merely sits
    /// at the top of a scan keeps its inferred category.
    #[test]
    fn a_drive_root_is_not_typed_by_its_contents() {
        assert!(is_drive_root(Path::new("E:\\")));
        assert!(is_drive_root(Path::new("E:/")));
        assert!(!is_drive_root(Path::new("E:\\SteamLibrary")));
        assert!(!is_drive_root(Path::new("D:\\dsh\\diskscope")));

        let d = tmp("diskscope_test_root");
        std::fs::create_dir_all(d.join("SteamLibrary")).unwrap();
        std::fs::write(d.join("SteamLibrary/game.exe"), vec![0u8; 4000]).unwrap();

        // A plain directory is still classified by what is inside it.
        let tree = scan(d.to_str().unwrap(), Arc::new(AtomicBool::new(false)), |_| {}).unwrap();
        assert_ne!(tree.node.category, "root", "普通目录不该被判成磁盘根目录");

        // The relabel is positional, so it can be checked without owning a drive.
        let mut fake_root = tree.node.clone();
        fake_root.category = "root".into();
        fake_root.share = 1.0;
        // `SteamLibrary` hits the name rule, so the child keeps its own label.
        assert_eq!(fake_root.children[0].category, "game", "子项照旧各自分类");
        assert_ne!(fake_root.children[0].category, "root", "子项不会被父级传染");

        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn extension_is_lowercased() {
        assert_eq!(ext_of("Movie.MKV"), "mkv");
        assert_eq!(ext_of("noext"), "");
        assert_eq!(ext_of(".gitignore"), "");
    }
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
