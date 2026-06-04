# Antigravity 2.0 Auto Retry & ReRevolve 2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 안티그래비티 2.0 웹 환경을 위한 ReRevolve 2.0 하이브리드 시스템(유저스크립트 + 로컬 백엔드)을 구축하고, 서버 에러 팝업의 "Retry" 버튼을 0.5초 이내에 자동 클릭하여 무중단 복구하도록 구현합니다.

**Architecture:** 
1. **Urgent Phase**: 브라우저 DOM 변화를 감지하는 `MutationObserver` 기반의 Tampermonkey UserScript(`rerevolve.user.js`)를 작성하여 "Agent terminated due to error" 팝업 감지 시 파란색 [Retry] 버튼을 자동으로 강제 클릭합니다.
2. **Expansion Phase**: 로컬 리소스 접근 및 계정 전환 제어를 위해 PC 백그라운드에서 실행되는 Node.js 데몬 서버(`server.js`)를 띄우고, UserScript UI와 통신하여 멀티 계정 쿼터 대시보드 토글 기능을 완성합니다.

**Tech Stack:** JavaScript (ES6+), Tampermonkey/UserScript API, MutationObserver, Node.js, Express (or Native http)

---

### Task 1: [Urgent] 에러 팝업 Retry 자동 클릭 UserScript 구현

**Files:**
- Create: `rerevolve.user.js` (프로젝트 루트 최상위 디렉토리)
- Test: `test-auto-retry.html` (가상 팝업 테스트용 로컬 HTML)

- [ ] **Step 1: `rerevolve.user.js` 초기 스크립트 뼈대 및 Retry 자동 감지 로직 작성**
  * 브라우저의 DOM 변화를 감시하는 `MutationObserver`와 2초 디바운스 안전장치를 포함하여 자동 클릭 코드 작성.
  
  ```javascript
  // ==UserScript==
  // @name         Antigravity 2.0 Auto Retry & ReRevolve
  // @namespace    http://tampermonkey.net/
  // @version      0.1
  // @description  Automatically click Retry button on Antigravity 2.0 errors and toggle ReRevolve dashboard.
  // @author       Antigravity
  // @match        http://localhost:*/*
  // @match        http://127.0.0.1:*/*
  // @match        https://*.gemini.antigravity/*
  // @grant        none
  // ==/UserScript==

  (function() {
      'use strict';

      const ERROR_TEXTS = ["Agent terminated due to error", "try again", "error persists"];
      let lastRetryTime = 0;

      function checkAndClickRetry() {
          const now = Date.now();
          if (now - lastRetryTime < 2000) return; // 2초 디바운스 (연속 클릭 방지)

          const bodies = document.body.innerText;
          const hasError = ERROR_TEXTS.some(text => bodies.includes(text));

          if (hasError) {
              const buttons = document.querySelectorAll('button');
              for (let btn of buttons) {
                  if (btn.textContent.trim() === 'Retry') {
                      console.log("[ReRevolve] 에러 팝업 감지! [Retry] 버튼을 자동으로 클릭합니다.");
                      btn.click();
                      lastRetryTime = now;
                      break;
                  }
              }
          }
      }

      // MutationObserver로 DOM의 실시간 변화 추적
      const observer = new MutationObserver((mutations) => {
          checkAndClickRetry();
      });

      observer.observe(document.body, {
          childList: true,
          subtree: true
      });

      // Fallback: 500ms 간격 주기적 체크
      setInterval(checkAndClickRetry, 500);

      console.log("[ReRevolve] Auto Retry 유저스크립트 활성화 완료.");
  })();
  ```

- [ ] **Step 2: 로컬 가상 팝업 테스트 환경 작성**
  * `test-auto-retry.html` 파일을 생성하여, 유저스크립트 동작을 오프라인에서 검증할 수 있는 가상 에러 팝업 테스트 페이지 작성.
  
  ```html
  <!DOCTYPE html>
  <html>
  <head>
      <title>Auto Retry Test Page</title>
  </head>
  <body>
      <h1>Antigravity 2.0 Mock Error Test</h1>
      <button onclick="triggerErrorPopup()">가상 에러 팝업 띄우기</button>
      <div id="popup-area"></div>

      <script>
          function triggerErrorPopup() {
              const popup = document.createElement('div');
              popup.style.border = '1px solid #ccc';
              popup.style.padding = '20px';
              popup.style.margin = '20px';
              popup.style.backgroundColor = '#f9f9f9';
              popup.innerHTML = `
                  <p>Agent terminated due to error</p>
                  <p>You can prompt the model to try again...</p>
                  <button id="mock-retry-btn" onclick="alert('Retry 클릭됨!')">Retry</button>
              `;
              document.getElementById('popup-area').appendChild(popup);
          }
      </script>
  </body>
  </html>
  ```

