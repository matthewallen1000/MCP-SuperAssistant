import { BaseAdapterPlugin } from './base.adapter';
import type { AdapterCapability, PluginContext } from '../plugin-types';

export class LMArenaAdapter extends BaseAdapterPlugin {
  readonly name = 'LMArenaAdapter';
  readonly version = '1.0.0';
  readonly hostnames = ['lmarena.ai'];
  readonly capabilities: AdapterCapability[] = [
    'text-insertion',
    'form-submission',
    'dom-manipulation'
  ];

  private readonly selectors = {
    CHAT_INPUT: 'textarea, div[contenteditable="true"][role="textbox"], [contenteditable="true"][data-lexical-editor="true"], div[contenteditable="true"][role="presentation"], [data-testid*="input"][contenteditable="true"]',
    SUBMIT_BUTTON: 'button[type="submit"], button[aria-label*="Send" i], button[aria-label*="Submit" i], button[data-testid*="send" i]'
  };

  private lastUrl: string = '';
  private urlCheckInterval: NodeJS.Timeout | null = null;
  private mcpPopoverContainer: HTMLElement | null = null;
  private mutationObserver: MutationObserver | null = null;
  private popoverCheckInterval: NodeJS.Timeout | null = null;
  private storeEventListenersSetup: boolean = false;
  private domObserversSetup: boolean = false;
  private uiIntegrationSetup: boolean = false;

  private static instanceCount = 0;
  private instanceId: number;

  constructor() {
    super();
    LMArenaAdapter.instanceCount++;
    this.instanceId = LMArenaAdapter.instanceCount;
    console.debug(`[LMArenaAdapter] Instance #${this.instanceId} created`);
  }

  async initialize(context: PluginContext): Promise<void> {
    if (this.currentStatus === 'initializing' || this.currentStatus === 'active') {
      this.context?.logger.warn(`LMArena adapter instance #${this.instanceId} already initialized or active`);
      return;
    }

    await super.initialize(context);
    this.context.logger.debug(`Initializing LMArena adapter instance #${this.instanceId}`);

    this.lastUrl = window.location.href;
    this.setupUrlTracking();
    this.setupStoreEventListeners();
  }

  async activate(): Promise<void> {
    if (this.currentStatus === 'active') {
      this.context?.logger.warn(`LMArena adapter instance #${this.instanceId} already active`);
      return;
    }

    await super.activate();
    this.context.logger.debug(`Activating LMArena adapter instance #${this.instanceId}`);

    this.setupDOMObservers();
    this.setupUIIntegration();

    this.context.eventBus.emit('adapter:activated', {
      pluginName: this.name,
      timestamp: Date.now()
    });
  }

  async deactivate(): Promise<void> {
    if (this.currentStatus === 'inactive' || this.currentStatus === 'disabled') {
      this.context?.logger.warn('LMArena adapter already inactive');
      return;
    }

    await super.deactivate();
    this.context.logger.debug('Deactivating LMArena adapter');

    this.cleanupUIIntegration();
    this.cleanupDOMObservers();

    this.storeEventListenersSetup = false;
    this.domObserversSetup = false;
    this.uiIntegrationSetup = false;

    this.context.eventBus.emit('adapter:deactivated', {
      pluginName: this.name,
      timestamp: Date.now()
    });
  }

  async cleanup(): Promise<void> {
    await super.cleanup();
    this.context.logger.debug('Cleaning up LMArena adapter');

    if (this.urlCheckInterval) {
      clearInterval(this.urlCheckInterval);
      this.urlCheckInterval = null;
    }

    if (this.popoverCheckInterval) {
      clearInterval(this.popoverCheckInterval);
      this.popoverCheckInterval = null;
    }

    this.cleanupUIIntegration();
    this.cleanupDOMObservers();

    this.storeEventListenersSetup = false;
    this.domObserversSetup = false;
    this.uiIntegrationSetup = false;
  }

