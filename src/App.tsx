import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, fmtAge, fmtBytes, fmtBytesAuto, fmtDate, pickDirectory, setUnit, type AiCfg, type Unit } from "./api";
import type { CatTotals, Category, Row, ScanProgress, ScanSummary, SortKey } from "./types";
import Composition from "./Composition";
import Dropdown from "./Dropdown";
import { isLocalEndpoint, PROVIDERS, providerOf } from "./providers";
import Treemap from "./Treemap";
import TreeTable from "./TreeTable";

// Starts on a provider preset rather than a blank form: the common case is a
// DeepSeek key and no idea what the base URL is.
const DEFAULT_CFG: AiCfg = {
  provider: PROVIDERS[0].id,
  endpoint: PROVIDERS[0].endpoint,
  api_key: "",
  model: PROVIDERS[0].models[0]
};

const VERDICT: Record<string, { label: string; color: string }> = {
  safe: { label: "通常可删", color: "#0d7e40" },
  confirm: { label: "需确认", color: "#a06513" },
  never: { label: "不要删", color: "#ba2b2e" }
};

const SORTS: SortKey[] = ["size", "name", "mtime", "category"];

/** A drive root has no file name, so `name` falls back to the path and the
 *  sidebar prints "E:\" twice — once big, once small. Give it a real short
 *  name and let the path line carry the rest. */
function displayName(node: { name: string; path: string; is_dir: boolean }): string {
  if (node.name && node.name !== node.path) return node.name;
  const drive = /^([A-Za-z]):\\?$/.exec(node.path);
  if (drive) return drive[1].toUpperCase() + ": 盘";
  const trimmed = node.path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts.pop() || node.path;
}

/** Split a pre-order block into one array per direct child subtree. */
function childBlocks(rows: Row[], parentDepth: number): Row[][] {
  const out: Row[][] = [];
  let cur: Row[] | null = null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.depth === parentDepth + 1) {
      cur = [r];
      out.push(cur);
    } else if (cur) {
      cur.push(r);
    }
  }
  return out;
}

/** A pile of small files is worth exactly one row, not two hundred. */
const MIN_GROUP = 4;
const GROUP_SHARE = 0.004;
const GROUP_MAX_SHARE = 0.12;

/**
 * Fold the trailing run of small files into one row, TreeSize style.
 * Rules, in order:
 *  - only plain files, never folders — a folder is something the user opens;
 *  - only files under 0.4% of the parent, and only a contiguous run at the
 *    end, so whatever is above them keeps its place and its size;
 *  - at least 4 of them, and the pile may not exceed 12% of the parent —
 *    a group that big is a finding, not clutter.
 * Applied to the size-ordered list Rust returns, so the pile is always at the
 * bottom; sorting by name afterwards moves it like any other row.
 * Pure and free of I/O, so it stays cheap on a 20k-row block.
 */
function groupSiblings(rows: Row[], open: Set<string>): Row[] {
  if (rows.length < MIN_GROUP + 1) return rows;
  const parent = rows[0];
  // Fold at every expanded level, not just the top one.
  const blocks = childBlocks(rows, parent.depth).map((b) => (b[0].node.is_dir ? groupSiblings(b, open) : b));
  // A row with children but no depth+1 rows below it means the depth ladder is
  // broken. Hand the block back untouched rather than returning the parent
  // alone — dropping rows is the one failure mode the user cannot diagnose.
  if (!blocks.length) return rows;

  const smalls: Row[] = [];
  let bytes = 0;
  let cut = blocks.length;
  const cap = parent.node.size * GROUP_MAX_SHARE;
  while (cut > 0) {
    const b = blocks[cut - 1];
    const r = b[0];
    const small = b.length === 1 && !r.node.is_dir && r.node.percent < GROUP_SHARE * 100;
    if (!small || bytes + r.node.size > cap) break;
    smalls.unshift(r);
    bytes += r.node.size;
    cut--;
  }
  // Nothing to fold here — but the recursion above may still have folded
  // inside the child blocks, so hand those back rather than the original rows.
  if (smalls.length < MIN_GROUP) return [parent, ...blocks.flat()];

  const key = parent.node.path + "\\*";
  const isOpen = open.has(key);
  const group: Row = {
    depth: parent.depth + 1,
    group: {
      open: isOpen,
      members: isOpen ? smalls.map((r) => ({ ...r, depth: parent.depth + 2 })) : []
    },
    node: {
      ...parent.node,
      name: smalls.length + " 个小文件",
      path: key,
      is_dir: true,
      size: bytes,
      mtime: Math.max(...smalls.map((r) => r.node.mtime)),
      category: "other",
      ext: "",
      share: 0,
      child_count: smalls.length,
      files: smalls.length,
      dirs: 0,
      has_children: true,
      percent: parent.node.size > 0 ? (bytes / parent.node.size) * 100 : 0,
      unreadable: false
    }
  };

  const kept = blocks.slice(0, cut).flat();
  return [parent, ...kept, group, ...(group.group?.members ?? [])];
}


