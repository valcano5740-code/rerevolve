# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [6.10.0] - 2026-02-23 🔗 통합 머지 (v6.9.0 + 안정성)

### Added
- 🛡️ **accounts.json 데이터 소실 방지**
  - `load()`: 메인 파일이 빈 배열이면 `.bak`에서 자동 복구
  - `save()`: 빈 배열 저장 시 메인+.bak 양쪽 체크하여 완전 차단
  - 저장 전 자동 백업(`accounts.json.bak`) 생성
- 🔄 **계정 감지 성능 복원** (v6.9.0에서 제거됐던 기능)
  - `state.vscdb` 파일 감시(fs.watch) 복원 (2초 디바운스)
  - 쿼터 갱신 60초 → 15초 복원
  - 재충전 로컬 체크(`checkRechargeLocal`) 5초 복원

### Fixed
- 🐛 `Promise.all` 안전장치: `hasToken()` 개별 `.catch(() => false)` 복원

---

## [6.9.0] - 2026-02-19 🔗 통합 버전

### Changed
- 🔗 v6.7.5 안정성 + v6.8.0 기능 통합
- ⚠️ 계정 감지 기능 일부 미복원 (v6.10.0에서 해결)

---

## [6.8.0] - 2026-02-19 🤖 Auto-Accept 확장

### Added
- 🤖 **Accept 명령어 10개 확장** (Hunk, Supercomplete, Tab Jump, Cascade 등)
- ⚙️ **설정 자동 주입/원복**: ON 시 5개 설정 주입, OFF 시 원복
- 🌐 **browserAllowlist.txt** 자동 생성/삭제
- 📢 토글 시 알림 메시지 표시

### Changed
- 폴링 간격 1000ms → 700ms

---

## [6.7.0] - 2026-02-12 🔧 CDP 제거 + pesosz 방식

### Changed
- 🔧 **Auto-Accept 전면 개편**: CDP 제거, VS Code 내부 명령어 직접 호출
- ⚡ Boost 런처: `--remote-debugging-port` 옵션 제거

### Removed
- 🗑️ CDP 관련 코드 전량 삭제 (WebSocket, DOM 클릭 등)

---


## [6.6.3] - 2026-02-10 🔧 OAuth loopback 안정화

### Fixed
- 🐛 `server.close()` 후 `server.address()` null 반환 → `serverPort` 외부 변수로 해결
- 🐛 favicon.ico 등 브라우저 부가 요청이 "사용자 취소"로 처리되던 문제 수정
- 🐛 `redirect_uri_mismatch` (인증 시 포트 포함 vs 교환 시 포트 미포함) 수정

### Changed
- 🔑 OAuth OOB 방식 폐지 대응 → **loopback redirect** 전환 완료
  - 로컬 HTTP 서버가 빈 포트에서 자동 시작 → 인증 코드 자동 수신
  - 수동 코드 입력 불필요, 브라우저 로그인만으로 캡처 완료

---

## [6.6.0] - 2026-02-10 🚀 이식성 확보 (globalState 마이그레이션)

### Changed
- 🔄 **토큰 저장소 변경**: SecretStorage → globalState
  - 기기 간 이동 가능 (Export/Import에 refresh token 포함)
  - Settings Sync 지원으로 자동 동기화 가능
- 📤 **Export 개선**: raw credential 내보내기 (refresh token 포함)
  - 다른 기기에서 import 후 즉시 토큰 사용 가능
- 🔧 **account-switcher**: 스냅샷도 globalState로 이동
- 🔑 **토큰 캡처 방식 전환**: state.vscdb 추출 → **Google OAuth 인증**
  - Antigravity 로그인 계정과 무관하게 어떤 Google 계정이든 캡처 가능
  - 계정별 정확한 refresh token 보장

### Note
- ⚠️ 기존 SecretStorage 토큰은 마이그레이션 안됨 → 토큰 재캡처 필요

---

## [6.5.2] - 2026-02-09 🔧 CDP Worker 지원

### Fixed
- 🔧 **CDP 페이지 타입 확장**
  - `worker` 타입 페이지 지원 추가
  - Antigravity CDP 연결 호환성 개선
  - Accept All 버튼 DOM 클릭 안정화

