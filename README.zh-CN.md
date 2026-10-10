<p align="center"><img width="100%" src="./docs/assets/masaka-banner.png" alt="Masaka 为原生 Codex CLI 选择隔离的账号与 Workspace Profile"></p>

<h1 align="center">Masaka · Codex Multiple Environments</h1>

<p align="center">无需反复 logout/login，在原生 Codex CLI 中切换隔离的 ChatGPT 账号与 Workspace。</p>

<p align="center"><a href="./README.md">English</a> · 简体中文 · <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.fr.md">Français</a> · <a href="./README.es.md">Español</a> · <a href="./README.pt-BR.md">Português</a></p>

Masaka 是独立的账号管理终端，不是另一个 Agent CLI，也不会替换 Codex
界面。你在 `masaka` 中添加、查看、续登、删除或选择 Profile，之后仍然
直接运行原生的 `codex`。

每个 Profile 严格对应一个 `(ChatGPT 账号, ChatGPT Workspace)` 组合，并
拥有独立的 `CODEX_HOME`。浏览器登录、Token 刷新和凭据文件始终由官方
Codex 管理。

## 安装

需要 macOS 或 Linux、Node.js 22+、Python 3，以及官方
[Codex CLI](https://developers.openai.com/codex/cli/reference/)。

```bash
npm install -g github:masakaai/codex-multiple-env
masaka doctor
```

让普通的 `codex` 命令使用已选择的 Profile：

```bash
echo 'eval "$(masaka shell-init)"' >> ~/.zshrc
eval "$(masaka shell-init)"
```

Bash 请写入 `~/.bashrc`。Masaka 只输出集成脚本，不会自动修改 shell 配置。
如果原来使用 `codex` alias 添加默认参数，请改用数组：

```bash
MASAKA_CODEX_DEFAULT_ARGS=(--search -m gpt-5.6-sol)
eval "$(masaka shell-init)"
```

## 使用

```bash
masaka
```

```text
masaka> /add
[打开官方 Codex 浏览器登录]
masaka> /profiles
1. Alice (alice@example.com) · Personal
2. Alice (alice@example.com) · Acme (Business) [default]
masaka> /use 1
masaka> /exit
```

然后照常启动原生 Codex：

```bash
codex
codex --search
codex exec "总结这个仓库"
```

## 命令

| 命令 | 功能 |
| --- | --- |
| `/status` | 查看所有账号的登录状态、套餐、Token 活跃度、5 小时及其他限额窗口 |
| `/usage` | 查看所有账号可用的 reset cards 数量及返回的过期信息 |
| `/profiles` | 查看全部账号、Workspace、套餐与当前选择 |
| `/use 名称\|编号` | 选择后续新启动的原生 Codex 使用的 Profile |
| `/add [名称]` | 在全新隔离 Profile 中运行官方 `codex login`；默认自动命名 |
| `/renew 名称\|编号` | 所有相关会话关闭后，为同一身份重新登录 |
| `/delete 名称\|编号` | 要求输入完整名称确认，再移动到可恢复的 trash |
| `/exit` | 只退出 Masaka 管理终端 |

也可以直接执行 `masaka status`、`masaka use 2` 等终端命令。

## `/status` 与 `/usage`

Masaka 通过官方 Codex App Server 的只读接口 `account/read`、
`account/rateLimits/read` 和 `account/usage/read` 获取数据。300 分钟窗口显示
为 `5h`；剩余百分比和重置时间均由服务端返回值计算。

`/usage` 以服务端 `availableCount` 为准。服务端可能限制明细行数量，因此
卡片总数可能大于显示的明细数。接口说明见
[Codex App Server 文档](https://developers.openai.com/codex/app-server/#auth-endpoints)。

## 为什么不支持运行中热切换

`/use` 只影响后续新启动的 Codex。它不会改变已经运行的 Codex 进程身份，
也不会让同一对话跨越 Workspace 的治理边界。

运行中的 Codex 会缓存 AuthManager、账号和 Workspace 策略。替换
`auth.json`、切换软链接或注入其他账号 Token 会与刷新流程竞争，正是产生
以下错误的典型原因：

```text
Your access token could not be refreshed because you have since logged out
or signed in to another account.
```

原生 TUI 当前没有安全的外部热切换入口。可靠方式是执行 `/use` 后新开一个
`codex`；原有进程继续使用启动时的 Profile。整个过程无需 logout。

## 安全边界

- 一个 Profile 只保存一个账号与 Workspace 组合，并拥有一个 `CODEX_HOME`。
- 永不复制、链接或替换全局 `~/.codex/auth.json`。
- 启动 Codex 前清除环境中的 API/access token 和认证端点覆盖变量。
- 拒绝软链接、硬链接凭据；多会话可并发使用，但 `/renew` 与 `/delete` 需要独占锁。
- Profile 目录为 `0700`，元数据和凭据文件为 `0600`（POSIX 平台）。
- Masaka 不额外加密。`cli_auth_credentials_store="file"` 使用 Codex 官方
  `auth.json` 文件存储；请把它当作密码保护。详见
  [官方凭据存储文档](https://developers.openai.com/codex/auth/#credential-storage)。

本项目由 MASAKA AI 独立开发，不是 OpenAI 官方产品，也未获 OpenAI 背书。
Apache-2.0 开源；安全问题请查看 [SECURITY.md](./SECURITY.md)。
