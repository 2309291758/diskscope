//! Diagnostic helper: scan a folder and print what the real classifier decided
//! for each direct child (category, share of bytes, size).
//!
//! cargo run --example diag -- "E:\"

use diskscope_lib::scan;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

fn gb(bytes: u64) -> String {
    let v = bytes as f64;
    const G: f64 = 1024.0 * 1024.0 * 1024.0;
    if v >= G {
        format!("{:8.2} GB", v / G)
    } else {
        format!("{:8.1} MB", v / (1024.0 * 1024.0))
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let root = args.get(1).cloned().unwrap_or_else(|| "D:\\".to_string());
    let depth: usize = args.get(2).and_then(|d| d.parse().ok()).unwrap_or(1);

    let tree = match scan::scan(&root, Arc::new(AtomicBool::new(false)), |_p| {}) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("scan failed: {}", e);
            std::process::exit(1);
        }
    };
    println!(
        "{} => {} bytes, cat={} share={:.1}%, {:?} elapsed",
        tree.node.path,
        gb(tree.node.size),
        tree.node.category,
        tree.node.share * 100.0,
        std::time::Duration::from_millis(tree.elapsed_ms)
    );
    walk(&tree.node, 1, depth);
}

fn walk(node: &scan::Node, level: usize, max: usize) {
    if level > max {
        return;
    }
    for child in &node.children {
        println!(
            "{:indent$}{:40} {:>10} cat={:14} share={:5.1}% n={}",
            "",
            truncate(&child.name, 40),
            gb(child.size),
            child.category,
            child.share * 100.0,
            child.children.len(),
            indent = (level - 1) * 2
        );
        if child.is_dir {
            walk(child, level + 1, max);
        }
    }
}

fn truncate(s: &str, n: usize) -> String {
    let mut out: String = s.chars().take(n).collect();
    if s.chars().count() > n {
        out.push('…');
    }
    out
}
