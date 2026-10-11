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
| `/auto [true\|false]` | 自動切り替えを確認・変更（既定は有効、しきい値 5%） |
| `/order` | 優先順位の表示・編集・自動順序への復元 |
| `/proxy on\|off` | ローカル Proxy と直接接続を切り替え |
| `/onboarding` | ユーザー用 Proxy daemon をインストールして起動 |
| `/add [NAME]` | 分離された新規プロファイルで公式ログイン |
| `/renew NAME\|NUMBER` | 同じ ID の認証を更新 |
| `/delete NAME\|NUMBER` | 完全な名前確認後、復元可能な trash へ移動 |

Apple Silicon macOS では `/onboarding` でローカル daemon を導入できます。
Proxy モードでは `/use` が既に動作中の Codex の**次のリクエスト**を切り替え、
出力中の応答は中断しません。既定の `/auto true` は prompt cache を守るため
現在の Profile を維持し、5時間枠が残り5%以下、または利用不能になった時だけ
切り替えます。優先順位は Pro → Business/Team → その他で、`/order` で変更
できます。`/proxy off` の直接モードでは `/use` は新規プロセスだけに反映
されます。どちらのモードでも logout は不要です。

各 Profile は独立した `CODEX_HOME` を使用し、グローバル
`~/.codex/auth.json` を置換しません。Masaka は追加暗号化を行わず、所有者専用の
ファイル権限で公式 Codex のファイルストアを利用します。

MASAKA AI による独立プロジェクトで、OpenAI の公式製品ではありません。
詳細は [English README](./README.md) を参照してください。
