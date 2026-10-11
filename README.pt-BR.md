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

### Proxy opcional para troca em tempo real

No macOS Apple Silicon, `/onboarding` instala um daemon local por usuário. Depois,
`/use 2` muda clientes Codex já abertos na **próxima solicitação**, sem interromper
respostas em andamento. `/auto true` vem ativado: mantém a conta atual para
preservar o cache do prompt e troca quando restam 5% ou menos da janela de 5
horas, ou quando a conta fica indisponível. A prioridade padrão é
Pro → Business/Team → outros planos; `/order` permite ajustá-la. `/proxy off` retorna
ao modo direto, no qual `/use` afeta apenas novos processos. Não é preciso logout.

Cada perfil usa um `CODEX_HOME` independente. Masaka nunca substitui
`~/.codex/auth.json` e não adiciona uma camada extra de criptografia.

Projeto open source independente da MASAKA AI; não é um produto oficial da OpenAI.
Documentação completa: [English README](./README.md).
