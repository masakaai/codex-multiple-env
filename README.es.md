<p align="center"><img width="100%" src="./docs/assets/masaka-banner.png" alt="Masaka conecta un perfil Codex aislado con el CLI nativo de Codex"></p>

<h1 align="center">Masaka · Codex Multiple Environments</h1>

<p align="center"><a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.fr.md">Français</a> · Español · <a href="./README.pt-BR.md">Português</a></p>

Masaka es un gestor de cuentas independiente para el CLI nativo de Codex.
Mantiene varias cuentas de ChatGPT y workspaces Personal, Business o Enterprise
en perfiles aislados, sin repetir logout/login.

## Instalación

Requisitos: macOS o Linux, Node.js 22+, Python 3 y el CLI oficial de Codex.

```bash
npm install -g github:masakaai/codex-multiple-env
masaka doctor
echo 'eval "$(masaka shell-init)"' >> ~/.zshrc
eval "$(masaka shell-init)"
masaka
```

`/add` abre el inicio de sesión oficial. `/profiles` enumera identidades,
`/status` muestra autenticación, actividad de tokens y límites de 5 horas/semanales,
y `/usage` muestra las reset cards. `/use 2` selecciona el perfil para procesos
nuevos de Codex. `/renew` y `/delete` aceptan nombre o número.

Un Codex ya ejecutándose no puede cambiar de cuenta de forma segura: la
autenticación y las políticas del workspace están vinculadas al proceso. Después
de `/use`, inicia otro `codex`; no hace falta cerrar sesión.

Cada perfil usa un `CODEX_HOME` independiente. Masaka nunca reemplaza
`~/.codex/auth.json` y no añade una capa de cifrado adicional.

Proyecto independiente de código abierto de MASAKA AI; no es un producto oficial
de OpenAI. Documentación completa: [English README](./README.md).
