<p align="center"><img width="100%" src="./docs/assets/masaka-banner.png" alt="Masaka verbindet ein isoliertes Codex-Profil mit der nativen Codex CLI"></p>

<h1 align="center">Masaka · Codex Multiple Environments</h1>

<p align="center"><a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a> · Deutsch · <a href="./README.fr.md">Français</a> · <a href="./README.es.md">Español</a> · <a href="./README.pt-BR.md">Português</a></p>

Masaka ist ein eigenständiger Account-Manager für die native Codex CLI. Mehrere
ChatGPT-Konten und Personal-, Business- oder Enterprise-Workspaces bleiben in
getrennten Profilen angemeldet—ohne wiederholtes Logout/Login.

## Installation

Voraussetzungen: macOS oder Linux, Node.js 22+, Python 3 und die offizielle Codex CLI.

```bash
npm install -g @masakaai/codex-multiple-env
masaka doctor
echo 'eval "$(masaka shell-init)"' >> ~/.zshrc
eval "$(masaka shell-init)"
masaka
```

`/add` startet den offiziellen Browser-Login. `/profiles` zeigt alle Identitäten,
`/status` Authentifizierung, Token-Aktivität und 5-Stunden-/Wochenlimits,
`/usage` die Reset-Karten. Mit `/use 2` wird das Profil für **neu gestartete**
native Codex-Prozesse gewählt. `/renew` und `/delete` akzeptieren Name oder Nummer.

### Optionaler Proxy für Hot-Switching

Auf Apple-Silicon-macOS installiert `/onboarding` einen lokalen, benutzereigenen
Daemon. Danach schaltet `/use 2` bereits laufende Codex-Clients bei der **nächsten
Anfrage** um; laufende Antworten werden nicht unterbrochen. `/auto true` ist
standardmäßig aktiv, bleibt für den Prompt-Cache beim aktuellen Profil und
wechselt erst bei höchstens 5 % verbleibendem 5-Stunden-Limit oder Ausfall.
Die Standardreihenfolge ist Pro → Business/Team → andere Tarife; `/order` passt sie an.
Mit `/proxy off` wird wieder der Direktmodus verwendet. Dort gilt `/use` nur für
neu gestartete Prozesse. Ein Logout ist in keinem Modus nötig.

Jedes Profil hat ein eigenes `CODEX_HOME`. Masaka ersetzt niemals
`~/.codex/auth.json` und fügt bewusst keine zusätzliche Verschlüsselung hinzu;
die offizielle Codex-Dateiablage nutzt Besitzerrechte.

Unabhängiges Open-Source-Projekt von MASAKA AI, kein offizielles OpenAI-Produkt.
Vollständige Dokumentation: [English README](./README.md).
