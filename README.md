# qmd-autosearch

自动补搜插件：当模型在知识库目录执行 `grep` / `glob` 搜索时，自动补充一次 QMD 语义检索，并把结果注入模型上下文。

DeepSeek Harness 插件（`dsh-plugin`）。零外部依赖。

## 功能

- **自动触发**：模型在 QMD 集合对应的目录内执行 `grep` / `glob`（顶层调用）即触发，无需显式调用
- **语义补搜**：QMD 单次查询（lex + vec，服务端 LLM 重排），检索范围限定在配置的 collections
- **智能查询词**：以最近的用户消息（任务要求）为语义主查询；消息过短或与搜索主题无关时，回退使用 grep pattern
- **异步注入**：结果排队到 `agent.inbox.nextStep`，下一个 pre-step 注入模型上下文，不阻塞当前工具调用
- **防重复**：同一 agent 内相同（工具、路径、pattern）签名只补搜一次
- **容错**：QMD 服务不可用或查询无结果时静默跳过，不影响原流程

## 工作原理

```
grep/glob 执行完成 → tools/result 钩子
  → 路径在触发范围内（由 QMD status 解析的集合路径）？
  → QMD query（collections 限定 + LLM 重排）
  → 结果排队 agent.inbox.nextStep
  → 下一个 pre-step 注入模型上下文（user 角色 system-reminder 风格）
```

## 安装

### 方式一：npm 安装（发布后可用）

```bash
dsh plugin --profile web add qmd-autosearch
```

### 方式二：本地路径引用（开发调试）

在 `~/.dsh/profiles/web/cordis.patch.yml` 的 insert 列表追加：

```yaml
- insert:
    - id: qmd-autosearch
      name: 'file:///path/to/qmd-autosearch/index.js'
      config:
        qmdUrl: http://localhost:6179/mcp
        collections:
          - knowledge-concepts-keynes
          - knowledge-principles-keynes
        limit: 5
        minScore: 25
```

## 配置

| 配置项 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `qmdUrl` | ✅ | 无 | QMD MCP 服务地址（如 `http://localhost:6179/mcp`） |
| `collections` | ✅ | 无 | 搜索范围：QMD 集合名列表（`qmd collection list` 可查） |
| `limit` | 否 | `5` | 注入结果的条数上限 |
| `minScore` | 否 | `25` | 最低匹配度过滤（百分数，低于此值的命中丢弃） |
| `triggerRoots` | 否 | 自动 | 触发判断的文件系统根路径列表；缺省时从 QMD `status` 动态解析集合路径 |

> 未配置 `qmdUrl` / `collections` 时插件禁用并输出 warn 日志。

## 使用

插件**全自动运行，无需手动调用**。配置完成后，正常使用 DSH 即可：

1. 让模型在知识库目录内搜索（如 `grep 某个概念`）
2. 插件检测到搜索发生在 QMD 集合目录内，自动补充一次语义检索
3. 结果作为补充提示注入模型的下一步上下文，模型可据此用 `read` 读取命中文档正文

### 效果示例

模型执行 `grep 内需` 后，下一步上下文中会出现：

```text
<system-reminder>
QMD 语义检索补充：你在知识库目录执行了「grep 内需」，系统已自动用语义检索（范围限定 QMD 集合，LLM 重排）补搜，查询词「内需」。结果如下（docid 映射为绝对路径后用 read 读取正文）：

Found 3 results for "内需":
#abc123 85% <collection>/concepts/<file>.md - <标题>
#def456 42% <collection>/principles/<file>.md - <标题>
...
</system-reminder>
```

### 验证插件已生效

- 让模型在集合目录内 grep 一个词，观察下一步是否出现上述补充消息
- 或查看宿主日志中的 `qmd-autosearch: 触发路径池（来自 QMD 集合）N 个`（插件启动后首次触发时输出）

## 前置条件

- 运行中的 QMD MCP 服务（`qmd mcp --http --port 6179`）
- 已建立至少一个 collection（`qmd collection add <name> <path>`）

## License

MIT
