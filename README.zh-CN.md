# dsh-codex-bridge

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件包：让智能体读取本机 **Codex CLI** 的 ChatGPT 计划额度，并按当前余额选择模型与推理强度，把困难任务交给 `codex exec` 执行。

纯 Host 侧插件：两个工具，无浏览器半边、无构建步骤、无 npm 依赖。

> 非官方社区插件，与 OpenAI / Codex / DeepSeek 均无隶属或背书关系。

## 工具

| 工具 | 作用 | 消耗 Codex 额度 |
|---|---|---|
| `codex_status` | 读取 5 小时窗口、每周窗口、重置时间、credits、模型阶梯，以及按余额给出的推荐 | 否 |
| `codex_delegate` | 在指定目录运行一次非交互式 `codex exec`，返回答案、token 用量、thread id 和运行后的额度 | 是 |

`codex_status` 走 `codex app-server` 的 `account/rateLimits/read` 与 `model/list`；`codex_delegate` 才会真正调用模型。

## 额度策略

默认策略刻意收得很窄：

- **默认**：`gpt-6.1-sol`，推理强度 **`high`**。
- **保留档**：任一窗口剩余 **≤ 10%** 时，自动改用 `gpt-5.6-sol` + `medium`。
- **`gpt-6-astra`**：绝不自动选择。显式指定时还必须传 `allow_expensive_model: true`，因为它消耗共享额度的速度快得多。
- **地板**：模型永远不低于 `gpt-5.6-sol`，推理强度永远不低于 `medium`。
- **阻断**：已用 ≥ 95%，或后端禁止普通用量时拒绝运行；只有显式 `allow_low_quota: true` 才放行。

推荐表（`model=auto` + `reasoning_effort=auto`）：

| 复杂度 | 正常（两个窗口都 > 10% 剩余） | 保留档（任一窗口 ≤ 10% 剩余） |
|---|---|---|
| `simple` | `gpt-6.1-sol` / `medium` | `gpt-5.6-sol` / `medium` |
| `standard` | `gpt-6.1-sol` / `high` | `gpt-5.6-sol` / `medium` |
| `hard` | `gpt-6.1-sol` / `high` | `gpt-5.6-sol` / `medium` |
| `critical` | `gpt-6.1-sol` / `xhigh` | `gpt-5.6-sol` / `high` |

显式选择会被校验，但不会静默降级；拒绝时会给出可选的模型或缺失的开关。

### 关于 `gpt-6.1-sol`

本机 Codex CLI 的 `model/list` 可能不列出 `gpt-6.1-sol`，但后端可以接受（开发时已用真实 `codex exec` 验证）。`codex_status` 会把它标成 **configured** 模型，并提示 `codex exec` 可能打印缺少模型元数据的警告。如果你的账号使用别的模型 id，改 `defaultModel` / `minModel` 即可。

## 安装

在 DSH Web GUI 的 **插件** 页安装，或由智能体调用插件管理器：

```json
{ "action": "install_bundle", "target": "/path/to/dsh-codex-bridge" }
```

从 GitHub 安装（仓库发布后）：

```bash
dsh plugin --profile web add github:AK-blank/dsh-codex-bridge#v1.1.0
```

本地目录：

```bash
dsh plugin --profile web add /path/to/dsh-codex-bridge
dsh --profile web --dump-config | grep -A2 codex-bridge
```

如果宿主进程已经缓存过旧模块，安装后重启 `dsh web`。Host 侧插件代码按进程缓存：新增 bundle 行会实时激活，但修改 `lib/*.js` 后需要重启。

要求：DSH `0.2.0-rc.2`（实测版本）、Node.js 20+、已登录的 Codex CLI（`codex login`）。

## 配置

在 profile 的 `cordis.patch.yml` 覆盖插件行：

```yaml
- id: codex-bridge
  name: dsh-codex-bridge
  config:
    minModel: gpt-5.6-sol
    defaultModel: gpt-6.1-sol
    expensiveModel: gpt-6-astra
    minEffort: medium
    defaultEffort: high
    reservePercent: 10
    stopPercent: 95
    statusCacheSeconds: 30
    defaultSandbox: read-only
    ephemeral: true
    maxTimeoutSeconds: 1800
    maxOutputChars: 16000
    codexCommand: codex
    codexHome: ''
```

| 键 | 默认 | 说明 |
|---|---|---|
| `minModel` | `gpt-5.6-sol` | 模型地板与保留档回退 |
| `defaultModel` | `gpt-6.1-sol` | 正常默认（可不在 CLI 目录中） |
| `expensiveModel` | `gpt-6-astra` | 仅显式 opt-in |
| `minEffort` | `medium` | 最低推理强度 |
| `defaultEffort` | `high` | 普通/困难任务的推理强度 |
| `reservePercent` | `10` | 任一窗口剩余不超过该值时进入保留档 |
| `stopPercent` | `95` | 已用达到该值时阻断普通运行 |
| `statusCacheSeconds` | `30` | 额度快照缓存 |
| `defaultSandbox` | `read-only` | 默认沙箱 |
| `ephemeral` | `true` | 不把每次外派写进 `~/.codex/sessions` |
| `maxTimeoutSeconds` | `1800` | 单次外派硬上限 |
| `maxOutputChars` | `16000` | 回传模型的答案长度上限 |
| `codexCommand` | `codex` | 可执行文件名或绝对路径 |
| `codexHome` | 空 | 空 = 继承宿主环境 |

## 使用

对 DSH 说：

> 先看 Codex 额度，再用合适的模型和推理强度让 Codex 处理这个难题。

智能体会先调用 `codex_status`，选择 `complexity`（或显式 `model` / `reasoning_effort`），再调用 `codex_delegate`。`task` 必须自包含：Codex 看不到 DSH 会话，需要写清绝对路径、现象、约束和期望产物。

默认 `read-only`；只有明确要让 Codex 改文件时，才传 `sandbox: "workspace-write"` 和对应的 `cwd`。

## 验证

```bash
node selftest.mjs             # 离线：打包契约、策略、渲染、注册
node selftest.mjs --live      # 额外读取真实额度/模型阶梯，不消耗模型额度
node selftest.mjs --live-exec # 额外跑一次最小 codex exec（消耗少量额度）
```

离线套件覆盖额度分档、10% 保留切换、astra 开关、模型/强度地板、额度阻断、渲染和 bundle 注册契约；真实检查验证 `codex app-server` 返回值与配置阶梯。仓库的 GitHub Actions 每次 push 跑离线套件。

## 限制

- app-server 方法属于本机 Codex CLI 版本的一部分；不兼容的升级会以 `CODEX_RPC` / `CODEX_PROTOCOL` 失败，而不是编造数据。
- Codex 不共享本会话上下文。
- 默认 `read-only` 只能读 `cwd`；`workspace-write` 的写入以 `cwd` 为界，网络访问仍受 Codex 自身沙箱策略约束。
- 返回的额度是后端百分比快照，不是精确的 token 预留；分档只是消费护栏。
- `gpt-6.1-sol` 是否可用、模型元数据是否完整取决于 Codex CLI 版本与账号；可以改配置换成其他 id。

## 社区收录

`docs/awesome-entry.yml` 是给社区目录 [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 准备的条目（分类 `usage`）。该目录要求仓库创建满 1 天后才接受 PR，所以发布当天不会直接开 PR。仓库同时带 `dsh-plugin` topic，供自动索引器抓取。

## 许可

MIT，见 [LICENSE](LICENSE)。
