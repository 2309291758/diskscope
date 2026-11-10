# DiskScope — 开发交接（HANDOFF）

> 给接手的 AI 编程助手 / 开发者。假设你**没有**读过之前的对话，读完这一份就能继续干。
> 最后更新：2026-11-10，对应 commit `54c7b66`（工作区干净，**尚未打 tag**）。

---

## 0. 三十秒版

DiskScope 是一个 Windows 磁盘占用分析工具：扫完一个盘，用 **TreeSize 式文件树** 展示每个目录占多少，
再用一套**离线规则库**（+ 可选 BYOK 大模型）告诉你「这东西是什么、谁生成的、删了会怎样」。
它**不删除任何文件**——v0.1 严格只读。

- 仓库：https://github.com/2309291758/diskscope （public, MIT, main 分支）
- 技术栈：Tauri 2 + Rust（扫描/分类）+ React 18 + TypeScript（界面）
- 本地路径：`D:\dsh\diskscope\`
- 唯一的产品原则：**AI 永不参与删除决策**。模型看不到文件归属（导师的数据、论文初稿），
  它只负责把「这是什么」讲清楚，删不删是人的事。

---

## 1. 怎么让它跑起来（这一步最容易卡住）

### 1.1 构建

```powershell
cd D:\dsh\diskscope
npm install                      # 首次
npx tsc --noEmit                 # 类型检查（必须 0 退出码）
npx vite build                   # 前端产物 -> dist/
npx tauri build --no-bundle      # 约 1.5–2.5 分钟，只出 exe 不打安装包
```

产物：`D:\dsh\diskscope\src-tauri\target\release\diskscope.exe`

### 1.2 **坑：exe 不能就地运行**（会直接闪退，退出码 0xC0000409）

`D:\dsh\` 这棵子树的 ACL 带 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`，
从里面启动的进程继承 **Low 完整性级别**。WebView2 的 `msedgewebview2.exe` 宿主以 Low IL 运行时
创建/写用户数据目录（`%LOCALAPPDATA%\io.github.diskscope.app\EBWebView\`）被拒，
WebView2 返回 `HRESULT(0x800700AA) 请求的资源在使用中`，
Tauri 的 setup 里 panic，进程报 FAST_FAIL_STACK_COOKIE_CHECK_FAILURE 自杀。

**三条绕法**（已实测）：

1. **复制出来跑（现用这条）**：`Copy-Item ...\target\release\diskscope.exe D:\ds_run\diskscope.exe -Force`
2. `icacls <exe> /setintegritylevel Medium` —— 但每次 rebuild 会因父目录 `(OI)(CI)` 重新继承回 Low，要重做
3. 改 `D:\dsh` 自身的标签 —— **不要做**，那是 DSH 自己的目录

正反验证过：同一条 exe，`/setintegritylevel Medium` 立刻能启动，改回 Low 立刻闪退。
**这不是产品缺陷**——用户从安装包装到 `C:\Program Files` 时是正常 Medium IL，不会遇到。

另外 `D:\dsh` 还有 `Everyone:(CI)(DENY)(DC)`，**删子项会被拒**，清理构建产物时会踩到。

### 1.3 启动 + 截图自动化（`D:\dsh\_tmp\` 下的脚本）

```powershell
# 1. 先杀掉再覆盖（否则报「文件正由另一进程使用」）
Get-Process diskscope -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 2
Remove-Item D:\ds_run\diskscope.exe -Force -ErrorAction SilentlyContinue
Copy-Item D:\dsh\diskscope\src-tauri\target\release\diskscope.exe D:\ds_run\diskscope.exe

# 2. 只能用 WMI 启动 GUI（Start-Process 会报 NO_PROXY/no_proxy 重复键）
([wmiclass]"Win32_Process").Create("cmd.exe /c D:\ds_run\diskscope.exe")

# 3. 提到前台（不做这步，click 会打到别的窗口）
powershell -ExecutionPolicy Bypass -File D:\dsh\_tmp\front.ps1 -ProcName diskscope

# 4. 点击（参数是 -RelX / -RelY，不是 -X / -Y）
powershell -ExecutionPolicy Bypass -File D:\dsh\_tmp\click.ps1 -RelX 1147 -RelY 72 -ProcName diskscope

