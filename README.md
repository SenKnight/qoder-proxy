# qoder-transfer

一个**独立的中转站服务**，把 [Qoder](https://qoder.com) 的大模型能力以 **OpenAI 兼容 API** 的形式提供给任何 AI agent / 客户端。
灵感源自 [minglu6/pi-provider-qoder](https://github.com/minglu6/pi-provider-qoder)


> ⚠️ 本项目调用的是 Qoder 官方客户端使用的**内部接口**（逆向整理，非公开契约），随时可能变更。请以真实响应为准，并遵守 Qoder 的服务条款。

---

## 特性

- **OpenAI 兼容**：提供 `GET /v1/models` 与 `POST /v1/chat/completions`（支持流式与非流式）。
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

最少只需一个上游 PAT（`--pat` 或 `QODER_PAT`）。PAT 是 `pt-` 开头的字符串，需在 **Qoder 控制台的「账号集成」（Integrations）页面**创建，**仅在生成时显示一次，请立即保存**。请按你的部署形态到对应地址获取：

| 部署形态 | 获取 PAT 的地址 | 使用的配置项 |
| --- | --- | --- |
| 国际版（Global） | <https://qoder.com/account/integrations> | `--pat` / `QODER_PAT` |
| 中国版（CN） | <https://qoder.cn/account/integrations> | `QODERCN_PAT`（提供后自动按 CN 处理） |
| 中国版企业 VPC | `https://<实例名>.vpc.qoder.com.cn/account/integrations` | `QODERCN_PAT` + `QODER_VPC_INSTANCE=<实例名>` |

> 企业 VPC 必须使用**该租户自己的面板**签发的 PAT；用公网 PAT 会返回 `CSRFInvalid`，详见「区域与 VPC」。

客户端访问密钥（`--api-key` / `RELAY_API_KEY`）**默认是没有的**，此时服务端不校验鉴权；**强烈建议设置**一个强随机串，详见「接入 AI agent」。

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

## 接入 AI agent

任何支持自定义 OpenAI Base URL 的客户端都可以接入：

| 配置 | 值 |
| --- | --- |
| Base URL | `http://<host>:8787/v1` |
| API Key | `RELAY_API_KEY` 的值；**未设置时也必须随便填一个** |
| Model | `auto` 或任意目录内模型 id（带区域后缀或原别名均可，如 `auto · Qoder-CN`） |

例如：

```bash
# 通用 OpenAI SDK
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=$RELAY_API_KEY
```

> **⚠️ 关于访问密钥（API Key）**
>
> - **默认没有**：未设置 `RELAY_API_KEY` / `--api-key` 时，`auth_required` 为 `false`，服务端不校验，任何请求都放行。
> - **强烈建议设置**：用 `RELAY_API_KEY=<强随机串>`（或 `--api-key <强随机串>`），避免同机其他进程/用户直接调用本服务。
> - **配置提供商时必须填一个非空 API Key**：即使服务端没设密钥，也要在客户端里**随便填一个**（如 `sk-noauth`）。多数 agent / SDK 在 API Key 为空时会直接报「缺少 API key」而拒绝发送请求，导致接口调用失败（尽管服务端本身并不校验）。

---

## 配置项

优先级：**命令行参数 > 环境变量 > 默认值**。

| 命令行参数 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--pat <token>` | `QODER_PAT` / `QODER_PERSONAL_ACCESS_TOKEN` | — | **必填**。Global 或 CN 的 PAT（`pt-...`），获取地址见「2. 配置」。 |
| — | `QODERCN_PAT` / `QODERCN_PERSONAL_ACCESS_TOKEN` | — | CN PAT；提供时自动按 CN 区域处理。 |
| — | `QODER_API_KEY` | — | 仅当值以 `pt-` 开头时作为 PAT 别名。 |
| `--mode <global>` 或 `<cn>` | `QODER_MODE` / `QODER_REGION` / `QODER_BACKEND` | 自动推断 | 区域。 |
| `--vpc <instance>` | `QODER_VPC_INSTANCE` | — | CN 企业 VPC 实例名（如 `xxx-of-enterprise`），自动派生 `-gateway` / `-openapi` 主机。 |
| `--api-key <key>` | `RELAY_API_KEY` | 空 | 客户端访问密钥。**默认为空（不校验）**，强烈建议设为强随机串；详见「接入 AI agent」。 |
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

无需鉴权，返回服务状态：

```json
{"status":"ok","service":"qoder-transfer","version":"x.y.z","mode":"cn","auth_required":false,"default_model":"auto"}
```

`version` 为当前服务版本（启动日志的同名字段也会打印）；`auth_required` 为 `false` 表示未启用客户端鉴权。

---

## 模型

`GET /v1/models` **动态镜像上游模型目录**（`/algo/api/v2/model/list`）：上游每个启用模型都会出现，其 `id` 由上游 `display_name` 美化后（如 `Qwen3.7-Plus` → `Qwen 3.7-Plus`）再追加**区域后缀**——CN 为 ` · Qoder-CN`，Global 为 ` · Qoder`（默认模型 `Auto` 也带后缀）。命名规则与 pi-provider-qoder 的 `getQoderCNFriendlyModelInfo`（`prettifyQoderCNModelName`）保持一致。

上游原始 wire key 不对外暴露。调用 `POST /v1/chat/completions` 时，`model` 可写带后缀的 id（如 `Qwen 3.7-Plus · Qoder-CN`）、不含后缀的美化名，或已知的上游 wire key，服务端都会自动解析回真实 key。

> 下表为 CN 环境示例；id ↔ wire key 的对应随上游目录实时变化。

| `/v1/models` 中的 id（= 美化名 + 区域后缀） | 上游 wire key |
| --- | --- |
| `Auto` | `auto`（默认模型） |
| `Qwen 3.8-Max` | `qmodel_38max` |
| `Qwen 3.8-Flash` | `qfmodel` |
| `Qwen 3.7-Max` | `qmodel_latest` |
| `Qwen 3.7-Plus` | `qmodel` |
| `Qwen 3.7-Flash` | `q37fmodel` |
| `DeepSeek-V4-Pro` | `dmodel` |
| `DeepSeek-Flash` | `dfmodel` |
| `GLM-5.3` | `gmodel` |
| `GLM-5.3-Flash` | `gfmodel` |
| `GLM-5.2` | `gm51model` |
| `Kimi-K3` | `kmodel_latest` |
| `Kimi-K2.8-Preview` | `kmodel` |
| `MiniMax-M2.7` | `mmodel` |


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

通过 GitHub Actions 自动发布到 npm，工作流见 [`.github/workflows/release.yml`](.github/workflows/release.yml)。

### 一键发布（推荐）

```bash
npm run release            # 默认 patch；可传 minor / major
```

脚本会依次：校验工作区干净且位于 `main` → `check / lint / test / build` → `npm version <bump>` → `git push origin main --follow-tags`。

### 发布流程

**推送 `v*` 标签即会触发发布**：

```bash
# 1. 升版本（自动创建 commit 与 v 标签）
npm version patch   # 或 minor / major

# 2. 推送提交与标签（推送标签即触发 Release 工作流）
git push origin main --follow-tags
```

标签须为 `vX.Y.Z` 且与 `package.json` 的 `version` 一致（工作流会校验）。`push: tags: ["v*"]` 事件触发 `Release` 工作流，依次执行类型检查、Lint、测试、构建，然后**自动创建对应的 GitHub Release**，并以 `--provenance` 发布到 npm。

### 发布产物

每次运行 `Release` 会将构建产物同时：

- 作为 **workflow artifact** 上传（名 `qoder-transfer-<ref>`）；
- **挂载到对应的 GitHub Release**（不存在时自动创建），包括 `qoder-transfer-<version>.tgz`（npm 包）与 `dist/index.js`（独立 bundle）。

若版本已在 npm 上存在，`npm publish` 步骤会自动跳过（幂等）。

### 手动触发

在 `Actions → Release → Run workflow` 可手动运行，输入：

| 输入 | 类型 | 说明 |
| --- | --- | --- |
| `tag` | string | 将产物挂载到该 Release 标签（不存在时自动创建；用 `GITHUB_TOKEN` 创建，不会再次触发事件） |
| `publish` | boolean | 是否将当前版本发布到 npm（默认 `false`） |

### 约定与说明

- Git 标签格式 `vX.Y.Z` 必须与 `package.json` 的 `version` 完全一致。
- 发布使用 npm provenance（`id-token: write` + `--provenance`），需仓库为 **public**；若为私有仓库，请从工作流中移除 `--provenance`。
- 也可改用 npm **Trusted Publishing（OIDC）**：在 npm 包设置中绑定本仓库与 `release.yml`，即可无需 `NPM_TOKEN`。

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 在 push 到 `main` 及所有 PR 上运行类型检查、Lint、测试与构建（Node 20 / 22 矩阵）。

---

## License

MIT
