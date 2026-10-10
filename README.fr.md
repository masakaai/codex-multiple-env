<p align="center"><img width="100%" src="./docs/assets/masaka-banner.png" alt="Masaka relie un profil Codex isolé au CLI Codex natif"></p>

<h1 align="center">Masaka · Codex Multiple Environments</h1>

<p align="center"><a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.de.md">Deutsch</a> · Français · <a href="./README.es.md">Español</a> · <a href="./README.pt-BR.md">Português</a></p>

Masaka est un gestionnaire de comptes autonome pour le CLI Codex natif. Il
conserve plusieurs comptes ChatGPT et workspaces Personal, Business ou Enterprise
dans des profils isolés, sans répétition de logout/login.

## Installation

Prérequis : macOS ou Linux, Node.js 22+, Python 3 et le CLI Codex officiel.

```bash
npm install -g github:masakaai/codex-multiple-env
masaka doctor
echo 'eval "$(masaka shell-init)"' >> ~/.zshrc
eval "$(masaka shell-init)"
masaka
```

`/add` lance la connexion officielle dans le navigateur. `/profiles` liste les
identités, `/status` affiche l'authentification, l'activité des tokens et les
fenêtres de quota de 5 heures/hebdomadaires, et `/usage` affiche les reset cards.
`/use 2` choisit le profil des **nouveaux** processus Codex natifs. `/renew` et
`/delete` acceptent un nom ou un numéro.

Un processus Codex déjà actif ne peut pas changer de compte en toute sécurité :
l'authentification et les règles du workspace sont liées au processus. Après
`/use`, démarrez simplement un nouveau `codex`; aucun logout n'est nécessaire.

Chaque profil possède son propre `CODEX_HOME`. Masaka ne remplace jamais
`~/.codex/auth.json` et n'ajoute volontairement aucun chiffrement supplémentaire.

Projet open source indépendant de MASAKA AI, non officiel et non affilié à OpenAI.
Documentation complète : [English README](./README.md).