# 5. 抓窗口内容（PrintWindow(h,hdc,2) 对 WebView2 有效，不受遮挡影响）
powershell -ExecutionPolicy Bypass -File D:\dsh\_tmp\pwin.ps1 -ProcName diskscope -Out D:\dsh\_tmp\shot.png
```

- `.ps1` 直接调用会报 `AuthorizationManager check failed`，**必须加 `-ExecutionPolicy Bypass`**
- 窗口 1330×940 时的相对坐标：E 盘卡 (1147, 72)、D 盘 (740, 72)、C 盘 (300, 72)、
  「选择目录」按钮 (277, 77)、侧栏「AI 设置」linkish (1266, 174)
- 原生「选择文件夹」对话框用 `D:\dsh\_tmp\pick2.ps1 -Path2 "D:\Demo"` 自动填
- **像素级验收一律用 release 版**。debug 版 + dev server 曾报 `Command get_rows not found`，
  那只是 debug 二进制比源码旧，不是真 bug

### 1.4 演示数据

`D:\Demo\` —— 718 个稀疏文件，界面显示 45.20 GB，实际几乎不占盘。
8 个顶层目录：AppData / dev / Downloads / Installers / Papers / Photos / Video Projects / WeChat Files。
`docs/` 里那两张截图就是扫它拍的。**不要把真实用户目录拍进截图。**

---

## 2. 代码地图

```
D:\dsh\diskscope\
  src\                     前端（React + TS）
    App.tsx                894 行，全部布局 + 状态 + 侧栏 + AI 设置弹窗
    TreeTable.tsx          206 行，虚拟滚动树表（主视图）
    Treemap.tsx            148 行，Canvas treemap 绘制
    squarify.ts            squarified 算法，纯函数、可单测
    oklch.ts               OKLCH 取色 / 占比色阶
    Composition.tsx        侧栏「这里的构成」小环图
    Dropdown.tsx           自定义下拉（不是原生 select）
    api.ts                 invoke 封装 + 单位格式化
    providers.ts           5 家服务商预设 + providerOf / isLocalEndpoint
    types.ts               与 Rust 侧 NodeView / Row / Category 等对应的 TS 类型
    styles.css             461 行，全部样式，CSS 变量在 5-37 行
  src-tauri\src\
    scan.rs                655 行，遍历 + Node 树 + finalize（汇总/分类/排序/计数）
    categories.rs          规则加载与匹配、Composition 字节占比、compose()
    lib.rs                 454 行，Tauri 命令层
    main.rs                一行，调 diskscope_lib::run()
  src-tauri\examples\diag.rs   命令行诊断工具（见 §2.3）
  rules\categories.json    22 类规则，纯数据，编译期 include_str! 内嵌
  docs\                    截图 + 这份 HANDOFF
  .github\workflows\release.yml   tag 触发，出 draft release
