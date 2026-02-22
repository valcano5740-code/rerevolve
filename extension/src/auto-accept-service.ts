import * as vscode from 'vscode';

export class AutoAcceptService {
    private _enabled: boolean = false;
    private _intervalId: NodeJS.Timeout | null = null;
    private readonly POLL_INTERVAL = 200; // 200ms for ultra-low latency
    private _statusChangeListeners: ((enabled: boolean) => void)[] = [];

    // Antigravity Native Commands for accepting AI actions
    private readonly ACCEPT_COMMANDS = [
        'antigravity.agent.acceptAgentStep',
        'antigravity.command.accept',
        'antigravity.prioritized.agentAcceptAllInFile',
        'antigravity.prioritized.agentAcceptFocusedHunk',
        'antigravity.prioritized.supercompleteAccept',
        'antigravity.terminalCommand.accept',
        'antigravity.acceptCompletion',
        'antigravity.prioritized.terminalSuggestion.accept',
        'antigravity.prioritized.tabJumpAccept',
        'antigravity.cascade.acceptSuggestedAction'
    ];

    constructor() {
        console.log('ReRevolve: AutoAcceptService (Native Mode) initialized.');
    }

    public get isEnabled(): boolean {
        return this._enabled;
    }

    public onStatusChange(listener: (enabled: boolean) => void): void {
        this._statusChangeListeners.push(listener);
    }

    private notifyListeners(): void {
        for (const listener of this._statusChangeListeners) {
            listener(this._enabled);
        }
    }

    public toggle(): void {
        if (this._enabled) {
            this.stop();
            vscode.window.showInformationMessage('🛑 Auto-Accept 중지됨');
        } else {
            this.start();
            vscode.window.showInformationMessage('🚀 Auto-Accept 활성화! (안정성 모드, 200ms)');
        }
    }

    public start(): void {
        if (this._enabled) return;
        this._enabled = true;
        this.notifyListeners();

        console.log('ReRevolve: Auto-Accept loop started (200ms interval)');

        this._intervalId = setInterval(async () => {
            if (!this._enabled) return;

            // Execute all possible accept commands silently
            for (const cmd of this.ACCEPT_COMMANDS) {
                try {
                    await vscode.commands.executeCommand(cmd);
                } catch (e) {
                    // Fail silently, as most commands won't apply at a given moment
                }
            }
        }, this.POLL_INTERVAL);
    }

    public stop(): void {
        if (!this._enabled) return;
        this._enabled = false;
        this.notifyListeners();

        if (this._intervalId) {
            clearInterval(this._intervalId);
            this._intervalId = null;
        }
        console.log('ReRevolve: Auto-Accept loop stopped');
    }

    public dispose(): void {
        this.stop();
    }
}
