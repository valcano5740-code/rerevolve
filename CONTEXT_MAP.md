# ReRevolve Project Memory

## 📌 Shared Cluster (Global Context)

### state.vscdb 위치
```
Windows: %APPDATA%/Antigravity/User/globalStorage/state.vscdb
```

### 주요 키
| 키 | 용도 | 형식 |
|---|---|---|
| `antigravityAuthStatus` | 현재 로그인 계정 (email, apiKey) | JSON |
| `antigravityUnifiedStateSync.oauthToken` | OAuth 토큰 정보 | Base64 Protobuf |
| `jetskiStateSync.agentManagerInitState` | 에이전트 상태 | Base64 Protobuf |

---

## 🔑 Cluster: Token Management

### Current Understanding
- [Verified] Access Token은 `antigravityAuthStatus.apiKey`에서 추출
- [Verified] Refresh Token은 `antigravityUnifiedStateSync.oauthToken` → fallback: `jetskiStateSync`
- [Verified] 저장 위치: VSCode globalState (`rerevolve.token.{email}`) ← v6.6.0에서 SecretStorage→globalState 이전
- [Verified] 디버그 파일: `~/.rerevolve-debug/{email}.json`
- [v6.4.0] **Refresh Token만 저장** - Access Token은 쿼터 조회 시 발급
- [v6.4.0] **Language Server API**로 활성 계정 실시간 감지 (3회 재시도 → vscdb fallback)
- [v6.6.0] **Export/Import에 refresh token 포함** - 기기 간 이동 가능
- [v6.6.0] **토큰 캡처: state.vscdb → OAuth 인증 전환** - 계정별 정확한 refresh token 보장
- [v6.6.3] **OAuth loopback redirect** 완성 - OOB 폐지 대응, 로컬 HTTP 서버로 인증 코드 자동 수신
  - ⚠️ gotcha: `server.close()` 후 `server.address()` = null → 포트를 외부 변수에 미리 저장 필수
  - ⚠️ gotcha: 브라우저 favicon.ico 요청 → code/error 없는 요청은 무시 처리 필요

### Key Decisions
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-05 | oauthToken을 primary로 사용 | jetski보다 안정적 |
| 2026-02-05 | 클릭한 계정에 저장 | 활성 계정 감지 불안정 |
| 2026-02-06 | 자동 복구 기능 제거 | 잘못된 계정 토큰 저장 버그 |
| 2026-02-06 | Refresh Token만 저장 | 안정적 토큰 관리 |
| 2026-02-06 | Language Server API 도입 | 실시간 활성 계정 감지 |
| 2026-02-10 | OAuth 캡처 전환 | state.vscdb의 refresh token 계정 불일치 문제 |
| 2026-02-10 | **OOB → loopback redirect** | Google OOB(`urn:ietf:wg:oauth:2.0:oob`) 폐지됨 → `http://localhost` 방식 |
| 2026-02-10 | VS Code 명령어 자동 accept 제거 | Ctrl+Alt+P 시 열린 창이 닫히는 부작용 |
| 2026-02-10 | Accept 스크립트 iframe 탐색 추가 | Reddit 발견: Accept 버튼은 iframe 내부 `bg-ide-button-bac` 클래스 |

### Rejected Approaches
- [Rejected] tryAutoRecovery → 활성 계정 감지 불안정으로 잘못된 토큰 저장
- [Rejected] jetski-only 추출 → 불완전한 토큰 반환
- [Rejected] Access Token 저장 → 만료 관리 복잡
- [Rejected] state.vscdb에서 refresh token 추출 → 계정 전환 시 갱신 안 됨
- [Rejected] **OOB OAuth** (`urn:ietf:wg:oauth:2.0:oob`) → Google 폐지 (400 invalid_request)

---

## 🔄 Cluster: Account Switching

### Current Understanding
- [Estimated] 스냅샷 저장/복원은 구현됨, 검증 필요
- [Estimated] `state.vscdb` 직접 수정 방식

### Key Decisions
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-01 | vscdb 직접 수정 | 폴더 복사보다 효율적 |

---

## 🤖 Cluster: Auto Accept (CDP + 명령어)