```

### 2.1 Rust 侧关键位置

| 位置 | 作用 |
| --- | --- |
| `scan.rs:509` | `pub fn scan<F>(root, cancel, progress) -> Result<Tree, String>` 扫描入口 |
| `scan.rs:388` | `scan_dir()` 递归遍历，rayon 并行子目录 |
| `scan.rs:89` | `Node::finalize(&mut self, inherited: Option<&'static str>)` **分类总入口**：116-133 显式规则优先，134-187 是 None 分支的「按子项字节占比推断」 |
| `scan.rs:345` | `is_drive_root()` 判断盘符根，根目录被判成 `root` 类、不参与内容推断 |
| `scan.rs:362` | `long_path()` 超 MAX_PATH 加 `\\?\` 前缀 |
| `scan.rs:327` | `is_reparse()` 跳过 junction / symlink（防重复计数与成环） |
| `categories.rs:147` | `classify(path_lower, ext_lower, kind) -> Option<&'static Category>` 规则匹配 |
| `categories.rs:222` | `compose(&Composition, total)` 按字节占比给目录贴标签 |
| `lib.rs:27` | `to_view(node, parent_size) -> NodeView` Rust Node → 前端 NodeView |
| `lib.rs:279` | `describe()` 组装发给 AI 的元数据文本（**只发元数据，不发文件内容**） |
| `lib.rs:391` | `explain_with_ai()` 调 OpenAI 兼容接口，prompt 固定四段式 |
| `lib.rs:435` | `run()`，`generate_handler!` 在 439-451 行注册 11 个命令 |

**11 个 Tauri 命令**（新增命令必须同时改 `lib.rs:439-451` 的 `generate_handler!` 和 `src/api.ts`）：

```
scan_path, cancel_scan, get_children, get_rows, get_summary, get_biggest,
get_category_totals, get_categories, list_drives, explain_with_ai, list_models
```

### 2.2 前端关键位置

| 位置 | 作用 |
| --- | --- |
| `App.tsx:150-202` | 全部 useState（drives/summary/rows/expanded/selected/aiText/cfg/…） |
| `App.tsx:13-18` | `DEFAULT_CFG` AI 默认配置 |
| `App.tsx:20-24` | `VERDICT` 三档色：safe `#0d7e40` / confirm `#a06513` / never `#ba2b2e` |
| `App.tsx:73-129` | `groupSiblings()` 把小文件合成「N 个小文件」一行；**合成行的 path 是 `父路径\*`，磁盘上不存在** |
| `App.tsx:256-295` | `loadTree()` / `startScan()` |
| `App.tsx:298-352` | `toggle()` 展开目录 |
| `App.tsx:394-407` | `select()` 选中行 |
| `App.tsx:411-426` | `explain()` 请求 AI 解释 |
| `App.tsx:512-590` | 顶栏（品牌 + 动作条 + 盘卡） |
| `App.tsx:632-647` | TreeTable 挂载点 |
| `App.tsx:670-798` | 右侧详情栏（三段式：选中项 / AI 解释 / 隐私说明） |
| `App.tsx:814-891` | AI 设置弹窗 |
| `TreeTable.tsx:116-122` | **行 div**：只有 `onClick` / `onDoubleClick` / `title`，**没有 onContextMenu** |
| `TreeTable.tsx:95-104` | 表头 8 列 |
| `styles.css:203-208` | 列 grid 定义 |
| `styles.css:323-328` | `.side` 右栏（336px、圆角 10px） |

`styles.css:356-359` 的 `.side-meta` 是**死代码**，全项目无引用，可以删。

### 2.3 调分类规则不用开界面

```powershell
cd D:\dsh\diskscope\src-tauri
cargo run --example diag -- "E:\" 1        # 打印每个子项的 category / share / 字节数
cargo run --example diag -- "E:\SteamLibrary" 2
```

输出示例：`E:\ => 703.93 GB bytes, cat=root share=100.0%`

---

## 3. 已经踩过的坑（别重复踩）

### 3.1 分类引擎的语义

- 规则字段：`path_any` / `dir_any` / `dir_has_any` / `name_any` / `name_has_any` /
  `ext_any` / `path_over_ext`
- 风险三档：`safe` 通常可删 / `confirm` 需确认 / `never` 不要删
- **`inherit`**：容器把归属传给子目录。
  `E:\SteamLibrary\steamapps\common\Space Marine 2\` 里那些没扩展名的 .pak 也算游戏。
  **别给缓存类开 inherit**，会把整棵树都污染成缓存。
- **`weak`**：`data`（程序数据块）只说明「字节是什么」，不说明「谁拥有」。
  遇到游戏/程序这类容器会让位，避免把 40 GB 游戏资源说成「可删的程序数据」。
- 已知误判（写在 README 里，未修）：`E:\Photoshop\` 判 archive（里面确实是 .7z/.rar）、
  `E:\pydata` 判 photo 96.8%（按字节诚实但用途是代码项目）、各种「新建文件夹」落 other。

### 3.2 磁盘根目录是独立的一类

根目录**不按子项内容推断类型**（不再显示「游戏文件 55.7%」），固定 `category = "root"`、
`share = 1.0`。实现：`scan.rs:345 is_drive_root()` + `scan()` 里 `finalize()` 之后的覆盖。
前端在 tooltip 和侧栏里对 `root` 做了豁免（不拼「目录里 N% 的字节属于这一类」）。

### 3.3 字体：为什么是 Noto Sans SC

原来是 `Microsoft YaHei UI`。问题：雅黑 Regular / Bold 是**两个独立字体文件**，
字形高度不同，导致「选中行加粗时中文字上下错位 1–2px」。

用 Edge headless canvas 做过像素级实测，20px「项目照片」的墨迹包围盒：

| 字体 | 400 | 600 |
| --- | --- | --- |
| Microsoft YaHei UI | 宽79 高17 | 宽79 高19（上下各跳 1–2px） |
| **Noto Sans SC (VF)** | 宽77 高18 | **宽77 高18（差值全 0）** |

本机 `C:\Windows\Fonts\NotoSansSC-VF.ttf` 是 16.9 MB 可变字体，一个文件覆盖全字重，
注册表族名就是干净的 `"Noto Sans SC"`。`--sans` 里它排在 YaHei 之前。
（`HarmonyOS Sans SC` 虽然装了，但注册名带 `_Regular` / `_Bold` 后缀，CSS 解析不到，别用。）

复测方法：写个 canvas 页面，`getImageData` 遍历 alpha>40 的像素求包围盒，
用 `msedge.exe --headless=new --screenshot=... file:///...` 截图读像素。

### 3.4 表头排版与胶囊边界

- `.treehead button, .treehead span` 必须写 `font: inherit`。原来只设了 font-size，
  于是 `c-num` / `c-date` 把列体的 `font-family: var(--mono)` 一起继承下来，
  同一排出现 sans 11px / mono 11.5px / mono 10.5px 三种规格。
- `--rule`（#eae7de）是给分隔线和卡片用的，勾按钮太淡，因此另加了 `--ctl`（#dcd7c9）
  给顶栏 `.act` 和弹窗 `.dd-btn` 描边。

### 3.5 其他小坑

- `src/squarify.ts` 不能叫 `treemap.ts`——和 `Treemap.tsx` 在大小写不敏感文件系统上冲突，报 TS1261
- `D:\dsh` 的 `Everyone:(CI)(DENY)(DC)` 会拒绝删除子项
- PowerShell 5.1 读无 BOM 的 `.ps1` 会按 GBK 解析，含中文的脚本必须存 UTF-8 **带 BOM**
- `cargo test --lib` 当前 **16 个测试全过**；改 `scan.rs` / `categories.rs` 后必须重跑

---

## 4. 下一步要做的（按优先级）

### 4.1 待实现 A：右键菜单「在资源管理器中打开」

用户原话（2026-11-10）：「右键在某个框的时候，我需要能有跳转在资源管理器中打开的能力」。

- 入口：`TreeTable.tsx:116-122` 的行 div 加 `onContextMenu`
- 后端不需要新插件：`std::process::Command::new("explorer.exe").arg("/select,").arg(&path)`
  （目录就 `explorer.exe <dir>`），写成一个 Tauri 命令加进 `generate_handler!`
- **必须处理合成行**：`row.group` 为真、或 path 以 `\*` 结尾的行在磁盘上不存在，
  这类行要禁用「打开」「在资源管理器中显示」

### 4.2 待实现 B：末级文件内嵌预览

用户原话：「打开到最后的资源文件 比如 mp3 或者 mp4，其实我应该可以在软件里直接打开文件
我看看内容再确定需不需要删除」。

已勘察完毕的方案（**不引入任何新依赖，可离线构建**）：

- `Cargo.toml` 里**不要**开 `tauri` 的 `protocol-asset` 特性——它需要额外 crate `http-range`，
  本机 cargo registry 和 Cargo.lock 里都没有，有离线构建失败风险
- 改用 `Builder::register_asynchronous_uri_scheme_protocol("file", ...)`
  （tauri-2.12.5/src/app.rs:2335-2350），在 `lib.rs:436` 的 Builder 链上加
- Windows 上 URL 形式是 `http://file.localhost/<urlencoded-path>`；
  前端 `convertFileSrc(path, "file")`（`@tauri-apps/api/core`）会把**整条路径** `encodeURIComponent`
  拼成一个 path 段，所以 **Rust 侧要 percent-decode 整段**，不能按 `/` 切段
- percent-decode 需要自己写十几行（registry 里没有 percent-encoding / urlencoding）
- MIME 判断可以用已在 Cargo.lock 里的 `infer` 0.22（按魔数嗅探）或按扩展名硬编码
- 建议范围：图片 + 文本在侧栏内嵌预览；**mp3/mp4 交给系统默认程序打开**
  （内嵌音视频要么引 codec，要么受 WebView2 编解码限制，收益不划算）
- `tauri.conf.json` 的 `security.csp` 现在是 `null`，暂不拦截；如果将来收紧 CSP，
  记得把 `http://file.localhost` 加进 `img-src` / `media-src`

### 4.3 后续路线

- **v0.2 删除**：删除到回收站（`IFileOperation`，可撤销，不要直接 `remove`）、
  确认面板、按分类一键清理（只勾 `safe`，`never` 不给勾）、撤销入口。
  硬约束：**AI 的「建议」永远不能直接触发删除**
- **v0.3 速度**：NTFS MFT 直读（`FSCTL_ENUM_USN_DATA`）压到 1 秒级，
  不可用时回退到现在的普通遍历；扫描结果缓存 / 增量重扫
- **发布**：仓库**还没打 tag**。`.github/workflows/release.yml` 是 `on push tags v*`，
  一打 tag 就自动出 draft release（msi + nsis）。打不打由维护者决定

---

## 5. 明确不做的事

- v0.1 / v0.2 都不让 AI 参与删除决策
- 不上传文件内容（只发元数据：路径、大小、修改时间、子项名单、本地统计数字）
- 不做内置免费 AI 额度，只支持 BYOK
- 目前只支持 Windows（Tauri 本身跨平台，但扫描语义和长路径处理是 Windows 专属）

---

## 6. 快速自检清单

改完代码，交付前跑这几条：

```powershell
cd D:\dsh\diskscope
npx tsc --noEmit                              # 必须 exit 0
npx vite build                                # 必须成功
cargo test --manifest-path src-tauri\Cargo.toml --lib    # 16 passed
npx tauri build --no-bundle                   # 出 release exe
```

然后**复制到 `D:\ds_run\` 启动**（见 §1.2），扫一遍 `D:\Demo`，确认：
文件树能出、点行有侧栏、AI 设置弹窗能打开、切换图表视图正常。
