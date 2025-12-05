/**
 * API Key Manager with Rotation Support
 * 
 * Manages multiple Exa API keys with automatic rotation on balance/quota errors.
 * Supports Deno KV for persistence (when available) or falls back to in-memory storage.
 */

import { log } from "./logger.js";

// Declare process for Node.js environment (will be available at runtime)
declare const process: { env: Record<string, string | undefined> } | undefined;

interface KeyState {
  key: string;
  failedAt: number | null;
  retryCount: number;
  isDead: boolean;
}

interface KeyManagerConfig {
  cooldownMs: number;      // Cooldown period before retrying a failed key
  maxRetries: number;      // Max retries before marking key as dead
}

const DEFAULT_CONFIG: KeyManagerConfig = {
  cooldownMs: 3 * 60 * 1000,  // 3 minutes
  maxRetries: 3,
};

// Check if running in Deno environment
const isDeno = typeof (globalThis as any).Deno !== 'undefined';

class ApiKeyManager {
  private keys: KeyState[] = [];
  private currentIndex: number = 0;
  private config: KeyManagerConfig;
  private kv: any = null;  // Deno.Kv instance
  private initialized: boolean = false;

  constructor(config: Partial<KeyManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the key manager with API keys from environment
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Parse keys from environment variable (works in both Node.js and Deno)
    let keysEnv = '';
    if (typeof (globalThis as any).Deno !== 'undefined') {
      keysEnv = (globalThis as any).Deno.env.get('EXA_API_KEYS') 
        || (globalThis as any).Deno.env.get('EXA_API_KEY') 
        || '';
    } else if (typeof process !== 'undefined' && process.env) {
      keysEnv = process.env.EXA_API_KEYS || process.env.EXA_API_KEY || '';
    }
    
    const keyList: string[] = keysEnv.split(',').map((k: string) => k.trim()).filter((k: string) => k.length > 0);

    if (keyList.length === 0) {
      log('[ApiKeyManager] Warning: No API keys found in EXA_API_KEYS or EXA_API_KEY');
    } else {
      log(`[ApiKeyManager] Initialized with ${keyList.length} API key(s)`);
    }

    this.keys = keyList.map((key: string) => ({
      key,
      failedAt: null,
      retryCount: 0,
      isDead: false,
    }));

    // Try to initialize Deno KV for persistence
    if (isDeno) {
      try {
        this.kv = await (globalThis as any).Deno.openKv();
        await this.loadStateFromKv();
        log('[ApiKeyManager] Deno KV initialized for state persistence');
      } catch (error) {
        log(`[ApiKeyManager] Deno KV not available, using in-memory state: ${error}`);
      }
    }

    this.initialized = true;
  }

  /**
   * Load key state from Deno KV
   */
  private async loadStateFromKv(): Promise<void> {
    if (!this.kv) return;

    for (let i = 0; i < this.keys.length; i++) {
      const keyHash = this.hashKey(this.keys[i].key);
      const entry = await this.kv.get(['api_keys', 'state', keyHash]);
      if (entry.value) {
        const state = entry.value as { failedAt: number | null; retryCount: number; isDead: boolean };
        this.keys[i].failedAt = state.failedAt;
        this.keys[i].retryCount = state.retryCount;
        this.keys[i].isDead = state.isDead;
      }
    }
  }

  /**
   * Save key state to Deno KV
   */
  private async saveStateToKv(index: number): Promise<void> {
    if (!this.kv || index >= this.keys.length) return;

    const keyState = this.keys[index];
    const keyHash = this.hashKey(keyState.key);
    
    await this.kv.set(['api_keys', 'state', keyHash], {
      failedAt: keyState.failedAt,
      retryCount: keyState.retryCount,
      isDead: keyState.isDead,
    });
  }

  /**
   * Hash a key for storage (don't store raw keys)
   */
  private hashKey(key: string): string {
    // Simple hash for key identification (not cryptographic)
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `key_${Math.abs(hash).toString(16)}`;
  }