---

## [6.5.1] - 2026-02-09 🔇 Auto-Accept Silent Mode

### Changed
- 🔇 **Auto-Accept 피드백 개선**
  - 불필요한 상태바 깜빡임 제거
  - 활성화 시 한 번만 "활성 (명령어 모드)" 표시
  - 이후 명령어 실행은 조용히 진행
- 폴링 방식 유지 (1초 주기, 5개 명령어 시도)

---

## [6.5.0] - 2026-02-06 🤖 Auto-Accept Hybrid Mode

### Added
- 🤖 **VS Code 명령어 기반 Auto-Accept** (1순위)
  - Antigravity 내부 명령어 직접 호출 (CDP 클릭보다 안정적)
  - `antigravity.agent.acceptAgentStep` 등 5개 명령어 추가
- 📚 **참고 자료 GitHub 프로젝트 문서화**
  - Ricco6/always-accept-antigravity (명령어 발견)
  - Munkhin/auto-accept-agent (CDP 핸들러 구조)

### Changed
- 🔄 **하이브리드 Auto-Accept 방식**
  - 1순위: VS Code 명령어 실행 (빠르고 안정적)
  - 2순위: CDP DOM 클릭 (백업용)
- CONTEXT_MAP.md 업데이트 (참고 자료 섹션 추가)

---


## [6.4.0] - 2026-02-06 ⚡ Real-time Account Detection

### Added
- ⚡ **Language Server API 활성 계정 감지**
  - 리로드 없이 실시간으로 활성 계정 감지
  - vscdb 파일 플러시 대기 불필요
  - 다중 창 지원 (PID/PPID 매칭)
  - 실패 시 기존 vscdb 방식으로 fallback

### Changed
- 🔄 **Refresh Token만 저장**
  - 토큰 캡처 시 Refresh Token만 저장
  - Access Token은 쿼터 조회 시 항상 새로 발급
  - 더 안정적인 토큰 관리

---

## [6.3.8] - 2026-02-06 🚫 Auto Recovery Removed

### Removed
- 🚫 **자동 토큰 복구 기능 제거**
  - `tryAutoRecovery()` 함수 완전 제거
  - 활성 계정 감지 불안정으로 잘못된 계정 토큰 저장 버그 수정
  - 토큰이 없거나 만료된 경우 수동 캡처 필요

---

## [6.3.7] - 2026-02-06 📢 Auto Accept Feedback

### Added
- 📢 **버튼 클릭 시 상태바 피드백**
  - 클릭 시 "✅ Auto-Accept: N 버튼 클릭" 메시지 표시
  - 3초 throttle로 과도한 메시지 방지

---

## [6.3.6] - 2026-02-05 🔘 Auto Accept Button Fix

### Fixed
- 🔘 **버튼 선택자 확장**
  - `[class*="btn"]`, `[role="button"]`, `[class*="action"]` 추가
  - "Accept all" 등 더 많은 버튼 감지
- 🛡️ **자체 버튼 클릭 방지**
  - REJECT_PATTERNS에 `auto-accept`, `rerevolve`, `quota` 추가
  - 하단 상태바 버튼이 클릭되지 않도록 수정

---

## [6.3.5] - 2026-02-05 🔍 Debug JSON Export

### Added
- 🔍 **디버그용 JSON 파일 저장**
  - 토큰 캡처 시 `~/.rerevolve-debug/` 폴더에 JSON 파일 동시 저장
  - 개발 중 토큰 확인용

---

## [6.3.4] - 2026-02-05 🎯 Token Save Target Fix

### Changed
- 🎯 **토큰 저장 대상 수정**
  - 이전: 현재 로그인 계정으로 자동 저장 (버그 유발)
  - 이후: 클릭한 계정에 저장, 불일치 시 경고만 표시
  - 사용자가 의도한 계정에 정확히 저장됨

---

## [6.3.3] - 2026-02-05 🔧 Refresh Token Source Fix

