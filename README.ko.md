<p align="center"><img width="100%" src="./docs/assets/masaka-banner.png" alt="Masaka가 격리된 Codex 프로필을 네이티브 Codex CLI에 연결합니다"></p>

<h1 align="center">Masaka · Codex Multiple Environments</h1>

<p align="center"><a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a> · <a href="./README.ja.md">日本語</a> · 한국어 · <a href="./README.de.md">Deutsch</a> · <a href="./README.fr.md">Français</a> · <a href="./README.es.md">Español</a> · <a href="./README.pt-BR.md">Português</a></p>

Masaka는 네이티브 Codex CLI를 위한 독립 계정 관리자입니다. 여러 ChatGPT
계정과 Personal / Business / Enterprise Workspace를 반복 로그아웃 없이
격리된 Profile로 유지합니다.

## 설치와 사용

macOS 또는 Linux, Node.js 22+, Python 3, 공식 Codex CLI가 필요합니다.

```bash
npm install -g @masakaai/codex-multiple-env
masaka doctor
echo 'eval "$(masaka shell-init)"' >> ~/.zshrc
eval "$(masaka shell-init)"
masaka
```

`/add`는 공식 브라우저 로그인을 추가하고, `/profiles`는 전체 계정 정보를,
`/status`는 인증·토큰 활동·5시간/주간 한도를, `/usage`는 reset card 수와
만료 정보를 표시합니다. `/use 2`로 새 Codex 프로세스의 Profile을 선택하며,
`/renew`와 `/delete`도 이름 또는 번호를 받습니다.

### 선택적 Proxy 핫스위치

Apple Silicon macOS에서는 `/onboarding`이 사용자 전용 로컬 daemon을
설치합니다. 이후 `/use 2`는 이미 열린 Codex의 **다음 요청**부터 Profile을
바꾸며 진행 중인 응답은 끊지 않습니다. 기본값인 `/auto true`는 prompt cache를
유지하도록 현재 계정을 고정하고, 5시간 한도가 5% 이하이거나 계정을 사용할 수
없을 때만 전환합니다. 기본 우선순위는 Pro → Business/Team → 기타 플랜이며
`/order`로 바꿀 수 있습니다. `/proxy off`는 직접 연결로 돌아가며 이 모드에서
`/use`는 새 프로세스에만 적용됩니다. 어느 모드에서도 로그아웃은 필요 없습니다.

각 Profile은 독립 `CODEX_HOME`을 사용하며 전역 `~/.codex/auth.json`을
교체하지 않습니다. Masaka는 별도 암호화를 추가하지 않고 소유자 전용 파일
권한과 공식 Codex 파일 저장소를 사용합니다.

MASAKA AI의 독립 오픈소스 프로젝트이며 OpenAI 공식 제품이 아닙니다.
전체 문서는 [English README](./README.md)를 참고하세요.
