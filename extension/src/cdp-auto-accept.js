/**
 * CDP Auto-Accept Script (ReRevolve)
 * 
 * Based on AAA (Auto Accept Agent) by MunKhin - MIT License
 * Copyright (c) 2025-2026 MunKhin.
 * 
 * Simplified for ReRevolve: Simple mode only (no Background tab cycling).
 * This script is injected into the Antigravity renderer via CDP Runtime.evaluate.
 */
(function() {
    'use strict';

    // Prevent double-injection
    if (window.__autoAcceptState && window.__autoAcceptState.isRunning) {
        return;
    }

    const PREFIX = '[ReRevolve-AutoAccept]';
    function log(msg) {
        console.log(`${PREFIX} ${msg}`);
    }

    // ===== DOM Helpers =====
    function queryAll(selector) {
        const results = [];
        for (const doc of getDocuments()) {
            try {
                results.push(...doc.querySelectorAll(selector));
            } catch (e) {}
        }
        return results;
    }

    function getDocuments() {
        const docs = [document];
        try {
            const iframes = document.querySelectorAll('iframe');
            for (const iframe of iframes) {
                try {
                    if (iframe.contentDocument) {
                        docs.push(iframe.contentDocument);
                    }
                } catch (e) {}
            }
        } catch (e) {}
        return docs;
    }

    // ===== Button Detection =====
    const ACCEPT_KEYWORDS = [
        'accept', 'run', 'retry', 'apply', 'execute',
        'confirm', 'always allow', 'allow once', 'allow',
        'proceed', 'approve', 'continue', 'yes'
    ];
    const REJECT_KEYWORDS = [
        'skip', 'reject', 'cancel', 'close', 'refine',
        'deny', 'dismiss', 'no thanks'
    ];

    // Antigravity-specific button selectors
    const BUTTON_SELECTORS = [
        '.bg-ide-button-background',
        'button.bg-primary',
        'button.rounded-l',
        'button[class*="accept"]',
        'button[class*="approve"]',
        'button[class*="run"]',
    ];

    function isAcceptButton(el) {
        const text = (el.textContent || '').trim().toLowerCase();
        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        const title = (el.getAttribute('title') || '').toLowerCase();
        const combined = `${text} ${ariaLabel} ${title}`;

        // Check reject first
        for (const r of REJECT_KEYWORDS) {
            if (combined.includes(r)) return false;
        }

        // Check accept keywords
        for (const a of ACCEPT_KEYWORDS) {
            if (combined.includes(a)) return true;
        }

        return false;
    }

    function isVisible(el) {
        if (!el || !el.offsetParent && el.style.position !== 'fixed') return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return true;
    }

    function isBannedCommand(el) {
        const state = window.__autoAcceptState;
        if (!state || !state.bannedCommands || state.bannedCommands.length === 0) return false;

        // Look for command text near the button
        const parent = el.closest('[class*="terminal"], [class*="command"], [class*="step"]');
        if (!parent) return false;
        const text = (parent.textContent || '').toLowerCase();

        for (const pattern of state.bannedCommands) {
            if (text.includes(pattern.toLowerCase())) {
                return true;
            }
        }
        return false;
    }

    // ===== Click Logic =====
    function clickAcceptButtons() {
        const state = window.__autoAcceptState;
        if (!state || !state.isRunning) return;

        // Pause when user is interacting
        if (state.userInteracting) return;

        let clicked = 0;

        // Method 1: Specific Antigravity selectors
        for (const selector of BUTTON_SELECTORS) {
            const buttons = queryAll(selector);
            for (const btn of buttons) {
                if (!isVisible(btn)) continue;
                if (!isAcceptButton(btn)) continue;
                if (isBannedCommand(btn)) {
                    state.blocked = (state.blocked || 0) + 1;
                    log(`Blocked: "${(btn.textContent || '').trim().substring(0, 30)}"`);
                    continue;
                }

                btn.dispatchEvent(new MouseEvent('click', {
                    view: window,
                    bubbles: true,
                    cancelable: true
                }));
                state.clicks = (state.clicks || 0) + 1;
                clicked++;
                log(`Clicked: "${(btn.textContent || '').trim().substring(0, 30)}"`);
            }
        }

        // Method 2: Generic button scan (fallback)
        if (clicked === 0) {
            const allButtons = queryAll('button');
            for (const btn of allButtons) {
                if (!isVisible(btn)) continue;
                if (!isAcceptButton(btn)) continue;
                if (isBannedCommand(btn)) {
                    state.blocked = (state.blocked || 0) + 1;
                    continue;
                }

                // Only click if the button looks like an action button (not navigation/UI)
                const rect = btn.getBoundingClientRect();
                if (rect.width < 30 || rect.height < 20) continue;

                btn.dispatchEvent(new MouseEvent('click', {
                    view: window,
                    bubbles: true,
                    cancelable: true
                }));
                state.clicks = (state.clicks || 0) + 1;
                clicked++;
                log(`Clicked (fallback): "${(btn.textContent || '').trim().substring(0, 30)}"`);
            }
        }
    }

    // ===== State & Public API =====
    if (!window.__autoAcceptState) {
        window.__autoAcceptState = {
            isRunning: false,
            sessionID: 0,
            clicks: 0,
            blocked: 0,
            fileEdits: 0,
            terminalCommands: 0,
            clickInterval: null,
            mode: null,
            ide: null,
            pollInterval: 1000,
            bannedCommands: [],
            userInteracting: false,
            _userInteractingTimer: null,
            _onUserInteract: null
        };
    }

    window.__autoAcceptGetStats = function() {
        const s = window.__autoAcceptState || {};
        return {
            clicks: s.clicks || 0,
            blocked: s.blocked || 0,
            fileEdits: s.fileEdits || 0,
            terminalCommands: s.terminalCommands || 0
        };
    };

    window.__autoAcceptStart = function(config) {
        const state = window.__autoAcceptState;

        // Stop if already running
        if (state.isRunning) {
            window.__autoAcceptStop();
        }

        state.isRunning = true;
        state.sessionID++;
        state.mode = 'simple';
        state.ide = (config.ide || 'antigravity').toLowerCase();
        state.pollInterval = config.pollInterval || 1000;
        state.userInteracting = false;
        if (state._userInteractingTimer) {
            clearTimeout(state._userInteractingTimer);
            state._userInteractingTimer = null;
        }

        // Pause clicking when user mousedowns
        if (state._onUserInteract) {
            document.removeEventListener('mousedown', state._onUserInteract, true);
        }
        const onUserInteract = function() {
            const s = window.__autoAcceptState;
            if (!s || !s.isRunning) return;
            s.userInteracting = true;
            if (s._userInteractingTimer) clearTimeout(s._userInteractingTimer);
            s._userInteractingTimer = setTimeout(function() {
                s.userInteracting = false;
            }, 1500);
        };
        state._onUserInteract = onUserInteract;
        document.addEventListener('mousedown', onUserInteract, true);

        // Apply banned commands
        if (config.bannedCommands) {
            state.bannedCommands = Array.isArray(config.bannedCommands) ? config.bannedCommands : [];
        }

        // Start clicking loop
        state.clickInterval = setInterval(function() {
            if (state.isRunning) {
                clickAcceptButtons();
            }
        }, state.pollInterval);

        log('Active! (ReRevolve CDP Auto-Accept)');
    };

    window.__autoAcceptStop = function() {
        const state = window.__autoAcceptState;
        state.isRunning = false;

        if (state.clickInterval) {
            clearInterval(state.clickInterval);
            state.clickInterval = null;
        }

        if (state._onUserInteract) {
            document.removeEventListener('mousedown', state._onUserInteract, true);
            state._onUserInteract = null;
        }
        if (state._userInteractingTimer) {
            clearTimeout(state._userInteractingTimer);
            state._userInteractingTimer = null;
        }
        state.userInteracting = false;

        log('Stopped');
    };

    // Compatibility
    window.__autoAcceptSetFocusState = function() {};
    window.__autoAcceptUpdateBannedCommands = function(bannedList) {
        const state = window.__autoAcceptState;
        if (state) {
            state.bannedCommands = Array.isArray(bannedList) ? bannedList : [];
        }
    };

    log('Ready (ReRevolve)');
})();
