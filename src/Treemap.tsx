import { useEffect, useRef, useState } from "react";
import { squarify, type Rect } from "./squarify";
import type { Category, NodeView } from "./types";
import { fmtBytes } from "./api";
import { tintToLightness } from "./oklch";

interface Props {
  nodes: NodeView[];
  categories: Map<string, Category>;
  onOpen: (n: NodeView) => void;
  onSelect: (n: NodeView) => void;
  selected: NodeView | null;
}

// Matches --accent: selection has to read against every category hue.
const ACCENT = "#2466c3";

// Every tile is re-lit to one of two lightnesses, so a big beige tile and a small
// blue tile weigh the same. Area alone says how big something is.
const L_DIR = 0.915;
const L_FILE = 0.95;
const L_SEL = 0.88;
// Chroma is dialled back on purpose: at equal lightness the full-strength hues
// read as candy, and 21 of them side by side stop meaning anything.
const CHROMA = 0.55;
const NO_CAT = "#414f5d";

export default function Treemap({ nodes, categories, onOpen, onSelect, selected }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; node: NodeView } | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const rects = useRef<Rect[]>([]);
  const hoverPath = hover?.node.path ?? "";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    canvas.style.width = size.w + "px";
    canvas.style.height = size.h + "px";
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    rects.current = squarify(nodes, 0, 0, size.w, size.h);
    for (const r of rects.current) {
      const cat = categories.get(r.node.category);
      const base = cat?.color ?? NO_CAT;
      const isSel = selected?.path === r.node.path;
      const fill = tintToLightness(base, isSel ? L_SEL : r.node.is_dir ? L_DIR : L_FILE, CHROMA);

      ctx.fillStyle = fill;
      ctx.fillRect(r.x + 0.5, r.y + 0.5, Math.max(r.w - 1, 0), Math.max(r.h - 1, 0));

      if (r.node.path === hoverPath && !isSel) {
        ctx.strokeStyle = "rgba(23,25,28,0.4)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(r.x + 1, r.y + 1, Math.max(r.w - 2, 0), Math.max(r.h - 2, 0));
      }
      if (isSel) {
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 2;
        ctx.strokeRect(r.x + 1, r.y + 1, Math.max(r.w - 2, 0), Math.max(r.h - 2, 0));
      }

      if (r.w < 56 || r.h < 22) continue;
      const pad = 6;
      const maxChars = Math.floor((r.w - pad * 2) / 6.4);
      ctx.fillStyle = "#17191c";
      ctx.font = "600 11px system-ui, sans-serif";
      ctx.textBaseline = "alphabetic";
      const name = r.node.name || r.node.path;
      ctx.fillText(name.length > maxChars ? name.slice(0, Math.max(maxChars - 1, 1)) + "…" : name, r.x + pad, r.y + 15);

      if (r.h >= 34 && maxChars > 6) {
        ctx.globalAlpha = 0.62;
        ctx.font = "10px system-ui, sans-serif";
        const pct = Math.round(r.node.percent);
        const sub = r.h >= 46 ? `${fmtBytes(r.node.size)} · ${pct}%` : fmtBytes(r.node.size);
        ctx.fillText(sub, r.x + pad, r.y + 28);
        ctx.globalAlpha = 1;
      }
    }
  }, [nodes, size, categories, selected, hoverPath]);

  function hitTest(px: number, py: number): Rect | null {
    for (let i = rects.current.length - 1; i >= 0; i--) {
      const r = rects.current[i];
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r;
    }
    return null;
  }

  function at(e: React.MouseEvent<HTMLCanvasElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    return { r: hitTest(e.clientX - box.left, e.clientY - box.top), x: e.clientX - box.left, y: e.clientY - box.top };
  }

  return (
    <div className="treemap-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onMouseMove={(e) => {
          const { r, x, y } = at(e);
          setHover(r ? { x, y, node: r.node } : null);
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const { r } = at(e);
          if (r) onSelect(r.node);
        }}
        onDoubleClick={(e) => {
          const { r } = at(e);
          if (!r) return;
          onSelect(r.node);
          if (r.node.is_dir && r.node.has_children) onOpen(r.node);
        }}
      />
      {hover && (
        <div
          className="tip"
          style={{ left: Math.min(hover.x + 14, Math.max(size.w - 262, 0)), top: Math.min(hover.y + 14, Math.max(size.h - 78, 0)) }}
        >
          <b>{hover.node.name}</b>
          <span>
            {fmtBytes(hover.node.size)} · {hover.node.percent.toFixed(1)}%
          </span>
          <em>{categories.get(hover.node.category)?.zh ?? hover.node.category}</em>
          {hover.node.is_dir && hover.node.has_children && <small>双击进入</small>}
        </div>
      )}
      {!nodes.length && <div className="empty-inline">这个目录是空的，或者里面的东西无权访问</div>}
    </div>
  );
}
