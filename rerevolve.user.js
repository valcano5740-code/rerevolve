// ==UserScript==
// @name         Antigravity 2.0 Auto Retry & ReRevolve
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Automatically click the Retry button on Antigravity 2.0 errors with an ON/OFF toggle switch next to Settings.
// @author       Antigravity Pair Programmer
// @match        http://localhost:*/*
// @match        http://127.0.0.1:*/*
// @match        https://*.gemini.antigravity/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 1. 상태 변수 및 설정 정의
    const STORAGE_KEY = 'rerevolve_auto_retry_active';
    const ERROR_TEXTS = ["Agent terminated due to error", "try again", "error persists", "troubleshooting_guide"];
    let isRetryEnabled = localStorage.getItem(STORAGE_KEY) !== 'false'; // 기본값은 ON(true)
    let lastRetryTime = 0;

    console.log(`[ReRevolve] 초기화 중... Auto Retry 상태: ${isRetryEnabled ? 'ON' : 'OFF'}`);

    // 2. Retry 버튼 자동 클릭 핵심 로직
    function checkAndClickRetry() {
        if (!isRetryEnabled) return; // 기능이 비활성화(OFF) 상태면 작동하지 않음

        const now = Date.now();
        if (now - lastRetryTime < 3000) return; // 3초 디바운싱 (연속 클릭 방지)

        const bodies = document.body.innerText;
        const hasError = ERROR_TEXTS.some(text => bodies.includes(text));

        if (hasError) {
            const buttons = document.querySelectorAll('button');
            for (let btn of buttons) {
                if (btn.textContent.trim() === 'Retry') {
                    console.log("[ReRevolve] 에러 팝업 감지! [Retry] 버튼을 자동으로 강제 클릭합니다.");
                    btn.click();
                    lastRetryTime = now;
                    showTemporaryToast("🤖 Auto Retry 작동! 에러를 자동 복구했습니다.");
                    break;
                }
            }
        }
    }

    // 3. UI 알림 Toast 헬퍼
    function showTemporaryToast(message) {
        const toast = document.createElement('div');
        toast.style.position = 'fixed';
        toast.style.bottom = '20px';
        toast.style.right = '20px';
        toast.style.backgroundColor = '#10B981';
        toast.style.color = '#FFFFFF';
        toast.style.padding = '10px 20px';
        toast.style.borderRadius = '8px';
        toast.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)';
        toast.style.zIndex = '99999';
        toast.style.fontFamily = 'sans-serif';
        toast.style.fontSize = '14px';
        toast.style.transition = 'opacity 0.5s ease';
        toast.innerText = message;

        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 500);
        }, 3000);
    }

    // 4. Settings 옆 ON/OFF 토글 버튼 동적 주입 로직
    function injectToggleButton() {
        // 이미 버튼이 존재한다면 추가로 삽입하지 않음 (Idempotency)
        if (document.getElementById('rerevolve-auto-retry-btn')) {
            updateButtonAppearance();
            return;
        }

        // Settings 텍스트를 포함하고 있거나 Settings 메뉴의 역할을 하는 엘리먼트 탐색
        let settingsElement = null;
        
        // 방법 A: 텍스트 매칭
        const allElements = document.querySelectorAll('div, button, a, span');
        for (let el of allElements) {
            if (el.childNodes.length === 1 || (el.childNodes.length > 1 && el.textContent.trim().includes('Settings'))) {
                const text = el.textContent.trim();
                if (text === 'Settings' || text === '⚙ Settings' || text.endsWith('Settings')) {
                    // 가장 겉의 부모 요소 또는 자기 자신을 Settings 노드로 획득
                    settingsElement = el.closest('button') || el.closest('a') || el.closest('div') || el;
                    break;
                }
            }
        }

        // 방법 B: 기어 모양 아이콘이나 settings 가 들어간 클래스명/아이디 Fallback
        if (!settingsElement) {
            settingsElement = document.querySelector('[class*="settings" i]') || 
                              document.querySelector('[id*="settings" i]');
        }

        if (settingsElement) {
            const parent = settingsElement.parentElement;
            if (!parent) return;

            // 버튼 생성
            const toggleBtn = document.createElement('button');
            toggleBtn.id = 'rerevolve-auto-retry-btn';
            
            // 프리미엄 디자인 스타일링
            toggleBtn.style.marginLeft = '10px';
            toggleBtn.style.padding = '4px 8px';
            toggleBtn.style.borderRadius = '6px';
            toggleBtn.style.fontSize = '12px';
            toggleBtn.style.fontWeight = 'bold';
            toggleBtn.style.cursor = 'pointer';
            toggleBtn.style.border = '1px solid';
            toggleBtn.style.display = 'inline-flex';
            toggleBtn.style.alignItems = 'center';
            toggleBtn.style.gap = '4px';
            toggleBtn.style.transition = 'all 0.2s ease';
            toggleBtn.style.fontFamily = 'sans-serif';

            // 토글 이벤트 리스너 추가
            toggleBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                isRetryEnabled = !isRetryEnabled;
                localStorage.setItem(STORAGE_KEY, isRetryEnabled);
                updateButtonAppearance();
                console.log(`[ReRevolve] Auto Retry 토글 클릭! 상태 변경됨: ${isRetryEnabled ? 'ON' : 'OFF'}`);
                showTemporaryToast(`🔄 Auto Retry 가 ${isRetryEnabled ? '활성화(ON)' : '비활성화(OFF)'} 되었습니다.`);
            });

            // Settings 엘리먼트 옆(형제 노드)으로 주입
            settingsElement.style.display = 'inline-flex';
            settingsElement.style.alignItems = 'center';
            
            // Settings 노드 뒤에 삽입
            settingsElement.after(toggleBtn);
            updateButtonAppearance();
            console.log("[ReRevolve] Settings 메뉴 옆에 Auto Retry 토글 버튼을 성공적으로 주입했습니다.");
        }
    }

    // 5. 활성 상태에 따라 버튼 모습 실시간 변경
    function updateButtonAppearance() {
        const btn = document.getElementById('rerevolve-auto-retry-btn');
        if (!btn) return;

        if (isRetryEnabled) {
            // ON 상태: 초록색 강조
            btn.innerHTML = '🟢 Retry ON';
            btn.style.backgroundColor = '#065F46'; // 어두운 그린
            btn.style.color = '#34D399'; // 밝은 민트
            btn.style.borderColor = '#047857';
            btn.title = '에러 팝업 발생 시 자동으로 Retry를 클릭합니다 (클릭 시 비활성화)';
        } else {
            // OFF 상태: 회색 차분한 색
            btn.innerHTML = '⚫ Retry OFF';
            btn.style.backgroundColor = '#374151'; // 짙은 회색
            btn.style.color = '#9CA3AF'; // 연회색
            btn.style.borderColor = '#4B5563';
            btn.title = '자동 Retry가 꺼져 있습니다 (클릭 시 활성화)';
        }
    }

    // 6. 감시 및 폴링 시작
    const domObserver = new MutationObserver((mutations) => {
        checkAndClickRetry();
        injectToggleButton(); // SPA 화면 변화 시 Settings 재탐색 주입
    });

    domObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

    // 멱등성 보장을 위한 1초 주기 감시 (SPA 보완용)
    setInterval(() => {
        checkAndClickRetry();
        injectToggleButton();
    }, 1000);

    // 즉시 실행
    setTimeout(() => {
        injectToggleButton();
        checkAndClickRetry();
    }, 500);

})();
