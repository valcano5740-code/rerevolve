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
- [Verified] 저장 위치: VSCode SecretStorage (`rerevolve.token.{email}`)
- [Verified] 디버그 파일: `~/.rerevolve-debug/{email}.json`
- [v6.4.0] **Refresh Token만 저장** - Access Token은 쿼터 조회 시 발급
- [v6.4.0] **Language Server API**로 활성 계정 실시간 감지 (3회 재시도 → vscdb fallback)

### Key Decisions
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-05 | oauthToken을 primary로 사용 | jetski보다 안정적 |
| 2026-02-05 | 클릭한 계정에 저장 | 활성 계정 감지 불안정 |
| 2026-02-06 | 자동 복구 기능 제거 | 잘못된 계정 토큰 저장 버그 |
| 2026-02-06 | Refresh Token만 저장 | 안정적 토큰 관리 |
| 2026-02-06 | Language Server API 도입 | 실시간 활성 계정 감지 |

### Rejected Approaches
- [Rejected] tryAutoRecovery → 활성 계정 감지 불안정으로 잘못된 토큰 저장
- [Rejected] jetski-only 추출 → 불완전한 토큰 반환
- [Rejected] Access Token 저장 → 만료 관리 복잡

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

## 🤖 Cluster: Auto Accept (CDP)

### Current Understanding
- [Verified] CDP 연결로 버튼 감지 및 클릭
- [2026-02-06] 선택자 확장됨: `btn`, `role="button"`, `action` 클래스
- [2026-02-06] 자체 버튼 제외: `auto-accept`, `rerevolve`, `quota`

### Key Decisions
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-05 | REJECT_PATTERNS에 자체 버튼 추가 | 무한 클릭 방지 |
| 2026-02-06 | 상태바 피드백 추가 | 작동 여부 확인용 |

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