### Fixed
- 🔧 **Refresh Token도 신뢰할 수 있는 소스로 변경**
  - 이전: `jetskiStateSync.agentManagerInitState` (이전 계정 토큰 가능성)
  - 이후: `antigravityUnifiedStateSync.oauthToken` (현재 계정 토큰)
  - Access Token + Refresh Token 모두 현재 로그인 계정에서 추출

---

## [6.3.2] - 2026-02-05 🔧 Token Source Fix

### Fixed
- 🔧 **토큰 캡처 소스 변경**
  - 이전: `jetskiStateSync.agentManagerInitState` (이전 계정 토큰이 남아있을 수 있음)
  - 이후: `antigravityAuthStatus.apiKey` (현재 로그인 계정의 토큰 - 가장 신뢰할 수 있음)
  - `getAuthStatus()` 메서드 추가하여 현재 계정 정보 직접 읽기

---

## [6.3.1] - 2026-02-05 🐛 Token Capture Bug Fix

### Fixed
- 🐛 **토큰 캡처가 잘못된 계정으로 저장되는 버그 수정**
  - 이전: 클릭한 계정 카드의 email로 토큰 저장 (잘못됨)
  - 이후: 현재 Antigravity에 로그인된 계정의 email로 토큰 저장
  - 다른 계정으로 로그인되어 있으면 경고 메시지 표시

---

## [6.3.0] - 2026-02-05 🔄 One-Click Account Switch

### Added
- 🔄 **계정 전환 버튼 추가**
  - 계정 카드 드롭다운 메뉴에 "🔄 계정 전환" 버튼
  - 원클릭으로 해당 계정으로 전환 (스냅샷 기반)

---

## [6.2.0] - 2026-02-05 🔗 Token + Snapshot Integration

### Changed
- 🔗 **토큰 캡처 + 스냅샷 저장 통합**
  - 토큰 캡처 버튼 클릭 시 스냅샷도 자동 저장
  - 한 번의 클릭으로 쿼터 조회 + 계정 전환 모두 준비 완료

---

## [6.1.0] - 2026-02-05 🔐 SecretStorage Migration

### Changed
- 🔒 **스냅샷 저장소를 SecretStorage로 이전**
  - JSON 파일 대신 VSCode SecretStorage 사용 (암호화됨)
  - Windows Credential Manager / macOS Keychain / Linux libsecret
- 기존 `rerevolve-snapshots.json` 파일은 더 이상 사용하지 않음

### Security
- 인증 정보가 OS 자격 증명 보관소에 안전하게 저장됨
- 파일 시스템에 평문으로 저장되지 않음

---

## [6.0.0] - 2026-02-04 🔄 Account Switcher

### Added
- 🔄 **계정 전환 기능** (Account Switcher)
  - `ReRevolve: 현재 계정 스냅샷 저장` - 현재 로그인된 계정 저장
  - `ReRevolve: 계정 전환` - 저장된 계정으로 원클릭 전환
- 스냅샷 기반 계정 관리: antigravityAuthStatus 전체 저장/복원
- GitHub 저장소 연동 (버전 관리)

### Technical
- `account-switcher.ts` 신규 추가
- sqlite3 CLI를 통한 state.vscdb 읽기/쓰기

---

## [0.5.0] - 2026-02-03 🎛️ UI Redesign & Utilities

### Added
- 🔧 **유틸리티 버튼 8개 추가**
  - 📋 Rules - GEMINI.md 바로 열기
  - 🔧 MCP - mcp.json 바로 열기
  - 🌐 Allowlist - allowlist.json 바로 열기
  - 📦 Brain - Brain 폴더 열기
  - 💾 Tracker - Code Tracker 폴더 열기
  - 🔄 Restart - Extension Host 재시작
  - 🔃 Reset - 캐시 삭제
  - 🔁 Reload - 창 새로고침
- 📋 활동 로그 **전체 복사** 버튼

### Changed
- 💾 내보내기/가져오기를 **설정 하단**으로 이동
- 🎨 활동 로그 화살표(▶/▼) 제거 (클릭으로 토글)
- ⚡ 설정 패널 UI 구조 개선

---

## [0.4.0] - 2026-02-02 🚀 CDP Auto-Accept

