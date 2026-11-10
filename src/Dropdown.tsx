import { useEffect, useRef, useState } from "react";

export interface Opt<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

interface Props<T extends string> {
  /** Small caption before the current value, e.g. "视图". */
  label: string;
  value: T;
  options: Opt<T>[];
  onChange: (v: T) => void;
  title?: string;
}

/**
 * A one-line button that opens a drawer under itself.
 *
 * Not a native <select>: the native popup in WebView2 ignores our palette and
 * cannot show a checkmark column, and picking an item then re-reading the
 * label is exactly the "one button, one drawer" the toolbar needs.
 * Closes on outside mousedown and on Escape, so it never traps the pointer.
 */
export default function Dropdown<T extends string>({ label, value, options, onChange, title }: Props<T>) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const cur = options.find((o) => o.value === value);

  return (
    <div className="dd" ref={box}>
      <button
        className={`dd-btn ${open ? "open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="dd-cap">{label}</span>
        <span className="dd-val">{cur?.label ?? value}</span>
        <span className="dd-caret">▾</span>
      </button>
      {open && (
        <div className="dd-menu" role="menu">
          {options.map((o) => (
            <button
              key={o.value}
              role="menuitem"
              className={`dd-item ${o.value === value ? "on" : ""}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="dd-tick">{o.value === value ? "✓" : ""}</span>
              <span>{o.label}</span>
              {o.hint && <em>{o.hint}</em>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