  /**
   * Check if a key is available (not in cooldown or dead)
   */
  private isKeyAvailable(keyState: KeyState): boolean {
    if (keyState.isDead) return false;
    if (keyState.failedAt === null) return true;
    
    const elapsed = Date.now() - keyState.failedAt;
    return elapsed >= this.config.cooldownMs;
  }

  /**
   * Get the current active API key
   * Returns null if all keys are exhausted
   */
  getActiveKey(): string | null {
    if (this.keys.length === 0) return null;

    // Try to find an available key starting from current index
    const startIndex = this.currentIndex;
    let attempts = 0;

    while (attempts < this.keys.length) {
      const keyState = this.keys[this.currentIndex];
      
      if (this.isKeyAvailable(keyState)) {
        // Reset retry count if cooldown has passed
        if (keyState.failedAt !== null) {
          const elapsed = Date.now() - keyState.failedAt;
          if (elapsed >= this.config.cooldownMs) {
            keyState.failedAt = null;
            // Don't reset retryCount - it accumulates until key is dead
          }
        }
        return keyState.key;
      }

      this.currentIndex = (this.currentIndex + 1) % this.keys.length;
      attempts++;
    }

    log('[ApiKeyManager] All API keys are exhausted or in cooldown');
    return null;
  }

  /**
   * Mark the current key as failed due to balance/quota error
   * Returns true if rotation was successful, false if all keys are dead
   */
  async markCurrentKeyFailed(reason: string): Promise<boolean> {
    if (this.keys.length === 0) return false;

    const keyState = this.keys[this.currentIndex];
    keyState.failedAt = Date.now();
    keyState.retryCount++;

    log(`[ApiKeyManager] Key ${this.currentIndex + 1}/${this.keys.length} failed (attempt ${keyState.retryCount}/${this.config.maxRetries}): ${reason}`);

    if (keyState.retryCount >= this.config.maxRetries) {
      keyState.isDead = true;
      log(`[ApiKeyManager] Key ${this.currentIndex + 1} marked as dead after ${this.config.maxRetries} failures`);
    }

    // Persist state
    await this.saveStateToKv(this.currentIndex);

    // Rotate to next key
    return this.rotateToNextKey();
  }

  /**
   * Rotate to the next available key
   * Returns true if a new key is available, false if all exhausted
   */
  rotateToNextKey(): boolean {
    const startIndex = this.currentIndex;
    
    do {
      this.currentIndex = (this.currentIndex + 1) % this.keys.length;
      
      if (this.isKeyAvailable(this.keys[this.currentIndex])) {
        log(`[ApiKeyManager] Rotated to key ${this.currentIndex + 1}/${this.keys.length}`);
        return true;
      }
    } while (this.currentIndex !== startIndex);

    return false;
  }

  /**
   * Get status summary of all keys
   */
  getStatus(): { total: number; active: number; cooldown: number; dead: number } {
    let active = 0, cooldown = 0, dead = 0;

    for (const keyState of this.keys) {
      if (keyState.isDead) {
        dead++;
      } else if (this.isKeyAvailable(keyState)) {
        active++;
      } else {
        cooldown++;
      }
    }

    return { total: this.keys.length, active, cooldown, dead };
  }

  /**
   * Reset all keys (useful for testing or manual recovery)
   */
  async resetAllKeys(): Promise<void> {
    for (let i = 0; i < this.keys.length; i++) {
      this.keys[i].failedAt = null;
      this.keys[i].retryCount = 0;
      this.keys[i].isDead = false;
      await this.saveStateToKv(i);
    }
    this.currentIndex = 0;
    log('[ApiKeyManager] All keys have been reset');
  }
}

// Singleton instance
let instance: ApiKeyManager | null = null;

export function getApiKeyManager(): ApiKeyManager {
  if (!instance) {
    instance = new ApiKeyManager();
  }
  return instance;
}

export { ApiKeyManager, KeyManagerConfig };
