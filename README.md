# qoder-transfer

一个**独立的中转站服务**，把 [Qoder](https://qoder.com) 的大模型能力以 **OpenAI 兼容 API** 的形式提供给任何 AI agent / 客户端。

它把 `pi-provider-qoder` 中逆向并验证过的私有接口逻辑（PAT 换 Job Token、COSY 签名、WAF 请求体编码、SSE 信封解析、thinking 抽取）抽取为一个**零运行时依赖**的 Node.js HTTP 服务，不依赖 pi / OMP 宿主。

> ⚠️ 本项目调用的是 Qoder 官方客户端使用的**内部接口**（逆向整理，非公开契约），随时可能变更。请以真实响应为准，并遵守 Qoder 的服务条款。

---

## 特性

- **OpenAI 兼容**：提供 `GET /v1/models` 与 `POST /v1/chat/completions`（支持流式与非流式）。
- **完整认证链路**：PAT(`pt-...`) → Job Token(`jt-...`) 自动交换，并用 Job Refresh Token(`jrt-...`) 自动续期；被拒绝时自动回退重新交换。
- **COSY 签名**：完整复刻 `Authorization: Bearer COSY.*`、`Cosy-*` 头（RSA / AES-128-CBC / MD5）。
- **WAF 绕过**：聊天请求体自动执行 `Encode=1` 编码。
- **动态模型目录**：从 `/algo/api/v2/model/list` 拉取并缓存，附带静态兜底与友好别名（如 `qwen3.7-plus`）。
- **推理内容**：透传 `reasoning_content`，客户端可展示思考过程。
- **工具调用**：透传 OpenAI `tools` / `tool_calls`，支持 agent 工具循环。
- **区域与 VPC**：支持 Global、CN 公有云、以及 CN 企业 VPC（实例名 → 派生 `-gateway` / `-openapi` 主机）。
- **零运行时依赖**：仅使用 Node 内置模块（`node:http`、`node:crypto`、全局 `fetch`）。

---

## 快速开始

### 1. 安装

全局安装：

```bash
npm install -g qoder-transfer
```

或用 npx 直接运行：

```bash
npx qoder-transfer --help
```

从源码构建：

```bash
npm install
npm run build
```

需要 Node.js >= 20。

### 2. 配置

可通过**环境变量**或**命令行参数**配置，两者同时提供时**命令行参数优先**。

环境变量（推荐用于 Docker / systemd / CI，避免密钥出现在进程列表中）：

```bash
export QODER_PAT=pt-xxxxxxxx
```

命令行参数：

```bash
qoder-transfer --pat pt-xxxxxxxx --port 8787
```

最少只需一个上游 PAT（`--pat` 或 `QODER_PAT`）。

### 3. 运行

```bash
# 全局安装后
qoder-transfer --pat pt-xxxxxxxx

# 本地
npm start
node dist/index.js
```

`--help` 列出全部参数，`--version` 显示版本。

开发模式（热重载）：

```bash
npm run dev
```

默认监听 `http://127.0.0.1:8787`。

---

## 配置项

优先级：**命令行参数 > 环境变量 > 默认值**。

| 命令行参数 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--pat <token>` | `QODER_PAT` / `QODER_PERSONAL_ACCESS_TOKEN` | — | **必填**。Global 或 CN 的 PAT（`pt-...`）。 |
| — | `QODERCN_PAT` / `QODERCN_PERSONAL_ACCESS_TOKEN` | — | CN PAT；提供时自动按 CN 区域处理。 |
| — | `QODER_API_KEY` | — | 仅当值以 `pt-` 开头时作为 PAT 别名。 |
| `--mode <global>` 或 `<cn>` | `QODER_MODE` / `QODER_REGION` / `QODER_BACKEND` | 自动推断 | 区域。 |
| `--vpc <instance>` | `QODER_VPC_INSTANCE` | — | CN 企业 VPC 实例名（如 `xxx-of-enterprise`），自动派生 `-gateway` / `-openapi` 主机。 |
| `--api-key <key>` | `RELAY_API_KEY` | 空 | 客户端访问密钥。为空则不校验鉴权。 |
| `--host <addr>` | `HOST` | `127.0.0.1` | 监听地址。 |
| `-p, --port <port>` | `PORT` | `8787` | 监听端口。 |
| `--default-model <id>` | `QODER_DEFAULT_MODEL` | `auto` | 请求未带 `model` 时的默认模型。 |
| `--model-cache-ttl <ms>` | `QODER_MODEL_CACHE_TTL_MS` | `3600000` | 模型目录缓存时间（毫秒）。 |
| `--request-timeout <ms>` | `QODER_REQUEST_TIMEOUT_MS` | `600000` | 单次请求总时长上限（毫秒）。 |
| `--log-level <level>` | `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`。 |
| `--cosy-debug` | `QODER_COSY_DEBUG` | 关闭 | 打印非敏感 COSY 诊断（URL / 状态 / 哈希）。 |

CN 基址也可用 `QODER_CN_BASE_URL` / `QODER_CN_OPENAPI_URL` 覆盖（主要用于自定义部署与测试）。

---

## API

### `GET /v1/models`

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $RELAY_API_KEY"
```

### `POST /v1/chat/completions`（非流式）

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $RELAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "用一句话介绍你自己"}]
  }'
