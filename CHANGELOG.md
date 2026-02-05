# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