### Added
- 🎯 **CDP 기반 Auto-Accept** (AAA 방식 참고)
  - WebSocket으로 CDP 연결 (포트 9000±3)
  - DOM에서 Accept/Run/Retry/Allow 버튼 직접 클릭
  - 기존 VS Code 커맨드 API 방식 대체
- 📄 로그 전체 복사 버튼
- 🔽 활동 로그 헤더 클릭으로 토글 (슬라이드 업/다운)

### Changed
- Auto-Accept 활성화 시 CDP 연결 필요
- 사용자 설정 가이드 웹뷰 추가

### Dependencies
- `ws` 패키지 추가 (WebSocket)

---

## [0.3.9] - 2026-02-02

### Removed
- 🗑️ 작동하지 않는 OAuth 인증 버튼 제거 (Google OOB 방식 deprecated)

---

## [0.3.8] - 2026-02-02 ⭐ 주요 성공 사례

### Added
- 🎉 **Protobuf 기반 토큰 추출** (Antigravity Cockpit 방식)
  - `sql.js`로 state.vscdb SQLite 읽기
  - `jetskiStateSync.agentManagerInitState`에서 Protobuf 디코딩
  - **Refresh Token 추출 성공!**
- 정규식 방식 폴백 유지

### Technical
- `extractTokensWithProtobuf()` 메서드 추가
- Protobuf varint/length-delimited 필드 파싱
- OAuth 필드 (field 6) 에서 accessToken (field 1), refreshToken (field 3) 추출

### 참고
- Antigravity Cockpit의 `local_auth_importer.ts` 분석 기반
- 단순 정규식으로 추출 불가했던 refresh_token 획득 가능해짐

---

## [0.1.2] - 2026-01-30

### Fixed
- 🐛 이메일 추출 로직 버그 수정: `rerevolve.token.` 접두사가 이메일로 잘못 인식되는 문제 해결
- 정규식 패턴 이스케이프 수정

### Improved
- 충전/갱신 시간 UI 개선: 세로 배치로 줄바꿈 방지
- 예상 충전 시간 표시: 갱신 시점 + 남은 시간을 계산하여 날짜/시간(분 단위) 표시
- 갱신 시간에 날짜 추가 (M/D 오전/오후 H:MM 형식)

---

## [0.1.1] - 2026-01-30

### Fixed
- 🐛 토큰 캡처 시 현재 Antigravity 로그인 계정과 대상 계정 불일치 감지 기능 추가
  - 이제 다른 계정으로 로그인되어 있으면 경고 팝업이 표시됩니다
- 토큰 캡처 완료 시 실제 로그인 계정 정보 표시

### Added
- `getCurrentLoggedInEmail()` 메서드: state.vscdb에서 현재 로그인 이메일 추출

---

## [0.1.0] - 2026-01-30

### Added
- 초기 버전 릴리즈
- 다중 계정 쿼터 관리 기능
  - 계정 추가/삭제/수정
  - 유료/무료 계정 자동 판별
  - 무료 비활성화 계정 새로고침 잠금
- 토큰 관리 기능
  - state.vscdb에서 ya29 토큰 자동 추출
  - VSCode SecretStorage를 통한 안전한 토큰 저장
  - Refresh Token 기반 자동 갱신 (지원 시)
- 쿼터 조회 기능
  - CloudCode API를 통한 실시간 쿼터 조회
  - Claude/GPT, Gemini Pro, Gemini Flash 그룹별 집계
  - 리셋 시간 표시
- UI 기능
  - Webview 기반 사이드바 UI
  - 계정별 쿼터 카드
  - 전체/개별 새로고침 버튼
  - 🔑 토큰 캡처 버튼
- Antigravity 재시작 기능 (⚡ 번개 아이콘)
- 좌측 Activity Bar 아이콘

### Technical
- CloudCode API 엔드포인트: `daily-cloudcode-pa.sandbox.googleapis.com`
- 유/무료 판별: `loadCodeAssist` API의 `paidTier` 필드
- 토큰 추출: `state.vscdb` 파일에서 ya29 패턴 검색