```

### `POST /v1/chat/completions`（流式）

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $RELAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-plus",
    "stream": true,
    "messages": [{"role": "user", "content": "写一个快排"}]
  }'
```

请求/响应遵循 OpenAI Chat Completions 结构；流式使用 `text/event-stream`，以 `data: [DONE]` 结束。推理增量在 `delta.reasoning_content`，工具调用在 `delta.tool_calls`。

### `GET /health`

无需鉴权，返回服务状态。

---

## 接入 AI agent

任何支持自定义 OpenAI Base URL 的客户端都可以接入：

| 配置 | 值 |
| --- | --- |
| Base URL | `http://<host>:8787/v1` |
| API Key | `RELAY_API_KEY` 的值（如未设置可任意填） |
| Model | `auto` 或任意目录内模型 id |

例如：

```bash
# 通用 OpenAI SDK
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=$RELAY_API_KEY
```

---

## 模型

`GET /v1/models` 只宣传**友好别名**（外加默认的 `auto`），**不暴露上游 wire key**。`auto` 与任意已知 wire key 仍可直接调用，服务端会自动解析回真实 key。

| 别名（`/v1/models` 中的 id） | 上游 wire key |
| --- | --- |
| `auto` | `auto`（默认模型） |
| `qwen3.7-max` | `qmodel_latest` |
| `qwen3.7-plus` / `qwen3.6-plus` | `qmodel` |
| `qwen3.6-flash` | `q36fmodel`（该 key 存在时） |
| `deepseek-v4-pro` | `dmodel` |
| `deepseek-v4-flash` | `dfmodel` |
| `glm-5.2` / `glm-5.1` | `gm51model` |
| `kimi-k2.6` | `kmodel` |
| `minimax-m2.7` / `minimax-m3` | `mmodel` |

---

## 区域与 VPC

| 用途 | Global | CN 公有云 | CN 企业 VPC |
| --- | --- | --- | --- |
| Gateway | `https://api3.qoder.sh/` | `https://gateway.qoder.com.cn/` | `https://<inst>-gateway.vpc.qoder.com.cn/` |
| OpenAPI | `https://openapi.qoder.sh` | `https://openapi.qoder.com.cn` | `https://<inst>-openapi.vpc.qoder.com.cn` |

- VPC 场景请使用**该租户签发**的 PAT（`https://<inst>.vpc.qoder.com.cn/account/integrations`）。
- `<inst>.vpc.qoder.com.cn` 是**租户面板**而非 API 主机，直接打它做 exchange/COSY 会返回 `CSRFInvalid`。
- 遇到 `CSRFInvalid` 或 `open_access_token not found` 时，开启 `QODER_COSY_DEBUG=1` 并核对 `QODER_VPC_INSTANCE` 与 PAT 归属。

---

