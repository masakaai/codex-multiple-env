<p align="center"><img width="100%" src="./docs/assets/masaka-banner.png" alt="Masaka は分離された Codex プロファイルをネイティブ Codex CLI に接続します"></p>

<h1 align="center">Masaka · Codex Multiple Environments</h1>

<p align="center"><a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a> · 日本語 · <a href="./README.ko.md">한국어</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.fr.md">Français</a> · <a href="./README.es.md">Español</a> · <a href="./README.pt-BR.md">Português</a></p>

Masaka は、ネイティブ Codex CLI 用の独立したアカウント管理ツールです。
複数の ChatGPT アカウントと Personal / Business / Enterprise Workspace を、
logout/login の繰り返しなしで分離して保持できます。

## インストール

macOS または Linux、Node.js 22+、Python 3、公式 Codex CLI が必要です。

```bash
npm install -g github:masakaai/codex-multiple-env
masaka doctor
echo 'eval "$(masaka shell-init)"' >> ~/.zshrc
eval "$(masaka shell-init)"
```

## 使い方

`masaka` を開き、`/add` で公式ブラウザログインを追加し、`/profiles` で一覧、
`/use 2` で選択します。その後は通常どおり `codex` を実行してください。

| コマンド | 内容 |
| --- | --- |
| `/status` | 全プロファイルの認証、使用量、5時間/週次制限 |
| `/usage` | 全プロファイルの reset card 数と有効期限 |
| `/profiles` | アカウント、Workspace、プランの一覧 |
| `/use NAME\|NUMBER` | 新しく起動する Codex のプロファイルを選択 |
| `/add [NAME]` | 分離された新規プロファイルで公式ログイン |
| `/renew NAME\|NUMBER` | 同じ ID の認証を更新 |
| `/delete NAME\|NUMBER` | 完全な名前確認後、復元可能な trash へ移動 |

`/use` は既に動作中の Codex の ID を変更しません。実行中プロセスは認証と
Workspace ポリシーを保持するため、安全な外部ホットスイッチ API はありません。
選択後に新しい `codex` を起動してください。logout は不要です。

各 Profile は独立した `CODEX_HOME` を使用し、グローバル
`~/.codex/auth.json` を置換しません。Masaka は追加暗号化を行わず、所有者専用の
ファイル権限で公式 Codex のファイルストアを利用します。

MASAKA AI による独立プロジェクトで、OpenAI の公式製品ではありません。
詳細は [English README](./README.md) を参照してください。
