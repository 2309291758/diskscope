import { useRef, useState, type MouseEvent } from "react";
import { fmtBytes } from "./api";
import type { CatTotals, Category } from "./types";

// Beyond this the strip turns into confetti: the tail is merged into one
// segment so every slice stays wide enough to aim at.
const MAX_SLICES = 8;
const FALLBACK = "#98a2b3";

interface Slice {
  id: string;
  zh: string;
  color: string;
  bytes: number;
  pct: number;
  hint?: string;
}

interface Hover {
  x: number;
  y: number;
  w: number;
  s: Slice;
}

/**
 * What the current folder is made of, as one horizontal strip under the tree.
 *
 * It lives at the bottom because the composition answers "what is this folder",
 * a question you ask once per folder, while the tree and the AI answer are read
 * continuously. Hovering a slice is the only detail view: a permanent legend
 * with byte counts would take the width the rows need.
 */
export default function Composition({
  totals,
  categories,
  path
}: {
  totals: CatTotals | null;
  categories: Map<string, Category>;
  path: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const total = totals?.total ?? 0;
  const raw = totals?.rows ?? [];
  const shown = raw.slice(0, MAX_SLICES);
  const rest = raw.slice(MAX_SLICES);
  const restBytes = rest.reduce((a, [, b]) => a + b, 0);

  const slices: Slice[] = shown.map(([id, bytes]) => {
    const c = categories.get(id);
    return {
      id,
      zh: c?.zh ?? id,
      color: c?.color ?? FALLBACK,
      bytes,
      pct: total > 0 ? (bytes / total) * 100 : 0,
      hint: c?.explain_zh
    };
  });
  if (rest.length) {
    const names = rest.map(([id]) => categories.get(id)?.zh ?? id);
    slices.push({
      id: "__rest",
      zh: `其他 ${rest.length} 类`,
      color: FALLBACK,
      bytes: restBytes,
      pct: total > 0 ? (restBytes / total) * 100 : 0,
      hint: names.join("、")
    });
  }

  function enter(e: MouseEvent, s: Slice) {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setHover({ x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, s });
  }

  const tipLeft = hover ? Math.max(8, Math.min(hover.x - 96, hover.w - 312)) : 0;

  return (
    <div className="compo" ref={box} onMouseLeave={() => setHover(null)}>
      {/* 一股文字流：路径和总量是同一条信息的两个字段，分开摆会被误读成两列。 */}
      <div className="compo-head">
        <span className="t">这里的构成</span>
        <span className="p" title={path}>
          {path}
          {total > 0 ? ` · ${fmtBytes(total)}` : ""}
        </span>
        <span className="spacer" />
        <span className="vlegend">
          <span>
            <i style={{ background: "var(--safe)" }} />
            通常可删
          </span>
          <span>
            <i style={{ background: "var(--warn)" }} />
            需确认
          </span>
          <span>
            <i style={{ background: "var(--danger)" }} />
            不要删
          </span>
        </span>
      </div>

      <div className="compobar">
        {slices.map((s) => (
          <b
            key={s.id}
            style={{ flexGrow: s.pct, flexBasis: 0, background: s.color }}
            onMouseEnter={(e) => enter(e, s)}
          />
        ))}
        {!slices.length && <i className="compobar-empty" />}
      </div>

      <div className="compo-legend">
        {slices.map((s) => (
          <span key={s.id} onMouseEnter={(e) => enter(e, s)}>
            <i style={{ background: s.color }} />
            {s.zh}
            <em>{s.pct < 1 && s.pct > 0 ? "<1" : s.pct.toFixed(0)}%</em>
          </span>
        ))}
      </div>

      {hover && (
        <div className="compo-tip" style={{ left: tipLeft, top: hover.y - 8 }}>
          <b>{hover.s.zh}</b>
          <span>
            {fmtBytes(hover.s.bytes)} · {hover.s.pct < 0.1 && hover.s.pct > 0 ? "<0.1" : hover.s.pct.toFixed(1)}%
          </span>
          {hover.s.hint && <small>{hover.s.hint}</small>}
        </div>
      )}
    </div>
  );
}
