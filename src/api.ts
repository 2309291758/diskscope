import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { CatTotals, Category, NodeView, RowsOut, ScanSummary } from "./types";

export interface AiCfg {
  /** Preset id from providers.ts; absent for configs saved before presets existed. */
  provider?: string;
  endpoint: string;
  api_key: string;
  model: string;
}

export const api = {
  scan: (path: string) => invoke<ScanSummary>("scan_path", { path }),
  cancel: () => invoke<void>("cancel_scan"),
  children: (path: string) => invoke<NodeView[]>("get_children", { path }),
  /** `depth` levels below `path`, pre-order, one IPC call for the whole block. */
  rows: (path: string, depth: number) => invoke<RowsOut>("get_rows", { path, depth }),
  summary: () => invoke<ScanSummary>("get_summary"),
  biggest: (limit: number) => invoke<NodeView[]>("get_biggest", { limit }),
  categoryTotals: (path?: string) => invoke<CatTotals>("get_category_totals", { path: path ?? null }),
  categories: () => invoke<Category[]>("get_categories"),
  drives: () => invoke<[string, number, number][]>("list_drives"),
  explain: (path: string, cfg: AiCfg) => invoke<{ text: string; model: string }>("explain_with_ai", { path, cfg }),
  /** Model ids the configured endpoint actually serves. */
  listModels: (cfg: AiCfg) => invoke<string[]>("list_models", { cfg })
};

export async function pickDirectory(): Promise<string | null> {
  const r = await open({ directory: true, multiple: false, title: "选择要扫描的文件夹" });
  return typeof r === "string" ? r : null;
}

export type Unit = "auto" | "gb" | "mb" | "kb";

/** Display unit, kept module-level so every formatter agrees. The App bumps a
 *  state key on change, which re-renders the tree and picks this up. */
let UNIT: Unit = "auto";
export function setUnit(u: Unit) {
  UNIT = u;
}

export function fmtBytes(n: number): string {
  if (!n) return "0 B";
  if (UNIT === "gb") {
    // Keep tiny things readable instead of rounding them all to "0.00 GB".
    if (n < 1024 ** 2) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 ** 3).toFixed(2) + " GB";
  }
  if (UNIT === "mb") {
    if (n < 1024) return n.toFixed(0) + " B";
    const mb = n / 1024 ** 2;
    // 482,460.8 MB is noise: past four digits the fraction stops being a signal
    // and starts stealing width from the percent column next to it.
    return (mb >= 1000 ? mb.toFixed(0) : mb.toFixed(1)) + " MB";
  }
  if (UNIT === "kb") {
    // KB is the "count the small stuff" mode: whole kilobytes as far up as the
    // number stays readable, GB beyond. The cutoff is six digits rather than a
    // round 1 GB because a folder of 0.99 GB rendered "1042573 KB" — accurate,
    // and wide enough to shove the percentage column off the row.
    if (n < 1024) return n.toFixed(0) + " B";
    if (n < 1e6 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 ** 3).toFixed(1) + " GB";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + " " + units[i];
}

/** Same scale ladder, always automatic — for the drive cards, where a
 *  "307221.0 MB" reading would be worse than useless. */
export function fmtBytesAuto(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + " " + units[i];
}

export function fmtNum(n: number): string {
  return n ? n.toLocaleString("zh-CN") : "—";
}

export function fmtDate(secs: number): string {
  if (!secs) return "—";
  const d = new Date(secs * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "3 天前" / "5 个月前" — age is the strongest cleanup signal there is. */
export function fmtAge(secs: number): string {
  if (!secs) return "—";
  const days = Math.floor((Date.now() / 1000 - secs) / 86400);
  if (days <= 0) return "今天";
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${(days / 365).toFixed(1)} 年前`;
}
