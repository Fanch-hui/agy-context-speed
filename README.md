# AGY Context & Speed Monitor

原生 Antigravity 2.x Sidecar 面板，实时监控本地会话的上下文 Token、生成速度、等价 API 费用与全会话额度池用量（支持 **macOS / Linux / Windows**）。

无构建、零第三方依赖、零网络请求，**完全保留原厂 App 签名**——安装脚本仅将插件放入 `~/.gemini/config/plugins/`（Windows 为 `%USERPROFILE%\.gemini\config\plugins\`），不修改应用本体。

## 功能特性

- **双仪表与速度历史**：半圆速度指针表（近 20 次流式加权均速）、分段上下文圆环（缓存读 / 新输入双色占比，用量达到 90% 及以上时呈红色警示）、速度历史面积图（支持悬停查看单次速度、输出量与首字延迟）。
- **上下文与缓存明细**：展示上下文已用 / 上限 / 可用、缓存读、新输入、整场与本次输出 Token、整场与本次缓存命中率，以及首字延迟（含近 20 次中位数）。
- **等价 API 费用与子代理拆分**：内置无网静态公开费率表（含 100K / 200K 上下文阶梯价、限时优惠生效期切换与缓存写入计费），逐模型展开当前会话及全部衍生子代理的费用与调用次数。
- **全会话双池双周期汇总**：跨本地全部会话与子代理，按统一双额度池（**Gemini** 与 **Claude / GPT**）汇总用量和等价 API 费用；适配 **Pro / Ultra**（5 小时 + 7 天 + 本月）与 **Free / Plus**（7 天 + 本月），支持「首次调用才开始计时」、按已用 / 距刷新时间校准及额外重置。
- **自动跟随与工作区切换**：默认自动跟随宿主当前打开的会话，也可在下拉框中按工作区分组手动选择（自动过滤子代理会话，兼容 `antigravity`、`antigravity2`、`antigravity-ide`、`antigravity-cli`）。

## 快速安装

### 前置条件

- **Antigravity App 2.22+**（原生 Sidecar 插件，**不是** VS Code 的 `.vsix` 扩展）。
- **Node.js 20+**（推荐 **22.5+**，用于内置 `node:sqlite` 只读解析会话标题、流式耗时、首字延迟与真实模型元数据），且 `node` 已加入 `PATH`。

### 获取与安装

```bash
git clone https://github.com/Fanch-hui/agy-context-speed.git
cd agy-context-speed
```

根据系统执行对应安装脚本（或直接下载 ZIP 解压后进入 `agy-context-speed` 目录运行）：

- **macOS / Linux**：
  ```bash
  bash install.sh
  ```
- **Windows（PowerShell）**：
  ```powershell
  .\install.ps1
  ```
- **Windows（命令提示符 CMD）**：
  ```bat
  install.cmd
  ```
- **跨平台直接运行**：
  ```bash
  node scripts/install.mjs
  ```

安装完成后，关闭并重新打开 **Google Antigravity 2.x**，在对话右上角的 **⋮ → Extensions → Context & Speed** 打开辅助面板。

> **Windows 提示**：安装、升级或卸载前请先完全退出 Antigravity，避免插件目录或配置文件被进程占用导致写入失败。

安装脚本仅安装本插件并开启 `agy-context-speed/monitor` 的 Sidecar 开关；更新 `config.json` 与覆盖旧版本插件前均会自动保留带时间戳备份。也可使用官方 CLI 验证插件结构：

```bash
agy plugin validate --strict .
```

### 卸载

在项目目录运行对应平台的卸载脚本即可移除插件目录并关闭专属 Sidecar 开关（配置修改前会自动备份）：

- macOS / Linux：`bash uninstall.sh`
- Windows PowerShell：`.\uninstall.ps1`
- Windows CMD：`uninstall.cmd`
- 跨平台：`node scripts/uninstall.mjs`

## 指标与数据口径

- **上下文 Token 与上限**：取最近一次模型调用的 `input_tokens + cache_read_tokens`。上限优先读取会话 `gen_metadata` 中记录的真实 `max_context_tokens`；读不到时使用可点击切换的预设档位（`256k` / `512k` / `1M`，界面标注「预设」），当实际用量超过当前预设时自动升到能容纳峰值的最近一档。
- **TPS 与首字延迟**：有流式耗时记录时取最近 20 次的总输出 ÷ 总流式耗时（避免短回复 token 成批到达造成单次均值失真）；读不到调用记录时（如 Node 低于 22.5 或宿主变更格式），速度退回按日志时间戳间隔估算并标注「估算」，首字延迟显示「—」。
- **缓存命中率**：按 `cache_read_tokens / (input_tokens + cache_read_tokens)` 计算，同时展示整场会话累计值与最近一次调用值（`整场 · 本次`）。
- **等价 API 与额度池**：模型优先取 `gen_metadata` 的 `response_model_full` / `response_model` 与 `model_display_name`，兜底取路由别名与模型枚举（`pricing.mjs`）；全会话窗口统计无条件计入所有衍生子代理（`aggregate.mjs`），订阅方案、校准锚点与每月起算时刻由后端持久化（`settings.mjs`），并支持从旧版 3 池配置自动迁移。
- **本地数据来源**：
  - 会话日志：`~/.gemini/antigravity/brain/`（Windows 为 `%USERPROFILE%\.gemini\antigravity\brain\`），优先读取 `transcript.jsonl`，找不到时读取 `transcript_full.jsonl`，单文件仅扫描尾部最多 8 MiB。
  - 元数据数据库（只读）：各数据目录下的 `conversation_summaries.db` 与 `conversations/<uuid>.db`（`gen_metadata` 表，protobuf 格式，字段编号见 `calls.mjs`）。

## 隐私与安全

- **只读本地文件**：不发送任何网络请求，不读取密钥、Token 或 Cookie，不修改会话日志与宿主数据库。
- **不破坏宿主签名**：不修补 `Antigravity.app`、`app.asar` 或任何应用二进制文件。
- **唯一写入路径**：仅写入插件自身的配置与状态文件 `~/.gemini/antigravity/plugin_data/agy-context-speed/settings.json`（Windows 为 `%USERPROFILE%\.gemini\antigravity\plugin_data\agy-context-speed\settings.json`）。

## 项目结构与测试

```text
agy-context-speed/
├── plugin.json                    # AGY 插件元数据
├── install.sh / uninstall.sh      # macOS / Linux 安装与卸载入口
├── install.ps1 / uninstall.ps1    # Windows PowerShell 安装与卸载入口
├── install.cmd / uninstall.cmd    # Windows CMD 安装与卸载入口
├── scripts/
│   ├── install.mjs                # 跨平台安装逻辑
│   └── uninstall.mjs              # 跨平台卸载逻辑
├── sidecars/monitor/
│   ├── sidecar.json               # 原生 Sidecar 面板配置
│   ├── main.mjs                   # Sidecar HTTP/API 后端
│   ├── metrics.mjs                # 只读 JSONL 解析与上下文/速度计算
│   ├── calls.mjs                  # 只读 gen_metadata protobuf 解码
│   ├── pricing.mjs                # 静态公开费率表与等价 API 计算
│   ├── aggregate.mjs              # 跨会话双池双周期汇总
│   ├── summaries.mjs              # 只读会话摘要库与工作区 URI 解析
│   ├── sqlite.mjs                 # 带缓存与 busy_timeout 的只读 SQLite 查询
│   ├── settings.mjs               # 预设上限与窗口设置持久化
│   ├── index.html                 # 面板页面
│   ├── styles.css                 # 主题自适应样式
│   ├── app.js                     # 主界面逻辑
│   └── windows-ui.js              # 全会话汇总与周期校准 UI
└── test/
    └── metrics.test.mjs           # 自动化单元测试
```

运行全部单元测试：

```bash
node --test test/metrics.test.mjs
```
