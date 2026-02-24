# ReRevolve - Antigravity 다중 계정 쿼터 관리

Antigravity IDE에서 다중 계정의 Claude 쿼터량을 한눈에 확인할 수 있는 VSCode 확장프로그램입니다.

## 주요 기능

- 📊 **다중 계정 쿼터 표시**: 여러 계정의 Claude/GPT 그룹 쿼터를 일목요연하게 확인
- 🔑 **OAuth 토큰 캡처**: Google OAuth 인증으로 계정별 정확한 토큰 저장
- 🔄 **실시간 계정 감지**: Language Server API + state.vscdb 파일 감시로 활성 계정 자동 감지
- 🤖 **Auto-Accept**: 10개 Accept 명령어 자동 실행 (700ms 폴링, 설정 자동 주입/원복)
- 🌐 **Browser Allowlist**: Auto-Accept ON 시 browserAllowlist.txt 자동 생성
- 🛡️ **데이터 보호**: accounts.json 자동 백업 + 빈 배열 덮어쓰기 방지
- ⚡ **Antigravity 재시작**: 번개 아이콘으로 IDE 완전 재시작

## 설치 방법

### 방법 1: VSIX 파일 설치
1. `extension/` 폴더에서 `npm install` 실행
2. `npm run compile` 실행
3. `npm run package` 실행
4. 생성된 `.vsix` 파일을 Antigravity에서 설치

### 방법 2: 개발 모드
1. `extension/` 폴더에서 `npm install` 실행
2. VSCode/Antigravity에서 `F5`로 Extension Development Host 실행

## 사용 방법

1. 좌측 Activity Bar에서 ReRevolve 아이콘 클릭
2. `+ 추가` 버튼으로 계정 추가
3. Antigravity에 해당 계정으로 로그인 후 🔑 버튼 클릭하여 토큰 캡처
4. 🔄 버튼으로 쿼터 새로고침

## 쿼터 그룹

| 그룹 | 포함 모델 |
|------|-----------|
| Claude/GPT | Claude Sonnet, Claude Opus, GPT-4o 등 |
| Gemini Pro | gemini-3-pro, gemini-2.5-pro |
| Gemini Flash | gemini-3-flash |

## 주의사항

- 무료 계정이 비활성화 상태일 때 API는 100%/7일을 반환합니다
- 이 문제를 우회하기 위해 무료 비활성화 계정은 새로고침이 잠깁니다
- 해당 계정으로 Antigravity에 로그인 후 🔑 버튼을 눌러 토큰을 캡처하면 정확한 쿼터를 확인할 수 있습니다

## 라이선스

MIT License