/** Children come back size-sorted from Rust; other keys re-sort each sibling
 *  group in place, keeping every subtree underneath its own parent. */
function sortSiblings(rows: Row[], key: SortKey): Row[] {
  if (key === "size" || rows.length === 0) return rows;
  const cmp = (a: Row, b: Row) => {
    if (key === "name") return (a.node.name || a.node.path).localeCompare(b.node.name || b.node.path, "zh");
    if (key === "mtime") return b.node.mtime - a.node.mtime;
    return a.node.category.localeCompare(b.node.category) || b.node.size - a.node.size;
  };
  const kids = childBlocks(rows, rows[0].depth)
    .map((b) => sortSiblings(b, key))
    .sort((a, b) => cmp(a[0], b[0]));
  // Same guard as groupSiblings: no child blocks means the ladder is broken,
  // and silently returning only the parent would delete the user's rows.
  if (!kids.length) return rows;
  return [rows[0], ...kids.flat()];
}

export default function App() {
  const [drives, setDrives] = useState<[string, number, number][]>([]);
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [root, setRoot] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Groups the user opened. Folded back automatically by collapseAll. */
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Row | null>(null);
  /** AI answer belongs to one path; selecting another row must not keep showing it. */
  const [aiPath, setAiPath] = useState("");
  /** True while the user asked to see the metadata again under an answer. */
  const [metaOpen, setMetaOpen] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  /** Category bytes for the folder the strip at the bottom is describing. */
  const [compoPath, setCompoPath] = useState("");
  const [catTotals, setCatTotals] = useState<CatTotals | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("size");
  const [view, setView] = useState<"tree" | "blocks">("tree");
  const [blockPath, setBlockPath] = useState("");
  const [blockKids, setBlockKids] = useState<Row[]>([]);
  const [sideOpen, setSideOpen] = useState(true);
  const [unit, setUnitKey] = useState<Unit>("auto");
  const [truncated, setTruncated] = useState(false);
  /** Folders whose child block is being fetched right now. */
  const inflight = useRef<Set<string>>(new Set());

  const [aiOpen, setAiOpen] = useState(false);
  const [cfg, setCfg] = useState<AiCfg>(() => {
    try {
      // Configs saved before presets existed have no provider id; deriving it
      // from the endpoint keeps the dropdown from claiming DeepSeek while the
      // address next to it says 127.0.0.1.
      const saved = JSON.parse(localStorage.getItem("diskscope.ai") || "{}") as Partial<AiCfg>;
      const merged = { ...DEFAULT_CFG, ...saved };
      return { ...merged, provider: providerOf(merged).id };
    } catch {
      return DEFAULT_CFG;
    }
  });
  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState("");
  /** Models on offer: the preset's guesses at first, then whatever the endpoint reports. */
  const [modelList, setModelList] = useState<string[]>(() => providerOf(cfg).models);
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeErr, setProbeErr] = useState("");
  /** Last key we already asked the endpoint about, so blur does not re-request. */
  const probedKey = useRef("");

  const catMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  useEffect(() => {
    api.categories().then(setCategories).catch(() => {});
    api.drives().then(setDrives).catch(() => {});
    const un = listen<ScanProgress>("scan-progress", (e) => setProgress(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Esc closes the AI modal — the backdrop click alone is not discoverable.
  useEffect(() => {
    if (!aiOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAiOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aiOpen]);

  // The treemap is a drill-down view with its own path, independent of the tree.
  useEffect(() => {
    if (view !== "blocks" || !root) return;
    let dead = false;
    api
      .rows(blockPath || root, 1)
      .then((r) => {
        if (!dead) setBlockKids(r.rows.slice(1));
      })
      .catch((e) => !dead && setError(String(e)));
    return () => {
      dead = true;
    };
  }, [view, blockPath, root]);

  // The strip describes one folder, not the whole scan: standing in Games and
  // being told "30% of this disk is video" is noise. Fetching in an effect (not
  // inside select) means clicking down a tree of rows issues one request for the
  // folder the user actually stopped on.
  useEffect(() => {
    if (!compoPath) return;
    let dead = false;
    api
      .categoryTotals(compoPath)
      .then((v) => !dead && setCatTotals(v))
      .catch(() => !dead && setCatTotals(null));
    return () => {
      dead = true;
    };
  }, [compoPath]);

  /** Load root + first `depth` levels as one flat, pre-order row list. */
  const loadTree = useCallback(async (target: string, depth = 1) => {
    const r = await api.rows(target, depth);
    setRoot(target);
    setRows(r.rows);
    setTruncated(r.truncated);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const row of r.rows) if (row.node.has_children && row.depth < depth) next.add(row.node.path);
      return next;
    });
    select(r.rows[0] ?? null);
  }, []);

  const startScan = useCallback(
    async (target: string) => {
      setBusy(true);
      setError("");
      setAiText("");
      setProgress(null);
      setRows([]);
      setExpanded(new Set());
      setOpenGroups(new Set());
      setBlockPath("");
      setCompoPath("");
      setCatTotals(null);
      try {
        const s = await api.scan(target);
        setSummary(s);
        // Open on the root's direct children only — the first screen should be
        // a summary, not a pre-expanded tree the user has to collapse.
        await loadTree(s.root, 1);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [loadTree]
  );

  /** Expanding: fetch the child block and splice it under the row. */
  const toggle = useCallback(
    async (row: Row) => {
      const p = row.node.path;
      // Collapse is instant, so a rapid second click arrives before the first
      // expand's IPC call returns: it would see a still-closed folder, fire a
      // second fetch, and splice the same children twice. One at a time.
      if (inflight.current.has(p)) return;
      if (expanded.has(p)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(p);
          for (const q of prev) if (q.startsWith(p + "\\")) next.delete(q);
          return next;
        });
        setRows((prev) => {
          const i = prev.findIndex((r) => r.node.path === p);
          if (i < 0) return prev;
          let j = i + 1;
          while (j < prev.length && prev[j].depth > row.depth) j++;
          return [...prev.slice(0, i + 1), ...prev.slice(j)];
        });
        return;
      }
      inflight.current.add(p);
      try {
        const r = await api.rows(p, 1);
        // The block starts with the row itself; drop it, we already have it.
        // The block's own root is depth 0 and its children depth 1, so the
        // offset is exactly row.depth. Adding 1 more here used to leave a gap
        // in the depth ladder; groupSiblings walks by depth+1, found nothing in
        // the gap, and returned the parent alone — the whole expanded subtree
        // vanished and the level above looked collapsed.
        const kids = r.rows.slice(1).map((x) => ({ depth: row.depth + x.depth, node: x.node }));
        if (r.truncated) setTruncated(true);
        setExpanded((prev) => new Set(prev).add(p));
        setRows((prev) => {
          const i = prev.findIndex((x) => x.node.path === p);
          if (i < 0) return prev;
          let j = i + 1;
          while (j < prev.length && prev[j].depth > row.depth) j++;
          // Two expands of the same folder can be in flight at once (a fast
          // double-click lands before the first IPC call returns). The second
          // one must not splice a duplicate subtree — duplicate keys made rows
          // vanish and reappear under the cursor.
          if (j > i + 1) return prev;
          return [...prev.slice(0, i + 1), ...kids, ...prev.slice(j)];
        });
      } catch (e) {
        setError(String(e));
      } finally {
        inflight.current.delete(p);
      }
    },
    [expanded]
  );

  const expandAll = useCallback(async () => {
    if (!root) return;
    try {
      const r = await api.rows(root, 3);
      setRows(r.rows);
      setTruncated(r.truncated);
      setExpanded(new Set(r.rows.filter((x) => x.node.has_children && x.depth < 3).map((x) => x.node.path)));
    } catch (e) {
      setError(String(e));
    }
  }, [root]);

  const collapseAll = useCallback(async () => {
    if (!root) return;
    setExpanded(new Set());
    setOpenGroups(new Set());
    await loadTree(root, 1);
  }, [root, loadTree]);

  const grouped = useMemo(() => groupSiblings(rows, openGroups), [rows, openGroups]);
  const sorted = useMemo(() => sortSiblings(grouped, sortKey), [grouped, sortKey]);

  const toggleGroup = useCallback((row: Row) => {
    const key = row.node.path;
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // The header entry has no row attached: it opens the same dialog so the
  // endpoint/model/key can be set before any file is selected.
  function openAiSettings() {
    setAiErr("");
    setProbeErr("");
    setAiOpen(true);
  }

  function select(row: Row | null) {
    setSelected(row);
    // The strip describes a folder. A file has no composition of its own, and
    // the synthetic "small files" row has a path that does not exist on disk,
    // so both leave the last real folder in place instead of blanking it.
    if (row?.node.is_dir && !row.group) setCompoPath(row.node.path);
    // A stale answer under a different name reads as if it were about this row.
    if ((row?.node.path ?? "") !== aiPath) {
      setAiPath("");
      setAiText("");
      setAiErr("");
      setMetaOpen(false);
    }
  }

  // The answer belongs in the sidebar, next to the row it is about: a modal
  // would cover the tree the user is reading it against.
  async function explain(row: Row) {
    setAiPath(row.node.path);
    setMetaOpen(false);
    setAiText("");
    setAiErr("");
    if (!keyOk) return;
    setAiBusy(true);
    try {
      const r = await api.explain(row.node.path, cfg);
      setAiText(r.text);
    } catch (e) {
      setAiErr(String(e));
    } finally {
      setAiBusy(false);
    }
  }

  function saveCfg(next: AiCfg) {
    setCfg(next);
    localStorage.setItem("diskscope.ai", JSON.stringify(next));
  }

  const provider = providerOf(cfg);

  function pickProvider(id: string) {
    const p = PROVIDERS.find((x) => x.id === id) ?? PROVIDERS[PROVIDERS.length - 1];
    setProbeErr("");
    // The preset's model guesses go straight into the list: the user should see
    // a picker, not an empty box, before a key has ever been entered.
    setModelList(p.models);
    // A preset fills both technical fields; "自定义" leaves them as they are so
    // switching to it does not wipe an address that is already typed in.
    if (!p.endpoint) {
      saveCfg({ ...cfg, provider: p.id });
      return;
    }
    saveCfg({ ...cfg, provider: p.id, endpoint: p.endpoint, model: p.models[0] ?? "" });
  }

  // Model names get retired and presets are only a guess, so ask the provider
  // what it actually serves rather than making the user rediscover it by error.
  async function probeModels(c: AiCfg) {
    setProbeBusy(true);
    setProbeErr("");
    try {
      const list = await api.listModels(c);
      probedKey.current = c.api_key.trim();
      setModelList(list);
      if (!list.includes(c.model)) saveCfg({ ...c, model: list[0] });
    } catch (e) {
      setProbeErr(String(e));
    } finally {
      setProbeBusy(false);
    }
  }

  // Paste a key, click away, models appear. One less button to find than
  // "现在点检测" — but only once per key, so tabbing through does not spam the API.
  function autoProbe() {
    if (isLocalEndpoint(cfg.endpoint)) return;
    const k = cfg.api_key.trim();
    if (!k || k === probedKey.current) return;
    void probeModels(cfg);
  }

  const keyOk = isLocalEndpoint(cfg.endpoint) || !!cfg.api_key.trim();

  // One button instead of two: it shows what a click will do next, then does it.
  // The root always counts as expanded after a scan (that is what a scan shows),
  // so only deeper folders or opened piles make the tree "open".
  const treeOpen = openGroups.size > 0 || [...expanded].some((p) => p !== root);
  const toggleAll = useCallback(async () => {
    if (treeOpen) await collapseAll();
    else await expandAll();
  }, [treeOpen, collapseAll, expandAll]);

  const pick = useCallback(async () => {
    const d = await pickDirectory();
    if (d) await startScan(d);
  }, [startScan]);

  // The hints describe what the ladder actually does, not a promise of one
  // unit everywhere: forcing "471.2 GB" to print as 494,000,000 KB would be
  // literally correct and impossible to read, so each mode only pushes the
  // small end of the scale down.
  const UNITS: { value: Unit; label: string; hint: string }[] = [
    { value: "auto", label: "自动", hint: "按大小自适应" },
    { value: "gb", label: "GB", hint: "1 MB 以下显示 KB" },
    { value: "mb", label: "MB", hint: "1 KB 以下显示字节" },
    { value: "kb", label: "KB", hint: "1 GB 以下显示 KB" }
  ];

  const selNode = selected?.node ?? null;
  // An answer for another row (or a stale one) must not suppress the metadata.
  const aiMine = !!selNode && aiPath === selNode.path && !selected?.group;
  const showMeta = !aiMine || metaOpen;
  const selCat = selNode ? catMap.get(selNode.category) : undefined;
  const selVerdict = selCat && !selected?.group ? VERDICT[selCat.verdict] : undefined;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="mark">◧</span>
          <span className="wordmark">DiskScope</span>
          <span className="ver">V0.1 · 只读</span>
        </div>

        <div className="top-actions">
          <button className="act" onClick={pick} disabled={busy}>
            选择目录
          </button>
          {summary && (
            <>
              <button className="act" onClick={() => startScan(root)} disabled={busy || !root}>
                重新扫描
              </button>
              <button className="act" onClick={toggleAll} disabled={busy} title={treeOpen ? "收起所有已展开的目录" : "展开到第三层"}>
                {treeOpen ? "全部收起" : "全部展开"}
              </button>
              <button className="act" onClick={() => setSideOpen((v) => !v)}>
                {sideOpen ? "隐藏详情" : "显示详情"}
              </button>
              <span className="spacer" style={{ width: 8 }} />
              <Dropdown
                label="单位"
                value={unit}
                options={UNITS}
                onChange={(u) => {
                  setUnit(u);
                  setUnitKey(u);
                }}
                title="所有大小数字的显示单位"
              />
              <span className="spacer" style={{ width: 8 }} />
              {/* 视图切换是本页的主开关，所以用会亮起来的按钮，而不是下拉。 */}
              <button
                className={`act ${view === "tree" ? "on" : ""}`}
                onClick={() => setView("tree")}
                title="按行列大小，最像 TreeSize"
              >
                文件树
              </button>
              <button
                className={`act ${view === "blocks" ? "on" : ""}`}
                onClick={() => setView("blocks")}
                title="按面积看占比"
              >
                图表
              </button>
            </>
          )}
        </div>

        <div className="drives">
          {drives.map(([p, used, total]) => {
            const pct = total > 0 ? Math.round((used / total) * 100) : 0;
            return (
              <button
                key={p}
                className={`drive ${root && p === root ? "on" : ""}`}
                onClick={() => startScan(p)}
                disabled={busy}
                title={`${p} ${fmtBytesAuto(used)} / ${fmtBytesAuto(total)}`}
              >
                <div className="drow">
                  <b>{p.replace("\\", "")}</b>
                  <em>{pct}%</em>
                </div>
                <div className="dline">
                  <i style={{ width: `${pct}%` }} />
                </div>
                <div className="dnum">
                  {fmtBytesAuto(used)} / {fmtBytesAuto(total)}
                </div>
              </button>
            );
          })}
        </div>
      </header>

      {busy && (
        <div className="progress">
          <div className="pulse" />
          <span>正在扫描… {progress ? `${progress.files.toLocaleString()} 个文件 · ${fmtBytes(progress.bytes)}` : "准备中"}</span>
          <span className="mono small">{progress?.current?.slice(-70)}</span>
          <button className="ghost" onClick={() => api.cancel()}>
            停止
          </button>
        </div>
      )}

      {error && (
        <div className="error">
          {error}
          <button onClick={() => setError("")}>×</button>
        </div>
      )}

      {summary ? (
        <main className="main">
          <div className="statusline">
            <code className="pathlabel" title={root}>
              {root}
            </code>
            <span className="dim">
              {fmtBytes(summary.total_bytes)} · {summary.total_files.toLocaleString()} 文件 · {(summary.elapsed_ms / 1000).toFixed(1)}s
            </span>
            {summary.unreadable_dirs > 0 && (
              <span className="warnchip">
                <i />
                {summary.unreadable_dirs} 个目录拒绝访问
              </span>
            )}
            <span className="spacer" />
            {truncated && <span className="muted">这一层项目太多，只显示了一部分</span>}
          </div>

          <div className="split">
            <div className="viewpane">
              {view === "tree" ? (
                <TreeTable
                  rows={sorted}
                  categories={catMap}
                  expanded={expanded}
                  selected={selNode?.path ?? ""}
                  sortKey={sortKey}
                  onSort={(k) => setSortKey(k)}
                  onToggle={toggle}
                  onGroupToggle={toggleGroup}
                  onSelect={select}
                  onOpen={(r) => {
                    if (r.group) toggleGroup(r);
                    else if (r.node.has_children) toggle(r);
                  }}
                  onExplain={explain}
                />
              ) : (
                <div className="blockpane">
                  <div className="crumbs">
                    <button className="ghost tiny" onClick={() => setBlockPath("")} disabled={!blockPath}>
                      ← 返回上级
                    </button>
                    <code title={blockPath || root}>{blockPath || root}</code>
                    <span className="muted small">按面积看占比，双击方块进入</span>
                  </div>
                  <Treemap
                    nodes={blockKids.map((r) => r.node)}
                    categories={catMap}
                    selected={selNode}
                    onOpen={(n) => {
                      if (n.is_dir && n.has_children) setBlockPath(n.path);
                    }}
                    onSelect={(n) => select({ depth: 0, node: n })}
                  />
                </div>
              )}
            </div>

            {sideOpen && (
              <aside className="side">
                <div className="side-top">
                  <div className="eyebrow">
                    <span>选中的东西</span>
                    <div className="aibox-acts">
                      {selNode && (
                        <button
                          className="linkish"
                          onClick={() => navigator.clipboard?.writeText(selNode.path)}
                          title="复制完整路径"
                        >
                          复制路径
                        </button>
                      )}
                      <button className="linkish" onClick={openAiSettings} title="改接口、模型或 API Key（只保存在本机）">
                        AI 设置
                      </button>
                    </div>
                  </div>

                  {selNode ? (
                    <>
                      <div className="selname" title={selNode.path}>
                        {displayName(selNode)}
                      </div>
                      <div className="selpath" title={selNode.path}>
                        {selNode.path}
                      </div>
                      <div className="chips">
                        <span className="chip">
                          <b>{fmtBytes(selNode.size)}</b>
                        </span>
                        {selected?.group ? (
                          <span className="chip">{selNode.files.toLocaleString()} 个文件</span>
                        ) : selNode.is_dir ? (
                          <>
                            <span className="chip">{selNode.files.toLocaleString()} 文件</span>
                            <span className="chip">{selNode.dirs.toLocaleString()} 文件夹</span>
                          </>
                        ) : (
                          <span className="chip">单个文件</span>
                        )}
                        <span className="chip">{fmtAge(selNode.mtime)}</span>
                        {selVerdict && (
                          <span className="chip v" style={{ color: selVerdict.color, background: selVerdict.color + "14" }}>
                            {selVerdict.label}
                          </span>
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="hint">在左边的树里点一行。</p>
                  )}
                </div>

                <div className="side-bot">
                  <div className="eyebrow">
                    <span>AI 解释</span>
                    {aiMine && aiText && !aiBusy && (
                      <button
                        className="linkish"
                        onClick={() => navigator.clipboard?.writeText(aiText)}
                        title="复制这段解释"
                      >
                        复制
                      </button>
                    )}
                  </div>

                  {selNode && selCat && !selected?.group && (
                    <p className="hint">
                      {selCat.zh}
                      {selNode.category === "root"
                        ? ""
                        : selNode.is_dir && selNode.share > 0
                        ? `（${Math.round(selNode.share * 100)}% 的字节属于这一类）`
                        : selNode.is_dir
                        ? "（按目录名判定，不看内容）"
                        : ""}
                      {selCat.explain_zh ? `。${selCat.explain_zh}` : ""}
                    </p>
                  )}

                  {!selNode ? (
                    <p className="hint">这里会显示它对这一行的解释：这是什么、谁生成的、删了会怎样。</p>
                  ) : selected?.group ? (
                    <p className="hint">
                      「小文件合计」是虚拟行，没有可解释的对象；展开后对具体文件点 AI。
                    </p>
                  ) : (
                    <>
                      {!keyOk ? (
                        <p className="hint">
                          还没填 Key，AI 解释是可选的。
                          <button className="linkish" onClick={openAiSettings}>
                            去填
                          </button>
                        </p>
                      ) : aiBusy && aiPath === selNode.path ? (
                        <p className="hint">正在分析…（通常需要几秒）</p>
                      ) : aiPath === selNode.path && aiErr ? (
                        <>
                          <div className="error inline">{aiErr}</div>
                          <button className="linkish" onClick={() => explain(selected!)} disabled={aiBusy}>
                            重试
                          </button>
                        </>
                      ) : aiPath === selNode.path && aiText ? (
                        <>
                          <pre className="aiout">{aiText}</pre>
                          <button className="linkish" onClick={() => explain(selected!)} disabled={aiBusy}>
                            重新解释
                          </button>
                        </>
                      ) : (
                        <button className="primary" onClick={() => explain(selected!)} disabled={aiBusy}>
                          让 AI 解释这一个
                        </button>
                      )}
                    </>
                  )}
                </div>

                <div className="side-foot">
                  DiskScope 只读文件名、大小和修改时间；AI 只收到路径与统计数字，不会上传文件内容，也不参与任何删除。
                </div>
              </aside>
            )}
          </div>
          <Composition totals={catTotals} categories={catMap} path={compoPath} />
        </main>
      ) : (
        <div className="intro">
          <h1>先看看，"你的盘被什么吃掉了"</h1>
          <p>选一个磁盘开始扫描。v0.1 只读——不会删除、移动或修改任何文件。</p>
          <button className="primary" style={{ maxWidth: 260 }} onClick={pick} disabled={busy}>
            选择要扫描的文件夹
          </button>
          <p className="small">扫描只读目录元数据，不上传任何东西；AI 解释需要你自己填 Key，且只发送路径与统计数字。</p>
          {!drives.length && <div className="error inline">没有检测到磁盘，可能需要稍等再试。</div>}
        </div>
      )}

      {aiOpen && (
        <div className="modal-back" onClick={() => setAiOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>AI 设置</h2>
            <p className="muted small">
              只发送<b>路径、大小、修改时间、子项名单与本地统计数字</b>，不会上传文件内容。请求直接发往你填写的接口，配置只保存在本机。
            </p>
            <div className="airow provrow-line">
              <Dropdown
                label="服务商"
                value={provider.id}
                options={PROVIDERS.map((p) => ({ value: p.id, label: p.label, hint: p.hint }))}
                onChange={(id) => pickProvider(id)}
                title="点开选择服务商，地址会自动填好"
              />
            </div>

            <label>接口地址</label>
            {provider.id === "custom" ? (
              <input
                value={cfg.endpoint}
                onChange={(e) => saveCfg({ ...cfg, endpoint: e.target.value })}
                placeholder="https://example.com/v1"
                spellCheck={false}
              />
            ) : (
              <code className="aiendpoint">{cfg.endpoint}</code>
            )}

            <p className="muted small ai-provhint">
              {provider.id === "custom" ? provider.hint : `Key 申请：${provider.hint}`}
            </p>

            <div className="airow">
              {modelList.length ? (
                <Dropdown
                  label="模型"
                  value={cfg.model}
                  options={modelList.map((m) => ({ value: m, label: m }))}
                  onChange={(m) => saveCfg({ ...cfg, model: m })}
                  title="点开选择模型"
                />
              ) : (
                <input
                  value={cfg.model}
                  onChange={(e) => saveCfg({ ...cfg, model: e.target.value })}
                  placeholder="模型 id，例如 llama3.2"
                  spellCheck={false}
                />
              )}
              <button
                className="linkish"
                disabled={probeBusy || !keyOk}
                onClick={() => probeModels(cfg)}
                title="向接口询问它实际提供哪些模型"
              >
                {probeBusy ? "检测中…" : "检测可用模型"}
              </button>
            </div>
            {probeErr && <div className="error inline">{probeErr}</div>}

            <label>API Key</label>
            {isLocalEndpoint(cfg.endpoint) ? (
              <p className="hint">本机地址不需要 Key，直接点下面的按钮即可。</p>
            ) : (
              <input
                type="password"
                value={cfg.api_key}
                onChange={(e) => saveCfg({ ...cfg, api_key: e.target.value })}
                onBlur={autoProbe}
                placeholder="粘贴你的 API Key"
              />
            )}

            {probeErr === "" && <p className="hint">填完关掉这个窗口，选中一行再点「让 AI 解释这一个」，解释会显示在右侧。</p>}
          </div>
        </div>
      )}
    </div>
  );
}
