# dsh-compact

一个用于 **DeepSeek Harness (`dsh`)** 的上下文压缩插件：在每轮对话结束（`turn/end`）后自动清理历史轮次中的工具调用结果（`tool/result`），在多轮对话中显著降低上下文 token 占用。

## 功能描述

- **单轮保留、跨轮清理**：单轮对话内的多步推理期间完整保留工具调用输出；当该轮对话结束（`turn/end`）后，自动将历史轮次的 `tool/result` 替换为极简占位摘要：
  ```text
  [Tool result cleared after turn 1: read_file (14820 chars)]
  ```
- **安全兼容**：通过 DSH 原生 `surfaceOp: { op: 'replace' }` 仅替换 `message.content`，保留 `toolCallId` 配对关系与底层 append-only 原始日志，不影响模型 API 调用与会话回放。
- **灵活策略**：支持配置保留最近轮次（`keepRecentTurns`）、最小清理字符阈值（`minCharsToCompact`）、保留错误结果（`preserveErrors`）及工具白名单（`excludedTools`）。

## 如何部署

### 1. CLI / Web 版 DSH

```bash
dsh plugin --profile web add @liuliy2hj/dsh-compact
```

### 2. 桌面版 DSH（`desktop` profile）

1. 在 `~/.dsh/profiles/desktop/` 安装（或本地克隆后软链）：
   ```bash
   cd ~/.dsh/profiles/desktop
   pnpm add @liuliy2hj/dsh-compact
   ```
   *(若本地克隆源码测试，可使用软链 `ln -s /path/to/dsh-compact ~/.dsh/profiles/desktop/node_modules/@liuliy2hj/dsh-compact`)*
2. 编辑 `~/.dsh/profiles/desktop/package.json`，将 `@liuliy2hj/dsh-compact` 加入 `dsh.profile.bundles` 与 `dependencies`：
   ```json
   {
     "dsh": {
       "profile": {
         "bundles": ["...", "@liuliy2hj/dsh-compact"]
       }
     },
     "dependencies": {
       "@liuliy2hj/dsh-compact": "^0.1.0"
     }
   }
   ```
3. （可选）如需自定义参数，在 `~/.dsh/profiles/desktop/cordis.patch.yml` 中追加配置：
   ```yaml
   - id: dsh-compact
     name: "@liuliy2hj/dsh-compact"
     config:
       enabled: true
       keepRecentTurns: 0
       minCharsToCompact: 120
       preserveErrors: true
       excludedTools: []
   ```
4. 完全退出并重启桌面版 DSH 即可生效。
