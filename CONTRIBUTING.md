# 参与贡献

最容易上手的贡献是**补充规则库**，不需要写 Rust。

## 补一条分类规则

编辑 `rules/categories.json`，然后在 `categories` 数组里加一项：

```json
{
  "id": "steam-shader",
  "zh": "Steam 着色器缓存",
  "en": "Steam shader cache",
  "verdict": "safe",
  "color": "#b593dc",
  "explain_zh": "游戏预编译的着色器。删了会重新编译，第一次进游戏会卡一下，不影响存档和游戏进度。",
  "explain_en": "Precompiled shaders. They recompile on next launch; saves and progress are untouched.",
  "path_any": ["\\steam\\shadercache"]
}
```

要点：

- `path_any` 是**不区分大小写的子串匹配**，用反斜杠分段更精确（`\node_modules` 而不是 `node_modules`）
- 其它可用字段：`dir_any`（目录名全等）、`dir_has_any`（目录名子串）、
  `name_any` / `name_has_any`（文件名）、`ext_any`（扩展名）、
  `path_over_ext`（路径命中优先于扩展名，系统目录就该这样）
- `verdict` 分三档：`safe`（删了没影响）、`confirm`（要用户自己确认）、`never`（别动）
- `color` 是界面上徽章和方块图的颜色。现有 22 个色值是用 OKLCH 生成的：
  亮度固定在 L≈0.72–0.78，只变色相，所以任意挑两个看起来重量相当。
  加新分类时请照这个规律选色（相邻色相差 ≥12°，别用 #ff0000 这种纯饱和色），
  否则会出现某个标签扎眼、某个标签发灰
- 规则按**数组顺序**匹配，先命中先生效，所以越具体的越要放前面
- `inherit: true` 表示这一类是**容器**，把归属传给子目录（游戏库、安装目录）。
  别给「缓存」这种类开 inherit —— 否则未知文件会被连带说成可删
- `weak: true` 表示这个标签只说明「字节是什么」（如 `data` 的程序数据块），
  不说明「谁拥有」；遇到 inherit 的容器会让位。加这一类前先确认真的需要
- `explain_zh` 写给完全不懂电脑的用户看：说清**这是什么、删了会怎样**，
  不要写"缓存文件，建议清理"这种没有信息量的话

## 提交代码

```bash
npm install
npm run tauri dev
cargo test --manifest-path src-tauri/Cargo.toml
```

扫描逻辑的改动请附测试：统计口径必须能和资源管理器对得上，这是用户信任的基础。

改完规则想快速核对判定结果，不用开界面：

```bash
cd src-tauri
cargo run --example diag -- "E:\" 1        # 每个直接子项的 category / share / size
cargo run --example diag -- "E:\SteamLibrary" 2
```