  async insertText(text: string, options?: { targetElement?: HTMLElement }): Promise<boolean> {
    this.context.logger.debug(`LMArena insertText: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);

    let targetElement: HTMLElement | null = options?.targetElement || null;

    if (!targetElement) {
      const selectors = this.selectors.CHAT_INPUT.split(',');
      for (const raw of selectors) {
        const selector = raw.trim();
        targetElement = document.querySelector(selector) as HTMLElement;
        if (targetElement) break;
      }
    }

    if (!targetElement) {
      this.emitExecutionFailed('insertText', 'Chat input element not found');
      return false;
    }

    try {
      const originalValue = this.getElementContent(targetElement);
      targetElement.focus();

      const range = document.createRange();
      range.selectNodeContents(targetElement);
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }

      const textToEnter = originalValue ? `${originalValue}\n\n${text}` : text;
      targetElement.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: textToEnter, bubbles: true, cancelable: true }));
      targetElement.dispatchEvent(new Event('change', { bubbles: true }));

      this.emitExecutionCompleted('insertText', { text }, {
        success: true,
        originalLength: originalValue.length,
        newLength: text.length,
        totalLength: textToEnter.length,
        method: 'InputEvent'
      });
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emitExecutionFailed('insertText', errorMessage);
      return false;
    }
  }

  async submitForm(options?: { formElement?: HTMLFormElement }): Promise<boolean> {
    this.context.logger.debug('LMArena submitForm');

    let submitButton: HTMLButtonElement | null = null;
    const selectors = this.selectors.SUBMIT_BUTTON.split(',');
    for (const raw of selectors) {
      const selector = raw.trim();
      submitButton = document.querySelector(selector) as HTMLButtonElement;
      if (submitButton) break;
    }

    if (submitButton) {
      try {
        const rect = submitButton.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          return this.submitWithEnterKey();
        }
        if (submitButton.disabled || submitButton.getAttribute('aria-disabled') === 'true') {
          return this.submitWithEnterKey();
        }
        submitButton.click();
        this.emitExecutionCompleted('submitForm', { formElement: options?.formElement?.tagName || 'unknown' }, { success: true, method: 'button.click' });
        return true;
      } catch (error) {
        return this.submitWithEnterKey();
      }
    }

    return this.submitWithEnterKey();
  }

  isSupported(): boolean | Promise<boolean> {
    const currentHost = window.location.hostname;
    return currentHost.includes('lmarena.ai');
  }

  private submitWithEnterKey(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const chatInput = document.querySelector(this.selectors.CHAT_INPUT) as HTMLElement;
        if (!chatInput) {
          this.emitExecutionFailed('submitForm', 'Chat input element not found');
          resolve(false);
          return;
        }
        chatInput.focus();
        const events = ['keydown', 'keypress', 'keyup'];
        for (const type of events) {
          chatInput.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        }
        this.emitExecutionCompleted('submitForm', {}, { success: true, method: 'enterKey' });
        resolve(true);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.emitExecutionFailed('submitForm', errorMessage);
        resolve(false);
      }
    });
  }

  private setupUrlTracking(): void {
    if (!this.urlCheckInterval) {
      this.urlCheckInterval = setInterval(() => {
        const currentUrl = window.location.href;
        if (currentUrl !== this.lastUrl) {
          if (this.onPageChanged) {
            this.onPageChanged(currentUrl, this.lastUrl);
          }
          this.lastUrl = currentUrl;
        }
      }, 1000);
    }
  }

  private setupStoreEventListeners(): void {
    if (this.storeEventListenersSetup) return;
    this.context.eventBus.on('tool:execution-completed', (data) => {
      this.handleToolExecutionCompleted(data);
    });
    this.storeEventListenersSetup = true;
  }

  private setupDOMObservers(): void {
    if (this.domObserversSetup) return;
    this.mutationObserver = new MutationObserver(() => {
      if (!document.getElementById('mcp-popover-container')) {
        const insertionPoint = this.findButtonInsertionPoint();
        if (insertionPoint) {
          this.setupUIIntegration();
        }
      }
    });
    this.mutationObserver.observe(document.body, { childList: true, subtree: true });
    this.domObserversSetup = true;
  }

  private setupUIIntegration(): void {
    if (this.uiIntegrationSetup) {
      this.context.logger.debug(`Re-injecting MCP popover for LMArena instance #${this.instanceId}`);
    } else {
      this.uiIntegrationSetup = true;
    }

    this.waitForPageReady().then(() => {
      this.injectMCPPopoverWithRetry();
    }).catch(() => {});
  }