- [ ] **Step 3: 가상 팝업 환경에서 유저스크립트 동작 및 자동 클릭 검증**
  * 브라우저에서 `test-auto-retry.html`을 열고, 작성된 `rerevolve.user.js`를 Tampermonkey에 등록 후 작동 테스트.
  * "가상 에러 팝업 띄우기" 버튼 클릭 시, 0.5초 내에 'Retry 클릭됨!' 얼럿이 뜨는지 확인.

- [ ] **Step 4: 로컬 Git 커밋 진행**
  ```bash
  git add rerevolve.user.js test-auto-retry.html
  git commit -m "feat: add urgent error auto-retry UserScript and mock test"
  ```

---

### Task 2: 안티그래비티 2.0 UI 내 ReRevolve 탭 토글 뼈대 구현

**Files:**
- Modify: `rerevolve.user.js`

- [ ] **Step 1: 안티그래비티 2.0의 좌측 상단 헤더 선택자 탐색 및 아이콘 주입 코드 추가**
  * 안티그래비티 2.0 웹 페이지의 DOM을 스캔하여 좌측 상단 화살표 `<-` `->` 및 `New Conversation` 주위의 DOM 선택자를 찾아내고, 해당 위치에 `🔄` 버튼을 삽입하는 헬퍼 함수 작성.
- [ ] **Step 2: 대시보드 화면 토글 및 전환 뼈대 렌더링**
  * 아이콘 클릭 시, 채팅창 컨테이너의 스타일을 `display: none`으로 전환하고, 그 위치에 `#rerevolve-dashboard-container` 커스텀 div를 주입하여 modern UI 레이아웃(그리드) 뼈대 삽입.
- [ ] **Step 3: 화면 원상복구(토글) 검증**
  * `🔄` 아이콘을 다시 누르면 커스텀 대시보드 노드가 안전하게 삭제되고, 숨겨졌던 기존 대화창 컨테이너가 아무 문제 없이 원상복구되는지 확인.
- [ ] **Step 4: 로컬 Git 커밋 진행**
  ```bash
  git add rerevolve.user.js
  git commit -m "feat: implement ReRevolve icon injection and dashboard toggle shell"
  ```

---

### Task 3: 로컬 Node.js 백엔드 API 데몬 서버 구축

**Files:**
- Create: `server.js` (프로젝트 루트 최상위 디렉토리)
- Create: `package.json` (server용 디렉토리가 필요한지, 혹은 루트 package.json 활용 여부 결정)

- [ ] **Step 1: 가벼운 Node.js API 서버 구축 및 포트 대기 (`localhost:8320`)**
  * 외부 라이브러리 의존성을 최소화하기 위해 Node.js 내장 `http` 모듈 또는 가벼운 express를 사용하여 CORS가 허용된 API 서버 초기화.
- [ ] **Step 2: 로컬 `state.vscdb` 및 `accounts.json` 조회 API 구현**
  * `%APPDATA%/Antigravity/User/globalStorage/state.vscdb` 파일 읽기 및 `accounts.json` 데이터를 반환하는 `GET /api/accounts` API 구현.
- [ ] **Step 3: Language Server 쿼터 및 계정 전환 API 구현**
  * 프로세스 리스트에서 안티그래비티 Language Server 포트를 감지하고 HTTP 통신으로 실시간 쿼터를 반환하는 `GET /api/status` API 구현.
  * 계정 전환(`POST /api/switch`) 시 `state.vscdb` 수정 및 OAuth Sentinel Key 패치 처리.
- [ ] **Step 4: 로컬 Git 커밋 진행**
  ```bash
  git add server.js
  git commit -m "feat: implement Node.js local API daemon server"
  ```

---

### Task 4: 프론트엔드-백엔드 연동 및 대시보드 UI 연동 완성

**Files:**
- Modify: `rerevolve.user.js`

- [ ] **Step 1: UserScript에서 로컬 데몬 API 연동 (Fetch)**
  * 대시보드 활성화 시 `fetch('http://localhost:8320/api/status')`를 호출하여 현재 활성 계정과 쿼터 퍼센트, 충전 남은 시간을 갱신해 UI에 그리도록 연동.
- [ ] **Step 2: 멀티 계정 리스트 렌더링 및 전환 클릭 액션 완성**
  * 대시보드 화면에 전체 멀티 계정 목록을 테이블/카드로 렌더링하고, 클릭 시 `POST /api/switch` API를 호출한 뒤 웹 브라우저 창을 새로고침(`location.reload()`)하도록 연동.
- [ ] **Step 3: 최종 연동 검증 및 배포 준비**
  * `rerevolve.user.js`와 `server.js`를 전체 구동하여, 팝업 자동 클릭, 토글 전환, 계정 연동 및 새로고침이 오차 없이 일어나는지 종합 검증.
- [ ] **Step 4: 로컬 Git 커밋 진행**
  ```bash
  git add rerevolve.user.js
  git commit -m "feat: complete full E2E ReRevolve 2.0 dashboard integration"
  ```
