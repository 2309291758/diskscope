mod categories;
pub mod scan;

use scan::{Node, NodeView, ScanProgress, ScanSummary, Tree};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

/// App-wide state. One tree at a time: a user looks at one disk, not five.
pub struct AppState {
    tree: Mutex<Option<Tree>>,
    cancel: Mutex<Arc<AtomicBool>>,
    scanning: Arc<AtomicBool>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            tree: Mutex::new(None),
            cancel: Mutex::new(Arc::new(AtomicBool::new(false))),
            scanning: Arc::new(AtomicBool::new(false)),
        }
    }
}

fn to_view(node: &Node, parent_size: u64) -> NodeView {
    NodeView {
        name: node.name.clone(),
        path: node.path.clone(),
        is_dir: node.is_dir,
        size: node.size,
        mtime: node.mtime,
        ext: node.ext.clone(),
        category: node.category.clone(),
        share: node.share,
        child_count: node.children.len() as u64,
        files: node.files,
        dirs: node.dirs,
        has_children: node.is_dir && !node.children.is_empty(),
        percent: if parent_size > 0 {
            (node.size as f64 / parent_size as f64) * 100.0
        } else {
            0.0
        },
        unreadable: node.unreadable,
    }
}

#[tauri::command]
async fn scan_path(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<ScanSummary, String> {
    if state.scanning.swap(true, Ordering::SeqCst) {
        return Err("已有扫描在进行中".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *state.cancel.lock().unwrap() = cancel.clone();
    let emit_app = app.clone();
    let cancel_inner = cancel.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        scan::scan(&path, cancel_inner, move |p: ScanProgress| {
            let _ = emit_app.emit("scan-progress", p);
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    state.scanning.store(false, Ordering::SeqCst);

    match result {
        Ok(tree) => {
            let summary = tree.summary();
            *state.tree.lock().unwrap() = Some(tree);
            Ok(summary)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
fn cancel_scan(state: State<'_, AppState>) {
    state.cancel.lock().unwrap().store(true, Ordering::SeqCst);
}

#[tauri::command]
fn get_children(state: State<'_, AppState>, path: String) -> Result<Vec<NodeView>, String> {
    let guard = state.tree.lock().unwrap();
    let tree = guard.as_ref().ok_or("还没有扫描结果")?;
    let node = tree.node.find(&path).ok_or("找不到该路径")?;
    Ok(node.children.iter().map(|c| to_view(c, node.size)).collect())
}

/// One row of the tree table: a node plus how deep it sits below the node the
/// caller asked for. Pre-order, so the frontend can splice the block straight
/// into its flat row list.
#[derive(serde::Serialize)]
struct RowOut {
    depth: u32,
    node: NodeView,
}

#[derive(serde::Serialize)]
struct RowsOut {
    rows: Vec<RowOut>,
    /// True when the subtree was bigger than `max_rows` and got cut off.
    truncated: bool,
}

/// Rows for `path` and its descendants, `depth` levels down (0 = just this
/// node). One traversal for the whole block: expanding a big folder used to be
/// one IPC round-trip per child, and `find` walks the tree from the root every
/// time, so "expand to 3 levels" on a disk got quadratic.
#[tauri::command]
fn get_rows(
    state: State<'_, AppState>,
    path: String,
    depth: u32,
    max_rows: Option<usize>,
) -> Result<RowsOut, String> {
    let guard = state.tree.lock().unwrap();
    let tree = guard.as_ref().ok_or("还没有扫描结果")?;
    let node = tree.node.find(&path).ok_or("找不到该路径")?;
    let budget = max_rows.unwrap_or(20_000);
    let mut rows = Vec::new();
    let mut truncated = false;

    fn walk(n: &Node, parent_size: u64, depth_left: u32, d: u32, out: &mut Vec<RowOut>, budget: usize, truncated: &mut bool) {
        if out.len() >= budget {
            *truncated = true;
            return;
        }
        out.push(RowOut { depth: d, node: to_view(n, parent_size) });
        if depth_left == 0 || !n.is_dir {
            return;
        }
        for c in &n.children {
            walk(c, n.size, depth_left - 1, d + 1, out, budget, truncated);
            if *truncated {
                return;
            }
        }
    }

    // The parent's size is what the caller's percent should be relative to.
    let parent_size = match path.rfind('\\') {
        Some(i) if i > 2 => tree
            .node
            .find(&path[..i])
            .map(|p| p.size)
            .unwrap_or(node.size),
        _ => node.size,
    };
    walk(node, parent_size, depth, 0, &mut rows, budget, &mut truncated);
    Ok(RowsOut { rows, truncated })
}

#[tauri::command]
fn get_summary(state: State<'_, AppState>) -> Result<ScanSummary, String> {
    let guard = state.tree.lock().unwrap();
    let tree = guard.as_ref().ok_or("还没有扫描结果")?;
    Ok(tree.summary())
}

#[tauri::command]
fn get_biggest(state: State<'_, AppState>, limit: usize) -> Result<Vec<NodeView>, String> {
    let guard = state.tree.lock().unwrap();
    let tree = guard.as_ref().ok_or("还没有扫描结果")?;
    let root_size = tree.node.size;

    fn walk<'a>(node: &'a Node, limit: usize, out: &mut Vec<&'a Node>) {
        if !node.is_dir {
            if out.len() < limit {
                out.push(node);
                out.sort_by(|a, b| a.size.cmp(&b.size));
            } else if let Some(min) = out.first() {
                if node.size > min.size {
                    out[0] = node;
                    out.sort_by(|a, b| a.size.cmp(&b.size));
                }
            }
            return;
        }
        for c in &node.children {
            walk(c, limit, out);
        }
    }

    let mut out: Vec<&Node> = Vec::with_capacity(limit + 1);
    walk(&tree.node, limit, &mut out);
    out.sort_by(|a, b| b.size.cmp(&a.size));
    Ok(out.into_iter().map(|n| to_view(n, root_size)).collect())
}

#[derive(serde::Serialize)]
struct CatTotals {
    /// Size of the directory itself, so the UI can show honest percentages.
    total: u64,
    rows: Vec<(String, u64)>,
}

/// Category totals for one directory, so the side panel describes what the
/// user is actually looking at. `None` means "the scanned root".
#[tauri::command]
fn get_category_totals(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<CatTotals, String> {
    let guard = state.tree.lock().unwrap();
    let tree = guard.as_ref().ok_or("还没有扫描结果")?;
    let node = match path {
        Some(p) => tree.node.find(&p).ok_or("找不到该路径")?,
        None => &tree.node,
    };
    Ok(CatTotals {
        total: node.size,
        rows: node.composition(),
    })
}

#[tauri::command]
fn get_categories() -> Vec<categories::Category> {
    categories::all().clone()
}

#[tauri::command]
fn list_drives() -> Vec<(String, u64, u64)> {
    let mut out = Vec::new();
    for letter in b'C'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        let p = std::path::Path::new(&root);
        if p.exists() {
            #[cfg(windows)]
            {
                use std::ffi::OsStr;
                use std::os::windows::ffi::OsStrExt;
                #[link(name = "kernel32")]
                extern "system" {
                    fn GetDiskFreeSpaceExW(
                        dir: *const u16,
                        free_to_caller: *mut u64,
                        total: *mut u64,
                        free: *mut u64,
                    ) -> i32;
                }
                let wide: Vec<u16> = OsStr::new(&root).encode_wide().chain(std::iter::once(0)).collect();
                let (mut free_caller, mut total, mut free) = (0u64, 0u64, 0u64);
                let ok = unsafe {
                    GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_caller, &mut total, &mut free)
                };
                if ok != 0 && total > 0 {
                    out.push((root, total - free, total));
                }
            }
        }
    }
    out
}

#[derive(serde::Deserialize)]
struct AiConfig {
    endpoint: String,
    api_key: String,
    model: String,
}

#[derive(serde::Serialize)]
struct ExplainResult {
    text: String,
    model: String,
}

/// What we know about one item, assembled locally before anything leaves the
/// machine. Kept explicit so the privacy banner in the UI can list exactly
/// these fields.
fn describe(state: &State<'_, AppState>, path: &str) -> String {
    let guard = state.tree.lock().unwrap();
    let Some(tree) = guard.as_ref() else {
        return format!("路径: {}\n(还没有扫描结果，只有路径信息)", path);
    };
    let Some(node) = tree.node.find(path) else {
        return format!("路径: {}\n(这个路径不在本次扫描结果里)", path);
    };
    let mut s = format!(
        "路径: {}\n类型: {}\n大小: {:.1} MB\n最后修改: {} 天前\n本地分类猜测: {}{}",
        node.path,
        if node.is_dir { "文件夹" } else { "文件" },
        node.size as f64 / 1_048_576.0,
        (SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0).saturating_sub(node.mtime)) / 86400,
        categories::by_id(&node.category).map(|c| c.zh.as_str()).unwrap_or("未知"),
        if node.share > 0.0 && node.is_dir {
            format!("（目录里 {:.0}% 的字节属于该类）", node.share * 100.0)
        } else {
            String::new()
        }
    );
    if node.is_dir {
        let mut kids: Vec<&Node> = node.children.iter().filter(|c| c.size > 0).collect();
        kids.sort_by(|a, b| b.size.cmp(&a.size));
        let listed: Vec<String> = kids
            .iter()
            .take(12)
            .map(|c| format!("{} ({:.1} MB)", c.name, c.size as f64 / 1_048_576.0))
            .collect();
        s.push_str(&format!(
            "\n直接子项数量: {}\n最大的几个子项: {}",
            node.children.len(),
            if listed.is_empty() { "（空目录）".to_string() } else { listed.join(", ") }
        ));
        let comp: Vec<String> = node
            .composition()
            .iter()
            .filter(|(id, _)| id != "other")
            .take(5)
            .map(|(id, b)| {
                format!(
                    "{} {:.1} MB",
                    categories::by_id(id).map(|c| c.zh.as_str()).unwrap_or(id),
                    *b as f64 / 1_048_576.0
                )
            })
            .collect();
        if !comp.is_empty() {
            s.push_str(&format!("\n按内容分类: {}", comp.join(", ")));
        }
    }
    s
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())
}

/// A local model served by Ollama needs no key; every hosted API does.
fn check_cfg(cfg: &AiConfig) -> Result<(), String> {
    if cfg.endpoint.trim().is_empty() {
        return Err("还没有填写接口地址".into());
    }
    if cfg.api_key.trim().is_empty() && !is_local(&cfg.endpoint) {
        return Err("还没有填写 API Key".into());
    }
    Ok(())
}

fn is_local(endpoint: &str) -> bool {
    let e = endpoint.to_ascii_lowercase();
    e.contains("127.0.0.1") || e.contains("localhost") || e.contains("0.0.0.0")
}

/// Ask the provider which model ids it actually serves.
///
/// Presets in the UI are just a guess and model names get retired; this turns
/// "why is my model name rejected" into a list the user can pick from.
#[tauri::command]
async fn list_models(cfg: AiConfig) -> Result<Vec<String>, String> {
    check_cfg(&cfg)?;
    let url = format!("{}/models", cfg.endpoint.trim_end_matches('/'));
    let mut req = client()?.get(&url);
    if !cfg.api_key.trim().is_empty() {
        req = req.bearer_auth(cfg.api_key.trim());
    }
    let resp = req.send().await.map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text.chars().take(300).collect::<String>()));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))?;
    let mut out: Vec<String> = v["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if out.is_empty() {
        return Err("接口没有返回任何模型 id".into());
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
async fn explain_with_ai(
    state: State<'_, AppState>,
    path: String,
    cfg: AiConfig,
) -> Result<ExplainResult, String> {
    check_cfg(&cfg)?;
    let url = format!("{}/chat/completions", cfg.endpoint.trim_end_matches('/'));
    let facts = describe(&state, &path);
    let prompt = format!(
        "你是一个 Windows 磁盘清理助手。用户想知道下面这个条目是什么，以及删掉会有什么后果。\n下面全部是本地统计出来的事实，没有任何文件内容被上传。\n\n{}\n\n请用中文回答，严格按这个格式，不要多余的话:\n【这是什么】一到两句，说清它大概率是哪个软件/什么用途的东西\n【谁生成的】一句话\n【删了会怎样】一句话，说清会不会丢用户自己的数据\n【建议】可删 / 需确认 / 勿删，加一句理由\n\n不确定就直说不确定，不要编造。如果这是文件夹，注意「删了整个文件夹」比「删了里面的文件」后果更重。",
        facts
    );
    let body = serde_json::json!({
        "model": cfg.model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": "你只根据文件路径和元数据回答，不臆测文件内容。"},
            {"role": "user", "content": prompt}
        ]
    });
    let mut req = client()?.post(&url);
    if !cfg.api_key.trim().is_empty() {
        req = req.bearer_auth(cfg.api_key.trim());
    }
    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text.chars().take(400).collect::<String>()));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("响应里没有 content 字段")?
        .to_string();
    Ok(ExplainResult { text: content, model: cfg.model })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            scan_path,
            cancel_scan,
            get_children,
            get_rows,
            get_summary,
            get_biggest,
            get_category_totals,
            get_categories,
            list_drives,
            explain_with_ai,
            list_models
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