  private async waitForPageReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 5;
      const check = () => {
        attempts++;
        const insertionPoint = this.findButtonInsertionPoint();
        if (insertionPoint) {
          resolve();
        } else if (attempts >= maxAttempts) {
          reject(new Error('No insertion point found'));
        } else {
          setTimeout(check, 500);
        }
      };
      setTimeout(check, 100);
    });
  }

  private injectMCPPopoverWithRetry(maxRetries: number = 5): void {
    const attempt = (n: number) => {
      if (document.getElementById('mcp-popover-container')) return;
      const insertionPoint = this.findButtonInsertionPoint();
      if (insertionPoint) {
        this.injectMCPPopover(insertionPoint);
      } else if (n < maxRetries) {
        setTimeout(() => attempt(n + 1), 1000);
      }
    };
    attempt(1);
  }

  private cleanupDOMObservers(): void {
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }
  }

  private cleanupUIIntegration(): void {
    if (this.mcpPopoverContainer) {
      try {
        this.mcpPopoverContainer.remove();
      } catch {}
      this.mcpPopoverContainer = null;
    }
  }

  private handleToolExecutionCompleted(data: any): void {
    if (!this.shouldHandleEvents()) return;
  }

  private findButtonInsertionPoint(): { container: Element; insertAfter: Element | null } | null {
    const main = document.querySelector('main') || document.body;
    if (!main) return null;

    const chatInput = document.querySelector(this.selectors.CHAT_INPUT);
    if (chatInput) {
      const container = chatInput.closest('form') || chatInput.parentElement || main;
      const buttons = container.querySelectorAll('button');
      const lastButton = buttons.length > 0 ? buttons[buttons.length - 1] : null;
      return { container, insertAfter: lastButton };
    }

    return { container: main, insertAfter: null };
  }

  private injectMCPPopover(insertionPoint: { container: Element; insertAfter: Element | null }): void {
    if (document.getElementById('mcp-popover-container')) return;

    const reactContainer = document.createElement('div');
    reactContainer.id = 'mcp-popover-container';
    reactContainer.style.display = 'inline-block';
    reactContainer.style.margin = '0 4px';

    const { container, insertAfter } = insertionPoint;
    if (insertAfter && insertAfter.parentNode === container) {
      container.insertBefore(reactContainer, insertAfter.nextSibling);
    } else {
      container.appendChild(reactContainer);
    }

    this.mcpPopoverContainer = reactContainer;
    this.renderMCPPopover(reactContainer);
  }

  private renderMCPPopover(container: HTMLElement): void {
    try {
      if (!container || !container.isConnected) return;
      import('react').then(React => {
        import('react-dom/client').then(ReactDOM => {
          import('../../components/mcpPopover/mcpPopover').then(({ MCPPopover }) => {
            const toggleStateManager = this.createToggleStateManager();
            const adapterButtonConfig = {
              className: 'mcp-button-base',
              contentClassName: 'mcp-button-content',
              textClassName: 'mcp-button-text',
              activeClassName: 'mcp-button-active'
            } as any;
            const root = ReactDOM.createRoot(container);
            root.render(
              React.createElement(MCPPopover, {
                toggleStateManager,
                adapterButtonConfig,
                adapterName: this.name
              })
            );
          });
        });
      });
    } catch {}
  }

  private createToggleStateManager() {
    const context = this.context;
    const stateManager = {
      getState: () => {
        try {
          const uiState = context.stores.ui;
          const mcpEnabled = uiState?.mcpEnabled ?? false;
          const autoSubmitEnabled = uiState?.preferences?.autoSubmit ?? false;
          return { mcpEnabled, autoInsert: autoSubmitEnabled, autoSubmit: autoSubmitEnabled, autoExecute: false };
        } catch {
          return { mcpEnabled: false, autoInsert: false, autoSubmit: false, autoExecute: false };
        }
      },
      setMCPEnabled: (enabled: boolean) => {
        try {
          if (context.stores.ui?.setMCPEnabled) {
            context.stores.ui.setMCPEnabled(enabled, 'mcp-popover-toggle');
          } else if (context.stores.ui?.setSidebarVisibility) {
            context.stores.ui.setSidebarVisibility(enabled, 'mcp-popover-toggle-fallback');
          }
          const sidebarManager = (window as any).activeSidebarManager;
          if (sidebarManager) {
            if (enabled) sidebarManager.show?.().catch?.(() => {});
            else sidebarManager.hide?.().catch?.(() => {});
          }
        } catch {}
        stateManager.updateUI();
      },
      setAutoInsert: (enabled: boolean) => {
        if (context.stores.ui?.updatePreferences) context.stores.ui.updatePreferences({ autoSubmit: enabled });
        stateManager.updateUI();
      },
      setAutoSubmit: (enabled: boolean) => {
        if (context.stores.ui?.updatePreferences) context.stores.ui.updatePreferences({ autoSubmit: enabled });
        stateManager.updateUI();
      },
      setAutoExecute: (_enabled: boolean) => {
        stateManager.updateUI();
      },
      updateUI: () => {
        const popoverContainer = document.getElementById('mcp-popover-container');
        if (popoverContainer) {
          const currentState = stateManager.getState();
          const event = new CustomEvent('mcp:update-toggle-state', { detail: { toggleState: currentState } });
          popoverContainer.dispatchEvent(event);
        }
      }
    };
    return stateManager;
  }

  private getElementContent(element: HTMLElement): string {
    const isContentEditable = element.isContentEditable || element.getAttribute('contenteditable') === 'true' || element.hasAttribute('contenteditable');
    if (isContentEditable) return element.textContent || element.innerText || '';
    return (element as HTMLInputElement | HTMLTextAreaElement).value || '';
  }

  onPageChanged?(url: string, oldUrl?: string): void {
    this.lastUrl = url;
    const stillSupported = this.isSupported();
    if (stillSupported) {
      setTimeout(() => {
        this.setupUIIntegration();
      }, 800);
    }
    this.context.eventBus.emit('app:site-changed', { site: url, hostname: window.location.hostname });
  }

  onHostChanged?(newHost: string, oldHost?: string): void {
    const stillSupported = this.isSupported();
    if (!stillSupported) {
      this.context.eventBus.emit('adapter:deactivated', { pluginName: this.name, timestamp: Date.now() });
    } else {
      this.setupUIIntegration();
    }
  }
}