### Current Understanding
- [Verified] CDP 연결로 버튼 감지 및 클릭
- [2026-02-06] 선택자 확장됨: `btn`, `role="button"`, `action` 클래스
- [2026-02-06] 자체 버튼 제외: `auto-accept`, `rerevolve`, `quota`
- **[v3.1] VS Code 명령어 직접 호출 추가** (하이브리드)
- **[v3.1] 참조: Ricco6/always-accept-antigravity**
- **[v6.6.0] browser-level WebSocket 추가** - `/json/version`으로 메인 UI 접근
  - `/json/list`에 worker만 노출되는 Electron 앱 대응
  - `Target.getTargets()` → `Target.attachToTarget()` → `Runtime.evaluate`

### Antigravity Accept 명령어 (1순위)
```
antigravity.agent.acceptAgentStep       - 에이전트 스텝 승인
antigravity.terminalCommand.accept      - 터미널 명령 승인
antigravity.prioritized.agentAcceptFocusedHunk - Diff Hunk 승인
antigravity.command.accept              - 일반 명령 승인
antigravity.terminalCommand.run         - 터미널 명령 실행
```

### Key Decisions
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-05 | REJECT_PATTERNS에 자체 버튼 추가 | 무한 클릭 방지 |
| 2026-02-06 | 상태바 피드백 추가 | 작동 여부 확인용 |
| 2026-02-06 | **VS Code 명령어 1순위 도입** | CDP DOM 클릭보다 안정적 |
| 2026-02-10 | **browser-level WebSocket 추가** | `/json/list`에 page 없고 worker만 노출 |

### 참고 자료 (GitHub)
| 프로젝트 | 설명 | 참고 내용 |
|----------|------|-----------|
| [Ricco6/always-accept-antigravity](https://github.com/Ricco6/always-accept-antigravity) | Auto Proceed Extension | **Antigravity 명령어 5개 발견** |
| [Munkhin/auto-accept-agent](https://github.com/Munkhin/auto-accept-agent) | Auto Accept for Antigravity | CDP Handler 구조, 백그라운드 모드 |
| [Rodhayl/antigravity-multi-purpose-agent](https://github.com/Rodhayl/antigravity-multi-purpose-agent) | 통합 확장 | Auto-Approve 기능 |

---

## 📊 Cluster: Quota API

### Current Understanding
- [Verified] 엔드포인트: `https://web2.cursor.sh/auth/loadCodeAssist`
- [Verified] 인증: Bearer Token (Access Token)

---

## 🔧 Cluster: Toolkit for Antigravity (참고용)

### Extension Info
- **이름**: Toolkit for Antigravity (이전: Antigravity Panel)
- **식별자**: `n2ns.antigravity-panel`
- **버전**: 2.5.11
- **다운로드**: 62k
- **개발사**: N2N Synthetics
- **라이선스**: Apache 2.0
- **저장소**: https://github.com/n2ns/antigravity-panel

### 특징
- Quota Monitoring (실시간)
- Usage Analytics (차트)
- Cache Management
- Native Integration

### Current Understanding
- [Verified] **Language Server HTTP API로 직접 통신** - 파일 읽기 아님!
- [Verified] `ProcessFinder`로 Language Server 프로세스 자동 감지
- [Verified] 포트 + CSRF 토큰 추출하여 HTTP POST 요청
- [Verified] 갱신 주기: `dashboard.refreshRate` 설정값 (기본 60초?)
- [2026-02-06] 우리 앱보다 갱신 주기가 길지만 (1-2분 vs 30초) 더 빠르게 반응

### 기술 분석 (Verified)
| 항목 | ReRevolve | Toolkit |
|------|-----------|---------|
| **쿼터 감지** | state.vscdb 파일 읽기 | Language Server HTTP API |
| **계정 감지** | state.vscdb 파일 읽기 | Language Server API 응답 |
| **통신 방식** | 파일 시스템 | HTTP (localhost:PORT) |
| **반응 속도** | 느림 (파일 플러시 대기) | 빠름 (실시간) |
| **서버 감지** | 없음 (고정 경로) | ProcessFinder (프로세스 스캔) |

### 소스 참조
- **저장소**: https://github.com/n2ns/antigravity-panel
- **QuotaService**: `src/model/services/quota.service.ts`
- **ProcessFinder**: `src/shared/platform/process_finder.ts`
- **API 경로**: `system.apiPath` 설정값 (loadCodeAssist 유사)

---

## ✅ TODO

- [ ] Toolkit 소스 분석하여 실제 감지 방식 확인
- [ ] 계정 전환 기능 검증
- [ ] UI 버튼 이름 변경 ("토큰 캡처" → "계정 저장")
- [ ] SonarQube 경고 수정