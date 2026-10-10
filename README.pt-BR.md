<p align="center"><img width="100%" src="./docs/assets/masaka-banner.png" alt="Masaka conecta um perfil Codex isolado à CLI nativa do Codex"></p>

<h1 align="center">Masaka · Codex Multiple Environments</h1>

<p align="center"><a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.fr.md">Français</a> · <a href="./README.es.md">Español</a> · Português</p>

Masaka é um gerenciador de contas independente para a CLI nativa do Codex. Ele
mantém várias contas ChatGPT e workspaces Personal, Business ou Enterprise em
perfis isolados, sem repetir logout/login.

## Instalação

Requisitos: macOS ou Linux, Node.js 22+, Python 3 e a CLI oficial do Codex.

```bash
npm install -g github:masakaai/codex-multiple-env
masaka doctor
echo 'eval "$(masaka shell-init)"' >> ~/.zshrc
eval "$(masaka shell-init)"
masaka
```

`/add` abre o login oficial no navegador. `/profiles` lista identidades,
`/status` mostra autenticação, atividade de tokens e limites de 5 horas/semanais,
e `/usage` mostra os reset cards. `/use 2` escolhe o perfil para novos processos
Codex. `/renew` e `/delete` aceitam nome ou número.

Um Codex já em execução não pode trocar de conta com segurança: autenticação e
políticas do workspace ficam vinculadas ao processo. Após `/use`, inicie um novo
`codex`; não é preciso fazer logout.

Cada perfil usa um `CODEX_HOME` independente. Masaka nunca substitui
`~/.codex/auth.json` e não adiciona uma camada extra de criptografia.

Projeto open source independente da MASAKA AI; não é um produto oficial da OpenAI.
Documentação completa: [English README](./README.md).
