---
description: AI 에이전트의 컨텍스트 유지 및 문서 관리 워크플로우
---

# Universal AI Context Management

## Purpose
AI 에이전트가 개발 작업 중 컨텍스트를 유지하고 문서를 깔끔하게 관리하기 위한 범용 가이드.
핵심 원칙: **Traceability > Omission** — 불확실한 정보도 적절한 마커와 함께 기록.

---

## [Document Lifecycle Rules]

### 1. Create & Update Freely
- AI는 `CONTEXT_MAP.md`를 매 작업 후 **승인 없이** 업데이트.
- 새로운 기능이나 실험은 즉시 별도 클러스터 생성.

### 2. Consolidate, Don't Lose Context
- 여러 시도가 있을 때 → 최종 결과 중심으로 통합.
- 실패한 접근법은 **한 줄 요약**으로 유지 (왜 실패했는지).
- 흔적 없이 삭제 금지.

### 3. Promote & Archive
- 검증된 정보 → **Current Understanding**으로 승격.
- 오래된 섹션 → `[Legacy]` 마킹 또는 아카이브 파일로 이동.

---

## [Memory Structure]

### Shared Cluster (Global Context)
모든 기능에 공통으로 적용되는 정보:
- 인증 / API 엔드포인트
- 프로젝트 구조 개요
- 주요 파일 위치

### Feature Clusters (Per-Feature Context)
각 기능별 섹션 구성:

| Section | Purpose | Example |
|---------|---------|---------|
| **Current Understanding** | 현재 AI가 참이라 믿는 것 | "토큰은 `apiKey` 필드에 있음" |
| **Key Decisions** | 현재 접근법 선택 이유 | "신뢰성 때문에 oauthToken 선택" |
| **Rejected Approaches** | 실패한 시도 한 줄 요약 | "[Rejected] jetski-only: 불완전한 토큰" |

---

## [Feature Cluster Template]

```markdown
### Cluster: [Feature Name]

#### Current Understanding
- [2026-02-06] 메인 진입점은 `extension.ts`
- [Estimated] 토큰 만료 시간 1시간 (미검증)

#### Key Decisions
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-05 | oauthToken을 primary로 사용 | jetski보다 안정적 |

#### Rejected Approaches
- jetski-only 추출 → 불완전한 토큰 반환
- localStorage 방식 → 확장 컨텍스트에서 접근 불가
```

---

## [Operating Protocol]

### On Task Start
1. `CONTEXT_MAP.md` 읽어서 컨텍스트 로드.
2. 현재 작업에 관련된 클러스터 식별.

### On Task Completion
1. **Current Understanding**에 검증된 발견 업데이트.
2. 중요한 선택이 있었다면 **Key Decisions**에 추가.
3. 실패한 시도는 **Rejected Approaches**로 이동 (한 줄만).

### On Confusion / Context Loss
1. 멈추고 `CONTEXT_MAP.md` 다시 읽기.
2. 여전히 불명확하면 추측 대신 사용자에게 질문.

### Periodic Cleanup
- 클러스터가 ~50줄 초과 → 오래된 항목 통합.
- 결정이 대체됨 → `[Superseded by X]`로 아카이브.

---

## [Markers Reference]

| Marker | Meaning |
|--------|---------|
| `[Estimated]` | 미검증 추정 |
| `[Verified]` | 테스트로 확인됨 |
| `[Rejected]` | 시도 후 폐기 |
| `[Legacy]` | 더 이상 적용 안 됨 |
| `[Superseded by X]` | 새 접근법으로 대체됨 |

---

## [Anti-Patterns]

❌ **Diary Mode**: 통합 없이 모든 시도를 날짜순 기록.
❌ **Silent Deletion**: 이유 없이 정보 삭제.
❌ **Over-Documentation**: 한 줄로 될 걸 문단으로 작성.
❌ **Stale Context**: 오래된 "Current Understanding" 방치.
