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
- [2026-02-06] 활성 계정 감지는 불안정함 - 리로드 후에야 갱신됨

### Key Decisions
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-05 | oauthToken을 primary로 사용 | jetski보다 안정적 |
| 2026-02-05 | 클릭한 계정에 저장 | 활성 계정 감지 불안정 |
| 2026-02-06 | 자동 복구 기능 제거 | 잘못된 계정 토큰 저장 버그 |

### Rejected Approaches
- [Rejected] tryAutoRecovery → 활성 계정 감지 불안정으로 잘못된 토큰 저장
- [Rejected] jetski-only 추출 → 불완전한 토큰 반환

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

## ✅ TODO

- [ ] 계정 전환 기능 검증
- [ ] UI 버튼 이름 변경 ("토큰 캡처" → "계정 저장")
- [ ] SonarQube 경고 수정