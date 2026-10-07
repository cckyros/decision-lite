# decision-lite

[English](README.md)

一个与 Jev 兼容的决策层，以 MCP server 形式提供——用可插拔的模型后端替代 TypeSafe 的专有模型。

TypeSafe 的 Jev 是一个「System One」模型：接收类型化问题（`noul` / `choice` / `score`），返回概率分布和置信度，约 100ms 内完成，用于路由、升级、门控。它闭源、需要 waitlist、按次计费。**decision-lite 复刻的是公开契约和工作流——不是模型本身。**

## 后端

| `DECISION_BACKEND` | 引擎 | 成本 | 置信度来源 |
|---|---|---|---|
| `needle` **（默认）** | [cactus-needle](https://github.com/cactus-compute/needle)——Needle 3，121M 本地模型，约 30MB 引擎，首次下载后完全离线 | **免费** | 学习得到的校准 head（真实分数，不是 margin） |
| `laya` | [Laya](https://github.com/convaiinnovations/laya)——非自回归决策模型；一次前向传播给所有选项打分，多语言 checkpoint 能读中文 | **免费**（本地；多语言 checkpoint 约 643MB，torch CPU） | 真实的逐选项分布 + 温度缩放的 `answer_confidence` |
| `openai` | 任意 OpenAI 兼容 chat 端点——GLM-5.3-Flash（约 ¥0.5/M）、DeepSeek、Ollama | 按服务商计价 | 模型自报分布、多次投票频率、或 token logprobs |

## 能做什么 / 不能做什么

| | |
|---|---|
| ✅ 与 Jev 相同的请求/响应契约 | `state` + 类型化 `questions` → `answers`（含概率 + confidence） |
| ✅ 可插拔后端 | 默认本地 Needle 3；`DECISION_BACKEND=openai` 走任意 OpenAI 兼容端点 |
| ✅ 三种 OpenAI 模式 | `verbalized`（自报分布）/ `sampling`（经验投票）/ `logprobs`（首 token 选项概率，需端点支持） |
| ✅ 校准追踪 | 每次决策都落日志；事后补录 ground truth；`decision_stats` 报告置信度 vs 实际准确率 |
| ❌ 不复刻 Jev 内部实现 | Jev 的架构未公开。没有公开论文、权重或训练细节，decision-lite 不声称相反结论 |
| ❌ 开箱并不校准 | Needle 的 confidence 是学习 head（英文校准；实测非英文不可靠）。OpenAI 模式的概率是模型的*观点*。校准要靠记录真实结果挣出来——这一点和 Jev 一样，只是 Jev 的重校准在它的黑盒里 |

## 契约

```jsonc
// 请求
{
  "state": "customer email text or a JSON object",
  "questions": {
    "is_urgent":  { "type": "noul",   "instructions": "needs reply within 1h?",
                    "criteria": { "true": "yes", "false": "no" } },
    "department": { "type": "choice", "instructions": "route to which team",
                    "criteria": { "billing": "invoices/refunds", "technical": "bugs/how-to" } },
    "risk_level": { "type": "score",  "instructions": "customer anger level",
                    "criteria": ["calm", "frustrated", "very angry"] }
  }
}
```

```jsonc
// 响应
{
  "model": "glm-5.3-flash",
  "mode": "verbalized",
  "decision_id": "…uuid…",
  "answers": {
    "is_urgent":  { "type": "noul", "noul": 0.95,
                    "confidence": 0.9, "probabilities": { "true": 0.95, "false": 0.05 } },
    "department": { "type": "choice", "choice": "billing", "confidence": 0.74,
                    "probabilities": { "billing": 0.87, "technical": 0.13 } },
    "risk_level": { "type": "score", "score": 1.04, "confidence": 0.92,
                    "legend": { "0": "calm", "1": "frustrated", "2": "very angry" },
                    "probabilities": { "0": 0, "1": 0.96, "2": 0.04 } }
  },
  "usage": { "prompt_tokens": 412, "completion_tokens": 68 }
}
```

**Confidence 是 margin，不是正确率**——语义与 Jev 相同：`noul` → `|p − 0.5| × 2`；`choice`/`score` → top-1 减 top-2 概率。自信的错误答案依然是错的，这就是 `record_outcome` 存在的原因。

## 模式

### needle 后端（默认）——免费、本地、校准 head

每道题作为单 tool 调用发给常驻的 [cactus-needle](https://github.com/cactus-compute/needle) 桥接进程；Needle 的字节级语法把 `answer` 参数约束在枚举内，它的学习 head 返回 `confidence`。一个约 121M 的模型只占约 30MB 内存，零 API 成本。

实测发现的坑（值得了解）：

- **判断类调用落在 `suppressed_calls` 里**：Needle 的 grounding gate 会扣留参数不是文本字面 span 的调用——也就是几乎每道 noul/choice/score 判断题。decision-lite 照样使用被扣留的答案（标记 `meta.suppressed: true`）；返回的 confidence 是真实 head 分数。
- **分布是合成的**：Needle 只给 top-answer + 标量 confidence，不给分布。decision-lite 设 `P(chosen) = max(c, 1/n)` 再平摊其余——够排序和门控用，但不是真后验。
- **非英文输入**：Cactus 实测非英文正确调用的 confidence 为 0.0。任何非 ASCII 的 state 或 question，Needle 答案都带 `meta.confidence_unreliable: true`——分数照返但不可信。中文 state 请用 `DECISION_BACKEND=laya` 或 `openai`。
- 首次运行从 Hugging Face 下载引擎（约 30MB）。huggingface.co 不可达时设 `HF_ENDPOINT=https://hf-mirror.com`。`DECISION_NEEDLE_GENERATION=2` 选旧的 45M 模型。

### laya 后端——训练型决策模型，多语言

`DECISION_BACKEND=laya` 会拉起 `python/laya_bridge.py`（与 needle 桥同一套 JSONL 协议），包装 [`laya`](https://pypi.org/project/laya/) 的 `Router`。与其他后端不同，laya 返回**真实的逐选项概率分布**——ModernBERT encoder 给每个选项放一个 `[MASK]`，一次前向传播给全部选项打分——另外返回 `answer_confidence`（max-p，laya 校准温度时针对的量）和基于熵的 confidence。非拉丁文字（如中文 state）自动路由到 `multilingual` checkpoint，因此没有 needle 的 `confidence_unreliable` 警告。需要 `pip install laya`（会带 torch，约 2.5GB）和首次约 643MB 的 checkpoint 下载。`DECISION_LAYA_MODEL=english|multilingual` 可钉住某个 checkpoint，替代按文字路由。

运行时选择 laya 后端后，会在后台让桥接进程预加载 checkpoint——对所有已注册 checkpoint 执行 `Router.preload()`（钉住 model 时只预热那一个）——首个 `evaluate` 不用等每个 checkpoint 约 10 秒的冷构建。代价是即使不调 `evaluate`，server 启动也会拉起 python 桥；设 `DECISION_LAYA_WARMUP=0` 可恢复懒加载。预热失败不致命（stderr 记一笔，照旧懒加载）。

### openai 后端——`verbalized` / `sampling` / `logprobs`

- `verbalized`（默认）：一次 `evaluate` 一次调用——模型输出全部问题的 JSON 概率。概率是**模型的自报观点**——弱模型会系统性过度自信。
- `sampling`：每题按 `DECISION_SAMPLES`（默认 7）次独立投票，温度 `DECISION_TEMPERATURE`（默认 0.8）；分布 = 观测到的投票频率。无效样本丢弃并计入报告（`samples.requested/valid/invalid`）。比 verbalized 偏差小，但仍不算校准——稳定答错的模型每次都投错。
- `logprobs`：每题一次低温调用，请求 `logprobs=true` + `top_logprobs=20`。选项映射为单 token 编码（`A`–`T`）；返回的 token log 概率取指数后在合法选项上归一化，规避多 token 选项标签偏差。这是对编码的真实 next-token 分布，**不是**校准过的正确率。需要返回 chat-completion logprobs 的端点；Ollama 0.32.9 已验证支持。选项超过 20 个、或端点的 top 候选里缺任一选项编码时，decision-lite 回退到 sampling 并报 `meta.distribution: "sampling_fallback"`。HTTP 错误（含不支持的请求字段）直接抛出而不是隐藏。Qwen3 模型名自动附带 `reasoning_effort: "none"`，避免 thinking token 吃掉短回答预算。

## 安装

```bash
pip install cactus-needle   # 默认后端（Python >=3.9）
npm install
npm start                   # stdio MCP server
```

### 使用 Ollama 本地 Qwen3

```powershell
ollama pull qwen3:0.6b
$env:DECISION_BACKEND = "openai"
$env:DECISION_BASE_URL = "http://127.0.0.1:11434/v1"
$env:DECISION_MODEL = "qwen3:0.6b"
$env:DECISION_MODE = "logprobs"  # 也支持 verbalized 或 sampling
npm start
```

Needle 的非英文 confidence 不可靠；中文输入建议用上面的 OpenAI 兼容后端或 `laya`。`logprobs` 一般比多次 sampling 省调用，也避免让小模型自报概率，但只适用于确实返回 `top_logprobs` 的本地服务；需要兼容时改用 `verbalized`，或用 `sampling` 观察多次回答的一致性。

## 多平台 MCP 与插件安装

构建可移植包、查看目标清单，然后只安装需要的客户端：

```powershell
npm run build
node src/cli.mjs list-targets
node src/cli.mjs install --target claude,cursor --scope project --dry-run
node src/cli.mjs install --target claude --scope project
node src/cli.mjs uninstall --target claude --scope project
```

安装器暴露 22 个目标：原生 MCP 配置（Claude Code、Codex、OpenCode、Qwen Code、Reasonix、Kilo、WorkBuddy、Devin）；skill 目标（Trae、pi、OMP、DSH）；以及 Agent Plugin 目标（Copilot、Cursor、Kiro、OpenClaw、Hermes、VS Code、ChatGPT/Codex、Grok、NanoClaw 及其他兼容客户端）。`--target all --dry-run` 可预览所有适配器。JSON/TOML 配置修改是带备份的 key 级合并；无法解析或有冲突的用户条目原样保留并报告为 manual。

OpenClaw 和 DSH 另有原生插件导出，与 stdio MCP server 共用同一运行时。部分 GUI/闭源客户端只支持手动注册，适配器会如实报告而不是猜测。包尚未发布到 npm（registry 查询返回 404）：本地安装指向 `.decision-lite/plugin` 下的构建产物；生成的 `mcp.json` 用 `npx -y decision-lite mcp`，供发布后使用。安装器不保存 `DECISION_API_KEY`；需要时直接写进宿主的 MCP env。`uninstall --purge-config` 要求 `--target all`，且只在所有适配器确认干净卸载后，才删除带 decision-lite 标记的包文件。

### MCP client 配置

任何支持 stdio 的 MCP client 注册方式相同：

```jsonc
// 发布到 npm 之后
"decision-lite": {
  "command": "npx",
  "args": ["-y", "decision-lite", "mcp"]
}

// 源码目录直接运行——或要指定后端/模型时：
"decision-lite": {
  "command": "node",
  "args": ["<仓库路径>/src/index.mjs"],
  "env": {
    "DECISION_BACKEND": "openai",
    "DECISION_BASE_URL": "https://open.bigmodel.cn/api/paas/v4",
    "DECISION_API_KEY": "your-key",
    "DECISION_MODEL": "glm-5.3-flash",
    "DECISION_MODE": "verbalized"
  }
}
```

配置走环境变量：

| 变量 | 默认 | 含义 |
|---|---|---|
| `DECISION_BACKEND` | `needle` | `needle` \| `laya` \| `openai` |
| `DECISION_PYTHON` | `python` | needle/laya 桥用的 python 可执行文件 |
| `DECISION_NEEDLE_GENERATION` | `3` | needle 模型代际（3=121M，2=45M） |
| `DECISION_LAYA_MODEL` | auto | 钉住 `english` 或 `multilingual` laya checkpoint |
| `DECISION_LAYA_WARMUP` | `1` | server 启动时预加载 laya checkpoint（`0`/`off` 关闭） |
| `DECISION_BASE_URL` | `http://127.0.0.1:11434/v1` | OpenAI 兼容端点（openai 后端） |
| `DECISION_API_KEY` | 空 | bearer key（本地可不设） |
| `DECISION_MODEL` | `qwen3.5-4b` | 模型名（openai 后端） |
| `DECISION_MODE` | `verbalized` | `verbalized` \| `sampling` \| `logprobs`（openai 后端） |
| `DECISION_SAMPLES` | `7` | sampling 模式每题投票数 |
| `DECISION_TEMPERATURE` | `0.8` | sampling 温度 |
| `DECISION_LOG` | `./decisions.jsonl` | 追加式决策日志 |

## 条件驱动的问题输入

可选的 `conditions` v1 块把策略显式化，同时保持原有 Jev 答案形状：

```json
{
  "type": "noul",
  "instructions": "Should this be prioritized?",
  "criteria": { "true": "priority required", "false": "normal queue" },
  "conditions": {
    "version": 1,
    "facts": {
      "deadline": {
        "type": "choice",
        "instructions": "Classify the explicitly stated deadline.",
        "criteria": { "within_hour": "within one hour", "later": "later or unstated" }
      }
    },
    "rules": [
      { "id": "near-deadline", "when": [{ "fact": "deadline", "op": "eq", "value": "within_hour" }], "then": "true" }
    ],
    "default": "false"
  }
}
```

Fact 复用 `noul`、`choice`、`score`。Rule 列表是 OR、单个 `when` 数组内是 AND、首个命中的 rule 生效。支持操作符：`eq`、`neq`、`in`、`not_in`；score fact 支持数值比较。`default` 必填且必须是合法输出选项。这个版本标准化发给模型的问题；不在本地执行规则，也不改变 confidence/概率的产生方式。不内置任何紧急度或风险阈值。

### MCP 工具

| 工具 | 输入 | 输出 |
|---|---|---|
| `evaluate` | `{state, questions}` | Jev 形状 `{answers, usage, decision_id}` |
| `record_outcome` | `{decision_id, outcome, note?}` | `outcome`：对所有答案统一 `true/false`，或按题 `{qid: bool}` |
| `decision_stats` | `{}` | 置信度分桶 vs 观测准确率 |

### Conditions 输入 v1

要表达哪些事实应导致什么结果，给问题加可选的 `conditions` 表。它复用 Jev 问题类型定义事实，再把事实组合映射到该问题已有的输出选项：

```json
{
  "type": "noul",
  "instructions": "Should this be prioritized?",
  "criteria": { "true": "priority required", "false": "normal queue" },
  "conditions": {
    "version": 1,
    "facts": {
      "deadline": {
        "type": "choice",
        "instructions": "Classify the deadline.",
        "criteria": { "within_hour": "explicitly within one hour", "later": "later or no deadline" }
      },
      "active_harm": {
        "type": "noul",
        "instructions": "Is financial, account-security, health, or physical harm happening now?",
        "criteria": { "true": "active harm", "false": "no active harm" }
      }
    },
    "rules": [
      { "id": "near-deadline", "when": [{ "fact": "deadline", "op": "eq", "value": "within_hour" }], "then": "true" },
      { "id": "active-harm", "when": [{ "fact": "active_harm", "op": "eq", "value": "true" }], "then": "true" }
    ],
    "default": "false"
  }
}
```

Rule 按数组顺序求值；每条 rule 的全部子句都命中才算命中，首个命中者生效；多条 rule 表达 OR。支持 `eq`、`neq`、`in`、`not_in`，score fact 另有 `lt/lte/gt/gte`。`default` 必须是该问题的输出选项之一。配置的后端负责抽取类型化事实，Decision Lite 在本地应用规则。输出概率在独立性假设下由事实分布组合而成；`meta.conditions` 记录事实分布、规则命中质量和 default 质量。事实缺失、均匀分布、或标记 confidence 不可靠时使用声明的 default。事实-选项组合上限 4096。这让策略应用显式化，但不校准模型的事实抽取质量或结果概率。不内置业务阈值，按领域自行定义。

校准闭环：`evaluate` → 拿到 `decision_id` → ground truth 明确后 `record_outcome` → `decision_stats` 展示「confidence 0.9」的答案是否真有约 90% 正确。差距大就提高阈值或换后端/模式。

### eval harness

`node src/cli.mjs eval --dataset fixtures/eval_zh_triage.json` 把带标注的 fixture 跑过配置的后端，报告 accuracy、期望校准误差（ECE）、平均 confidence、延迟（mean/p50/p95）及分题统计。报告带 dataset hash，两次运行可比。10 例中文分诊 fixture 上 `qwen3:0.6b` + `logprobs` 基线：accuracy 0.43、ECE 0.50、meanConf 0.94——小手标集，不是 benchmark；用于比较后端/prompt，不要拿来宣称生产准确率。

指标口径：score 题的正确性用期望等级指数的 `Math.round(answer.score)` 对比标注（符合 Jev 契约，非 argmax）；「confidence」统一取分布里的最大概率（跨后端口径一致，不是 Jev `confidence` 字段）。`--compare baseline.json` 把当前报告与基线对比：identity 不匹配（不同 dataset/schema）或 accuracy 回退超过 `--tolerance` 时 exit 1。单例后端错误记为 `overall.errors` 并继续跑。

## 已知限制

- **Confidence ≠ 正确率。** 没有任何后端保证校准；只有记录的真实结果说明真相。
- **Needle 的 confidence 是英文校准的**——Cactus 实测非英文正确调用为 0.0。中文 state 用 laya 或 openai 后端，或忽略该分数。
- **Needle 是判断工具，不是文章评审**——选选项很稳，但不会解释原因。121M 模型不会推理，别问它多因素权衡。
- **合成分布**：needle 模式报一个答案 + 标量 confidence；概率分布是构造的，不是测量的。
- **sampling 模式仍不算校准**——它反映模型自洽性，不是真实世界准确率。
- 小/本地模型可能输出解析不了的垃圾；无效样本在 sampling 中计数丢弃，或在 verbalized 中触发按题回退。

## 仓库结构

```
src/contract.mjs        问题校验、分布归一化、Jev 形状答案、margin confidence
src/backend.mjs         OpenAI 兼容客户端；verbalized、sampling、logprobs 模式
src/needle-backend.mjs  Needle 3 后端——拉起 python 桥，JSONL 协议
src/laya-backend.mjs    Laya 后端——训练型决策模型，真实分布
src/eval.mjs            eval harness：JSON fixture 上的 accuracy/ECE/延迟
src/runtime.mjs         MCP、OpenClaw、DSH 共用的 handler
src/installer.mjs       22 个目标适配器的 CLI 分发
src/targets.mjs         原生 MCP、skill、Agent Plugin 安装器
python/needle_bridge.py cactus-needle 包装（每题一个 agent）
python/laya_bridge.py   laya Router 包装（按文字自动路由 checkpoint）
src/log.mjs             追加式 JSONL 决策日志 + 校准统计
src/index.mjs           MCP stdio server
build.mjs               打包 CLI/原生插件并生成身份文件
```

`npm test` 跑离线 `node:test` 套件，含 fake-home 安装器 dry-run 和配置往返测试，测试前会先构建可移植插件包。`node fixtures/e2e_needle.mjs` 是 Needle 3 的真实端到端（首次运行下载引擎）；`node fixtures/e2e_mcp.mjs` 通过 stdio 对构建产物做完整 JSON-RPC 冒烟。

## 诚实的参考

- TypeSafe Jev 发布文：https://typesafe.ai/blog/introducing-system-one-models-and-jev
- Jev 请求/响应契约：https://developers.cloudflare.com/ai/models/typesafe/jev/ ，https://docs.typesafe.ai
- 截至写作时没有公开的 Jev 官方论文或可复现架构。第三方 RLCD 分析存在，但属于逆向工程而非规格。

## License

[MIT](LICENSE)
