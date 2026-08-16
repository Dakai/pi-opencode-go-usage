# pi-opencode-go-usage

在会话中实时追踪 OpenCode Go 的用量限额 —— **滚动 5 小时、每周、每月**，
通过实时状态栏和 `/opencode-go` 报告组件展示。

```
状态栏：  Go 5h 62% · wk 31% · mo 44%

报告组件：
  OpenCode Go Usage
  Workspace: wrk_xxxxxxxxxxxxxxxxxxxxxxxx
  Rolling 5h ██████░░░░  62% · 1h 12m
  Weekly     ███░░░░░░░  31% · 3d 4h
  Monthly    ████░░░░░░  44% · 12d 0h
  Updated 2:32:05 PM  （时间格式随你的区域设置而定）
```

## 为什么需要它

OpenCode **没有提供用量 API**，也没有 `/api/*` 接口。
`/workspace/<wrk_…>/go` 页面是一个 SolidStart 应用，会把解析后的数值直接
序列化进交付的 HTML 中：

```
rollingUsage:$R[12]={status:"ok",resetInSec:17400,usagePercent:42}
```

本扩展用你的浏览器 `auth` cookie 抓取该页面，从标记中读取三个百分比 + 重置时间。
它**只报告百分比和倒计时** —— 页面本身不携带任何金额信息，因此这里也没有。

## 安装

```bash
omp plugin install github:dakai/pi-opencode-go-usage
# 或用于本地开发：
omp plugin link /path/to/pi-opencode-go-usage
```

然后重启会话（或 `/reload`）。

## 连接

你需要从已登录的 opencode.ai 工作区获取两样东西：

1. **工作区 ID（Workspace ID）** —— 地址栏中的 `wrk_…` 片段：
   `opencode.ai/workspace/`**`wrk_…`**`/go`
2. **`auth` cookie 值** —— 在该页面按 F12 → Application → Cookies →
   `https://opencode.ai` → `auth` 行 → 复制其 Value。

可以设置环境变量（推荐 —— 可避免 cookie 出现在会话历史中）：

```bash
export OPENCODE_GO_WORKSPACE_ID=wrk_…
export OPENCODE_GO_AUTH_COOKIE='…'
```

或使用斜杠命令（持久化到 `~/.omp/agent/opencode-go-usage.json`，权限 0600）：

```
/opencode-go --connect wrk_… <auth-cookie-value>
```

## 命令

| 命令                                    | 作用                                                        |
| --------------------------------------- | ------------------------------------------------------------- |
| `/opencode-go`                          | 抓取并显示报告组件                              |
| `/opencode-go --connect <wrk> <cookie>` | 保存两者，抓取，显示                                        |
| `/opencode-go --workspace <id>`         | 仅保存工作区 ID                                        |
| `/opencode-go --cookie <value>`         | 仅保存 cookie                                              |
| `/opencode-go --disconnect`             | 清除两者                                                   |
| `/opencode-go --refresh`                | 立即重新抓取                                               |
| `/opencode-go --json`                   | 导出报告到 `~/.omp/agent/opencode-go-usage-report.json` |

用量每 5 分钟自动刷新一次。

## 失败模式

| 状态文本                                | 含义                    | 修复                           |
| ------------------------------------- | -------------------------- | ----------------------------- |
| `Cookie expired`                      | `auth` 会话已过期  | 用新 cookie 重新连接 |
| `Page carried no usage data`          | opencode.ai 标记已变更 | 更新解析器             |
| `Network error` / `Request timed out` | 瞬时错误                  | 重试                         |

## 安全性

这是通过浏览器会话 cookie 认证的抓取，存储在 `0600` 权限文件中（或环境变量）。
它只报告 opencode.ai 已展示的百分比；页面改版会导致其失效，届时它会明确报错，
而不是自信地显示一个零值。

## 许可证

MIT
