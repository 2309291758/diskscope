//! Throwaway helper: classify a directory tree and print what each big folder
//! is. Used to sanity-check rules against a real disk.
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

fn gb(b: u64) -> f64 {
    b as f64 / 1024.0 / 1024.0 / 1024.0
}

fn show(node: &diskscope_lib::scan::Node, level: usize, max: usize) {
    if level > max {
        return;
    }
    for c in &node.children {
        println!(
            "{}{:<42} {:>7.1} GB  {:<12} {:.0}%",
            "  ".repeat(level),
            c.name.chars().take(40).collect::<String>(),
            gb(c.size),
            c.category,
            c.share * 100.0
        );
        if c.is_dir {
            show(c, level + 1, max);
        }
    }
}

fn main() {
    let root = std::env::args().nth(1).unwrap_or_else(|| "D:\\".into());
    let depth: usize = std::env::args().nth(2).and_then(|d| d.parse().ok()).unwrap_or(1);
    let tree = diskscope_lib::scan::scan(&root, Arc::new(AtomicBool::new(false)), |_| {}).unwrap();
    println!("root {} => {:.1} GB  [{} {:.0}%]", tree.node.path, gb(tree.node.size), tree.node.category, tree.node.share * 100.0);
    show(&tree.node, 0, depth);
    let comp = tree.node.composition();
    println!("\n-- composition of {} --", tree.node.path);
    for (id, b) in &comp {
        println!("  {:<14} {:>8.1} GB  {:.1}%", id, gb(*b), 100.0 * *b as f64 / tree.node.size as f64);
    }
}
