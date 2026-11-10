import { useEffect, useMemo, useRef, useState } from "react";
import { fmtAge, fmtBytes, fmtDate, fmtNum } from "./api";
import type { Category, Row, SortKey } from "./types";

interface Props {
  rows: Row[];
  categories: Map<string, Category>;
  expanded: Set<string>;
  selected: string;
  sortKey: SortKey;
  onSort: (k: SortKey) => void;
  onToggle: (row: Row) => void;
  onGroupToggle: (row: Row) => void;
  onSelect: (row: Row) => void;
  onOpen: (row: Row) => void;
  onExplain: (row: Row) => void;
}

const ROW_H = 33;
const OVERSCAN = 8;
const INDENT = 15;

function pctLabel(p: number): string {
  if (p <= 0) return "—";
  if (p < 0.1) return "<0.1";
  if (p < 10) return p.toFixed(1);
  return p.toFixed(0);
}

/** Header cell. Sorting state is a tick on the label, not a separate arrow
 *  column: the numeric headers are already right-aligned and narrow. */
function SortHead({
  label, k, sortKey, onSort, className
}: {
  label: string; k: SortKey; sortKey: SortKey; onSort: (k: SortKey) => void; className: string;
}) {
  const on = sortKey === k;
  return (
    <button className={`${className} ${on ? "on" : ""}`} onClick={() => onSort(k)}>
      {label}
      {on && <span className="car">▼</span>}
    </button>
  );
}

export default function TreeTable(props: Props) {
  const { rows, categories, expanded, selected, sortKey, onSort, onToggle, onGroupToggle, onSelect, onOpen, onExplain } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const slice = useMemo(() => rows.slice(start, end), [rows, start, end]);

  // Arrow keys walk the flat row list; Enter toggles, Escape clears.
  function onKey(e: React.KeyboardEvent) {
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.node.path === selected);
    const go = (n: number) => {
      const j = Math.min(rows.length - 1, Math.max(0, n));
      onSelect(rows[j]);
      const el = scrollRef.current;
      if (el) {
        const top = j * ROW_H;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
      }
    };
    if (e.key === "ArrowDown") { e.preventDefault(); go(i < 0 ? 0 : i + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(i < 0 ? 0 : i - 1); }
    else if (e.key === "ArrowRight" && i >= 0) {
      const r = rows[i];
      const open = r.group ? r.group.open : expanded.has(r.node.path);
      if ((r.group || r.node.has_children) && !open) { e.preventDefault(); onOpen(r); }
    } else if (e.key === "ArrowLeft" && i >= 0) {
      const r = rows[i];
      const open = r.group ? r.group.open : expanded.has(r.node.path);
      if (open) { e.preventDefault(); onOpen(r); }
    } else if (e.key === "Enter" && i >= 0) { e.preventDefault(); onOpen(rows[i]); }
  }

  return (
    <div className="tree" ref={scrollRef} tabIndex={0} onKeyDown={onKey}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}>
      <div className="treehead">
        <SortHead label="名称" k="name" sortKey={sortKey} onSort={onSort} className="c-name" />
        <SortHead label="大小" k="size" sortKey={sortKey} onSort={onSort} className="c-num" />
        <span className="c-num">占父级</span>
        <span className="c-num">文件</span>
        <span className="c-num">文件夹</span>
        <SortHead label="类型" k="category" sortKey={sortKey} onSort={onSort} className="c-tag" />
        <SortHead label="最后修改" k="mtime" sortKey={sortKey} onSort={onSort} className="c-date" />
        <span className="c-ai" />
      </div>

      <div className="treespacer" style={{ height: rows.length * ROW_H }}>
        <div className="treeslice" style={{ transform: `translateY(${start * ROW_H}px)` }}>
          {slice.map((r) => {
            const n = r.node;
            // A folded pile has no single category; say so instead of "其他".
            const c = categories.get(r.group ? "other" : n.category);
            const open = r.group ? r.group.open : expanded.has(n.path);
            const isSel = selected === n.path;
            const color = c?.color ?? "#7a7a74";
            return (
              <div
                key={n.path}
                className={`trow ${isSel ? "sel" : ""} ${n.unreadable ? "denied" : ""}`}
                onClick={() => onSelect(r)}
                onDoubleClick={() => onOpen(r)}
                title={n.path}
              >
                <span className="c-name">
                  <span className="indent" style={{ width: r.depth * INDENT }} />
                  <span
                    className={`arrow ${open ? "open" : ""} ${r.group || n.has_children ? "" : "none"}`}
                    role="button"
                    aria-expanded={open}
                    onClick={(e) => {
                      e.stopPropagation();
                      // A double-click is one intent, not three. Without this the
                      // second click (and the dblclick, which also lands on the
                      // row) toggles straight back and the folder looks stuck.
                      if (e.detail > 1) return;
                      if (r.group) onGroupToggle(r);
                      else if (n.has_children) onToggle(r);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    {r.group || n.has_children ? "▶" : ""}
                  </span>
                  <span className={`nm ${n.is_dir ? "is-dir" : ""} ${r.group ? "grp" : ""}`}>
                    {n.name || n.path}
                  </span>
                  {n.unreadable && <span className="deny">拒绝访问</span>}
                </span>

                <span className={`c-num sz`}>{fmtBytes(n.size)}</span>

                {/* Number on top, 44px rule under it, the two locked together:
                    a bar pinned to the row edge reads as a divider, and a bar
                    floating under the number reads as a stray underline. */}
                <span className="c-num pctcell">
                  <em className={n.percent > 0 ? "" : "muted"}>{pctLabel(n.percent)}</em>
                  {n.percent > 0 && (
                    <span className="track">
                      <i style={{ width: `${Math.min(100, n.percent)}%` }} />
                    </span>
                  )}
                </span>

                <span className="c-num mut">{n.is_dir ? fmtNum(n.files) : "—"}</span>
                <span className="c-num mut">{n.is_dir && !r.group ? fmtNum(n.dirs) : "—"}</span>

                {/* The dot is always solid and always the category's own colour.
                    A hollow variant used to mark "this was guessed from the folder
                    name, not measured" — but side by side in one column it read as
                    a different, faded category rather than a caveat. The caveat
                    lives in the tooltip now, where it belongs. */}
                <span className="c-tag">
                  <i className="dot" style={{ color, background: color }} />
                  <span
                    className="ct"
                    title={
                      r.group
                        ? `${n.files} 个散落的小文件，每个都不到父级的 0.4%`
                        : (c?.explain_zh ?? "") +
                          (n.is_dir && n.category !== "root"
                            ? n.share > 0
                              ? `（目录里 ${Math.round(n.share * 100)}% 的字节属于这一类）`
                              : "（按目录名判定，不看内容）"
                            : "")
                    }
                  >
                    {r.group ? "小文件合计" : c?.zh ?? n.category}
                  </span>
                </span>

                <span className="c-date" title={fmtDate(n.mtime)}>{fmtAge(n.mtime)}</span>

                <span className="c-ai">
                  {!r.group && (
                    <button className="rowai" title="让 AI 解释这一个"
                      onClick={(e) => { e.stopPropagation(); onExplain(r); }}>AI</button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {!rows.length && <div className="empty">这个目录没有可显示的条目</div>}
    </div>
  );
}
