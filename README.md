# AGY Context & Speed Monitor

原生 Antigravity 2.x Sidecar 面板，监控最近会话的上下文 Token 与生成速度。**完全保留原厂 App 签名**，只把文件放进 `~/.gemini/config/plugins/`，不接触 `Antigravity.app` 或 `app.asar`。

## 使用方式（macOS）

解压 ZIP，打开终端进入解压后的 `agy-context-speed` 文件夹，执行：

```bash
bash install.sh
```

关闭并重新启动 Google Antigravity 2.x，在对话右上角的 **⋮ → Extensions → Context & Speed** 打开辅助面板。

安装脚本使用系统 Node.js，仅安装本插件与开启其 Sidecar 开关。配置文件更新前会保存带时间戳备份。也可以用官方 CLI `agy plugin validate --strict ./agy-context-speed` 验证插件。

卸载：在本插件目录执行 `bash uninstall.sh`。卸载只处理本插件目录及专属 Sidecar 开关。

## 显示指标

- **上下文 Token**：最近一次模型调用的 `input_tokens + cache_read_tokens`。窗口上限取该会话调用记录里的真实值；读不到时用预设档位（256k / 512k / 1M，点击容量数字切换，界面标注「预设」），用量超过预设时自动升到能容纳它的最近一档。
- **TPS**：最近 20 次调用的总输出 ÷ 总流式耗时，另显示最近一次调用的速度。不按单次速度取平均，是因为短回复的 token 常常一次性到达，单次速度会高得失真。
- **首字延迟**：最近一次调用的值，以及最近 20 次的中位数。
- **缓存命中率**：`cache_read_tokens / (input_tokens + cache_read_tokens)`，在上下文区优先展示整场会话累计命中率，并在括号内同时展示最近一次调用命中率。
- **数据来源**：Token 数来自会话日志；流式耗时、首字延迟和上限来自 `conversations/<会话ID>.db` 的 `gen_metadata` 表（只读，protobuf 格式，字段编号见 `calls.mjs`）。读不到调用记录时（Node 低于 22.5 或宿主改了格式），速度退回按日志时间戳估算并在界面标注「估算」，首字延迟显示「—」。
- **合计**：本次读取到的当前会话及其衍生子代理会话的 Input、Cache、Output Token 累加值，并单独展示子代理汇总。
- **等价 API**：按每次调用实际使用的模型与官方按量公开费率（USD / 1M tokens，含 200K/100K 阶梯价与限时优惠截止切换），逐次累加计算当前会话（含子代理）与最近一次调用的等价 API 费用，并展示输入、缓存、输出与子代理分项。模型标识优先取自 `gen_metadata` 的 `response_model` 与 `model_display_name`，兜底取模型枚举（`pricing.mjs`）。
- **全会话汇总**：跨所有本地会话（含全部子代理）按新版统一双额度池（**Gemini**：Neon / Carbon / Hydrogen / Argon 等全部 Gemini 模型共享；**Claude / GPT**：Claude 与 GPT-OSS 独立池）汇总用量和等价 API 费用（`aggregate.mjs`）。适配 **Google AI Pro** 与 **Google AI Ultra** 的「5 小时短周期 + 7 天周限额」双窗口机制，以及 **Free / Plus** 的「仅 7 天周限额」模式；各池均按「首次调用才开始计时」滚动并支持按已用/距刷新时间校准及额外重置，另提供可自定义每月起算时刻的「本月」汇总，配置由后端持久化并自动迁移旧版设置（`settings.mjs`）。
- **会话选择**：默认跟随宿主当前打开的会话（宿主未提供会话 ID 或该会话尚无日志时，退回最近修改的会话）；也可在下拉框中按工作区手动选择。标题、工作区来自各数据目录下的 `conversation_summaries.db`（只读，需 Node 22.5+ 内置的 `node:sqlite`；不可用时退回标注文件标题），子代理会话不在下拉列表中显示。

日志路径：`~/.gemini/antigravity/brain/`，兼容 `antigravity2`、`antigravity-ide`、`antigravity-cli`。优先读取轻量 `transcript.jsonl`，找不到时读取 `transcript_full.jsonl`，只扫描单文件尾部最多 8 MiB。长会话的合计统计可能只覆盖最新部分。

## 隐私与兼容

- 仅读取本地会话文件，不发送网络请求，不读取密钥或修改会话；唯一写入的是插件自己的设置文件 `~/.gemini/antigravity/plugin_data/agy-context-speed/settings.json`。
- Electron 应用的签名、资源与更新程序保持原样。
- 适用于支持 Sidecar UI 的 Antigravity App 2.22+；这是 AGY App 原生插件，**不是** VS Code 的 `.vsix` 扩展。
- 当前构建已通过本地自动化测试。仍需在真实 AGY App 上验证面板注册与各模型的日志字段。

## 结构

`plugin.json`：AGY 插件元数据；`sidecars/monitor/sidecar.json`：原生辅助面板；`sidecars/monitor/metrics.mjs`：只读 JSONL 解析；`sidecars/monitor/pricing.mjs`：等价 API 费率与成本计算；`sidecars/monitor/aggregate.mjs`：跨会话双池双周期汇总；`sidecars/monitor/summaries.mjs`：只读会话摘要库；`sidecars/monitor/calls.mjs`：只读调用记录；`sidecars/monitor/sqlite.mjs`：带缓存的只读查询；`sidecars/monitor/settings.mjs`：预设上限与订阅/双周期设置持久化；`sidecars/monitor/main.mjs`：Sidecar 后端；`sidecars/monitor/{index.html,styles.css,app.js,windows-ui.js}`：UI。