## 安全说明

- PAT 可通过 `--pat` 参数或 `QODER_PAT` 环境变量提供，**不会**写入日志；日志中的 `pt-` / `jt-` / `jrt-` 与 `Authorization` 会被脱敏。
- 通过 `--pat` 传参时令牌可能被同机其它用户经进程列表（`ps`）看到；多用户 / 共享环境建议改用环境变量。
- 建议设置 `RELAY_API_KEY` 并在内网 / 反向代理后运行；默认仅监听 `127.0.0.1`。
- 该服务代表上游账号发起请求，请妥善保管访问密钥，避免公开暴露。

---

## 架构

```text
src/
├── index.ts            # 入口：解析参数、加载配置、启动服务、优雅关闭
├── cli.ts              # 命令行参数解析与帮助文本
├── config.ts           # 配置解析（CLI > 环境变量 > 默认）
├── version.ts          # 构建时注入的版本号
├── logger.ts           # 轻量分级日志
├── server.ts           # HTTP 服务、路由、鉴权、OpenAI SSE 输出
├── openai/
│   ├── types.ts        # OpenAI 请求/响应类型
│   └── sse.ts          # SSE 行与分块构造
└── qoder/
    ├── cosy.ts         # COSY 签名、端点解析、错误格式化、脱敏
    ├── encoding.ts     # WAF 请求体编码（Encode=1）
    ├── auth.ts         # PAT → Job Token 交换、jrt 续期、身份解析
    ├── models.ts       # 动态模型目录 + 别名解析
    ├── transform.ts    # OpenAI ↔ Qoder 消息转换
    └── chat.ts         # 聊天流：组包、签名、SSE 解析、事件归一化
```

---

## 开发

```bash
npm run check   # 类型检查
npm run lint    # Biome 检查
npm test        # 运行测试（含 mock 上游的集成测试）
npm run build   # 打包到 dist/index.js
```

---

## Docker

```bash
docker build -t qoder-transfer .
docker run --rm -p 8787:8787 -e QODER_PAT=pt-xxx -e RELAY_API_KEY=secret qoder-transfer
```

---

## 发布

通过 GitHub Actions 自动发布到 npm，工作流见 [`.github/workflows/publish.yml`](.github/workflows/publish.yml)。

### 一次性准备

1. **替换仓库占位符**：把 `package.json` 与 `README.md` 中的 `OWNER` 改成你的 GitHub 用户名 / 组织名。
2. **配置 npm 令牌**：在 <https://www.npmjs.com/settings/~/tokens> 生成一个 **Automation** 类型的 Access Token，然后在 GitHub 仓库的 `Settings → Secrets and variables → Actions` 新增名为 **`NPM_TOKEN`** 的 secret。
3. 确认 `package.json` 的 `name`（`qoder-transfer`）在 npm 上可用，或改用作用域名（如 `@you/qoder-transfer`）。

### 发布流程

```bash
# 1. 升版本（会自动创建 commit 与 v 标签）
npm version patch   # 或 minor / major

# 2. 推送提交与标签
git push origin main --follow-tags
```

然后在 GitHub 上基于该标签创建并 **发布 Release**（标签须为 `vX.Y.Z`，与 `package.json` 版本一致，工作流会校验）。`release: published` 事件触发 `Publish` 工作流，依次执行类型检查、Lint、测试、构建，并以 `--provenance` 发布到 npm。也可在 `Actions → Publish → Run workflow` 手动触发。

### 约定与说明

- Git 标签格式 `vX.Y.Z` 必须与 `package.json` 的 `version` 完全一致。
- 发布使用 npm provenance（`id-token: write` + `--provenance`），需仓库为 **public**；若为私有仓库，请从工作流中移除 `--provenance`。
- 也可改用 npm **Trusted Publishing（OIDC）**：在 npm 包设置中绑定本仓库与 `publish.yml`，即可无需 `NPM_TOKEN`。

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 在 push 到 `main` 及所有 PR 上运行类型检查、Lint、测试与构建（Node 20 / 22 矩阵）。

---

## License

MIT
