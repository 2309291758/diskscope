export interface NodeView {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: number;
  ext: string;
  category: string;
  /** How much of this item's own bytes belong to `category` (0–1). */
  share: number;
  /** Direct children (files + folders). */
  child_count: number;
  /** Files and folders rolled up over the whole subtree. */
  files: number;
  dirs: number;
  has_children: boolean;
  /** Size relative to the parent, 0–100. */
  percent: number;
  unreadable: boolean;
}

export interface Row {
  depth: number;
  node: NodeView;
  /** Set only on the synthetic row that stands in for a pile of tiny files. */
  group?: { members: Row[]; open: boolean };
}

export interface RowsOut {
  rows: Row[];
  truncated: boolean;
}

export type SortKey = "size" | "name" | "mtime" | "category";

export interface ScanSummary {
  root: string;
  total_bytes: number;
  total_files: number;
  total_dirs: number;
  unreadable_dirs: number;
  elapsed_ms: number;
}

export interface ScanProgress {
  files: number;
  bytes: number;
  current: string;
}

export interface CatTotals {
  total: number;
  rows: [string, number][];
}

export interface Category {
  id: string;
  zh: string;
  en: string;
  verdict: "safe" | "confirm" | "never" | string;
  color: string;
  explain_zh: string;
  explain_en: string;
}

export interface Drive {
  path: string;
  used: number;
  total: number;
}
