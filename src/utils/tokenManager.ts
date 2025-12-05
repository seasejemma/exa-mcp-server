/**
 * Token Manager with Multi-User Support and Expiry Control
 * 
 * Manages multiple authentication tokens with:
 * - User allocation (associate tokens with user identifiers)
 * - Role support (admin role for accessing admin endpoints)
 * - Expiry control (tokens can have optional expiration dates)
 * - Usage tracking (track token usage for analytics)
 * - Deno KV persistence (when available)
 * 
 * Configuration:
 * 
 * 1. Admin token (single): MCP_AUTH_TOKEN
 *    - For backward compatibility
 *    - Always has 'admin' role
 * 
 * 2. User tokens (multiple): USER_TOKENS
 *    Format: "token:userId:expiry" (userId and expiry are optional)
 *    - Always has 'user' role
 * 
 * Examples:
 * - "abc123:alice:2025-12-31" - User token for alice, expires Dec 31, 2025
 * - "xyz789:bob:never" - User token for bob, never expires (explicit)
 * - "def456:charlie" - User token for charlie, never expires
 * - "simple_token" - Anonymous user token, never expires
 * 
 * Expiry values:
 * - ISO 8601 date: "2025-12-31" - Expires on specific date
 * - "never", "infinite", "∞", "none", "-" - Never expires (explicit)
 * - Empty or omitted - Never expires (implicit)
 * 
 * Roles:
 * - "admin" - Can access /admin/* endpoints (MCP_AUTH_TOKEN only)
 * - "user" - Can only access MCP endpoints (USER_TOKENS)
 */

import { logInfo, logDebug, logError } from "./logger.js";

// Declare process for Node.js environment
declare const process: { env: Record<string, string | undefined> } | undefined;

export type TokenRole = 'admin' | 'user';

export interface TokenInfo {
  token: string;
  userId: string | null;        // User identifier (optional)
  role: TokenRole;              // Token role (admin or user)
  expiresAt: Date | null;       // Expiration date (optional, null = never expires)
  createdAt: Date;              // When the token was added
  lastUsedAt: Date | null;      // Last usage timestamp
  usageCount: number;           // Total usage count
  isActive: boolean;            // Whether the token is currently active
  metadata?: Record<string, any>; // Optional additional metadata
}

export interface TokenValidationResult {
  valid: boolean;
  token?: TokenInfo;
  reason?: string;
}

export interface TokenUsageStats {
  totalTokens: number;
  activeTokens: number;
  expiredTokens: number;
  totalUsage: number;
  tokensByUser: Record<string, number>;
}

// Check if running in Deno environment
const isDeno = typeof (globalThis as any).Deno !== 'undefined';

class TokenManager {
  private tokens: Map<string, TokenInfo> = new Map();
  private kv: any = null;  // Deno.Kv instance
  private initialized: boolean = false;

  constructor() {}

  /**
   * Initialize the token manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Parse tokens from environment
    const tokensConfig = this.getTokensConfig();
    
    if (tokensConfig.length === 0) {
      logDebug('No auth tokens configured - auth will be disabled');
    } else {
      logDebug(`Loaded ${tokensConfig.length} token(s) from configuration`);
    }

    // Initialize tokens map
    for (const config of tokensConfig) {
      const tokenInfo: TokenInfo = {
        token: config.token,
        userId: config.userId,
        role: config.role,
        expiresAt: config.expiresAt,
        createdAt: new Date(),
        lastUsedAt: null,
        usageCount: 0,
        isActive: true,
      };
      this.tokens.set(config.token, tokenInfo);
    }

    // Try to initialize Deno KV for persistence
    if (isDeno) {
      try {
        this.kv = await (globalThis as any).Deno.openKv();
        await this.loadStateFromKv();
        logDebug('Deno KV initialized for token state persistence');
      } catch (error) {
        logDebug(`Deno KV not available, using in-memory state: ${error}`);
      }
    }

    this.initialized = true;
  }

  /**
   * Parse tokens configuration from environment variables
   * 
   * USER_TOKENS format: "token:userId:expiry" (userId and expiry are optional)
   * - token: The authentication token (required)
   * - userId: User identifier (optional)
   * - expiry: ISO 8601 date string (optional)
   * - All USER_TOKENS have 'user' role
   * 
   * MCP_AUTH_TOKEN: Single admin token for backward compatibility
   */
  private getTokensConfig(): Array<{ token: string; userId: string | null; role: TokenRole; expiresAt: Date | null }> {
    let tokensEnv = '';
    let singleToken = '';

    if (isDeno) {
      tokensEnv = (globalThis as any).Deno.env.get('USER_TOKENS') || '';
      singleToken = (globalThis as any).Deno.env.get('MCP_AUTH_TOKEN') || '';
    } else if (typeof process !== 'undefined' && process.env) {
      tokensEnv = process.env.USER_TOKENS || '';
      singleToken = process.env.MCP_AUTH_TOKEN || '';
    }

    const configs: Array<{ token: string; userId: string | null; role: TokenRole; expiresAt: Date | null }> = [];

    // Parse multi-token config (USER_TOKENS)
    // Format: token:userId:expiry (all have 'user' role)
    if (tokensEnv) {
      const tokenEntries = tokensEnv.split(',').map(s => s.trim()).filter(s => s.length > 0);
      
      for (const entry of tokenEntries) {
        const parts = entry.split(':');
        const token = parts[0]?.trim();
        const userId = parts[1]?.trim() || null;
        const expiryStr = parts[2]?.trim()?.toLowerCase();
        
        if (!token) continue;

        // USER_TOKENS always have 'user' role
        const role: TokenRole = 'user';

        // Parse expiry date
        // Special values: "never", "infinite", "∞", "" → null (never expires)
        let expiresAt: Date | null = null;
        if (expiryStr && !['never', 'infinite', '∞', 'none', '-'].includes(expiryStr)) {
          const parsed = new Date(expiryStr);
          if (!isNaN(parsed.getTime())) {
            expiresAt = parsed;
          } else {
            logError(`Invalid expiry date for token: ${expiryStr}`);
          }
        }

        configs.push({ token, userId: userId || null, role, expiresAt });
      }
    }

    // Fallback to single token (MCP_AUTH_TOKEN) for backward compatibility
    // Single token is treated as admin for backward compatibility
    if (configs.length === 0 && singleToken) {
      configs.push({
        token: singleToken,
        userId: null,
        role: 'admin',  // Single token defaults to admin for backward compatibility
        expiresAt: null,
      });
    }

    return configs;
  }

  /**
   * Load token state from Deno KV
   */
  private async loadStateFromKv(): Promise<void> {
    if (!this.kv) return;

    for (const [token, info] of this.tokens.entries()) {
      const hash = this.hashToken(token);
      const entry = await this.kv.get(['tokens', 'state', hash]);
      
      if (entry.value) {
        const state = entry.value as {
          lastUsedAt: string | null;
          usageCount: number;
          isActive: boolean;
        };
        info.lastUsedAt = state.lastUsedAt ? new Date(state.lastUsedAt) : null;
        info.usageCount = state.usageCount;
        info.isActive = state.isActive;
      }
    }
  }

  /**
   * Save token state to Deno KV
   */
  private async saveStateToKv(token: string): Promise<void> {
    if (!this.kv) return;

    const info = this.tokens.get(token);
    if (!info) return;

    const hash = this.hashToken(token);
    await this.kv.set(['tokens', 'state', hash], {
      lastUsedAt: info.lastUsedAt?.toISOString() || null,
      usageCount: info.usageCount,
      isActive: info.isActive,
    });
  }

  /**
   * Hash a token for storage (don't store raw tokens in KV)
   */
  private hashToken(token: string): string {
    // Simple hash for token identification (not cryptographic)
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      const char = token.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `tok_${Math.abs(hash).toString(16)}`;
  }

  /**
   * Validate a token and return validation result
   */
  validate(providedToken: string): TokenValidationResult {
    const tokenInfo = this.tokens.get(providedToken);

    if (!tokenInfo) {
      return { valid: false, reason: 'Token not found' };
    }

    if (!tokenInfo.isActive) {
      return { valid: false, reason: 'Token is disabled', token: tokenInfo };
    }

    if (tokenInfo.expiresAt && new Date() > tokenInfo.expiresAt) {
      return { valid: false, reason: 'Token has expired', token: tokenInfo };
    }

    return { valid: true, token: tokenInfo };
  }

  /**
   * Validate token from Authorization header
   */
  validateAuthHeader(authHeader: string | null | undefined): TokenValidationResult {
    // If no tokens configured, skip validation (backward compatible)
    if (this.tokens.size === 0) {
      return { valid: true, reason: 'No auth configured' };
    }

    if (!authHeader) {
      return { valid: false, reason: 'No Authorization header' };
    }

    // Extract Bearer token
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return { valid: false, reason: 'Invalid Authorization format' };
    }

    const providedToken = match[1];
    
    // Use constant-time comparison for all tokens
    for (const [storedToken, tokenInfo] of this.tokens.entries()) {
      if (this.constantTimeEqual(providedToken, storedToken)) {
        // Found matching token, validate it
        if (!tokenInfo.isActive) {
          return { valid: false, reason: 'Token is disabled', token: tokenInfo };
        }

        if (tokenInfo.expiresAt && new Date() > tokenInfo.expiresAt) {
          return { valid: false, reason: 'Token has expired', token: tokenInfo };
        }

        return { valid: true, token: tokenInfo };
      }
    }

    return { valid: false, reason: 'Token not found' };
  }

  /**
   * Record token usage (call after successful authentication)
   */
  async recordUsage(token: string): Promise<void> {
    const tokenInfo = this.tokens.get(token);
    if (!tokenInfo) return;

    tokenInfo.lastUsedAt = new Date();
    tokenInfo.usageCount++;

    await this.saveStateToKv(token);
  }

  /**
   * Record usage from auth header (convenience method)
   */
  async recordUsageFromAuthHeader(authHeader: string | null | undefined): Promise<void> {
    if (!authHeader) return;

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) return;

    const providedToken = match[1];
    
    for (const storedToken of this.tokens.keys()) {
      if (this.constantTimeEqual(providedToken, storedToken)) {
        await this.recordUsage(storedToken);
        break;
      }
    }
  }

  /**
   * Disable a token
   */
  async disableToken(token: string): Promise<boolean> {
    const tokenInfo = this.tokens.get(token);
    if (!tokenInfo) return false;

    tokenInfo.isActive = false;
    await this.saveStateToKv(token);
    return true;
  }

  /**
   * Enable a token
   */
  async enableToken(token: string): Promise<boolean> {
    const tokenInfo = this.tokens.get(token);
    if (!tokenInfo) return false;

    tokenInfo.isActive = true;
    await this.saveStateToKv(token);
    return true;
  }

  /**
   * Get token info (without exposing the actual token value)
   */
  getTokenInfo(token: string): Omit<TokenInfo, 'token'> | null {
    const info = this.tokens.get(token);
    if (!info) return null;

    const { token: _, ...rest } = info;
    return rest;
  }

  /**
   * Get usage statistics
   */
  getStats(): TokenUsageStats {
    const now = new Date();
    let totalUsage = 0;
    let activeTokens = 0;
    let expiredTokens = 0;
    const tokensByUser: Record<string, number> = {};

    for (const tokenInfo of this.tokens.values()) {
      totalUsage += tokenInfo.usageCount;

      const isExpired = tokenInfo.expiresAt && now > tokenInfo.expiresAt;
      
      if (isExpired) {
        expiredTokens++;
      } else if (tokenInfo.isActive) {
        activeTokens++;
      }

      const userKey = tokenInfo.userId || 'anonymous';
      tokensByUser[userKey] = (tokensByUser[userKey] || 0) + 1;
    }

    return {
      totalTokens: this.tokens.size,
      activeTokens,
      expiredTokens,
      totalUsage,
      tokensByUser,
    };
  }

  /**
   * Get list of all tokens (for admin purposes)
   */
  listTokens(): Array<{
    tokenPrefix: string;
    userId: string | null;
    role: TokenRole;
    expiresAt: Date | null;
    isActive: boolean;
    isExpired: boolean;
    usageCount: number;
    lastUsedAt: Date | null;
  }> {
    const now = new Date();
    const result = [];

    for (const tokenInfo of this.tokens.values()) {
      result.push({
        tokenPrefix: tokenInfo.token.substring(0, 8) + '...',
        userId: tokenInfo.userId,
        role: tokenInfo.role,
        expiresAt: tokenInfo.expiresAt,
        isActive: tokenInfo.isActive,
        isExpired: tokenInfo.expiresAt ? now > tokenInfo.expiresAt : false,
        usageCount: tokenInfo.usageCount,
        lastUsedAt: tokenInfo.lastUsedAt,
      });
    }

    return result;
  }

  /**
   * Check if a token has admin role
   */
  isAdminToken(token: string): boolean {
    const tokenInfo = this.tokens.get(token);
    return tokenInfo?.role === 'admin';
  }

  /**
   * Check if auth header contains an admin token
   */
  isAdminAuthHeader(authHeader: string | null | undefined): boolean {
    if (!authHeader) return false;

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;

    const providedToken = match[1];
    
    for (const [storedToken, tokenInfo] of this.tokens.entries()) {
      if (this.constantTimeEqual(providedToken, storedToken)) {
        return tokenInfo.role === 'admin';
      }
    }

    return false;
  }

  /**
   * Check if any tokens are configured
   */
  hasTokens(): boolean {
    return this.tokens.size > 0;
  }

  /**
   * Constant-time string comparison to prevent timing attacks
   */
  private constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }

    return result === 0;
  }
}

// Singleton instance
let tokenManagerInstance: TokenManager | null = null;

/**
 * Get the singleton TokenManager instance
 */
export function getTokenManager(): TokenManager {
  if (!tokenManagerInstance) {
    tokenManagerInstance = new TokenManager();
  }
  return tokenManagerInstance;
}

/**
 * Reset the token manager (for testing)
 */
export function resetTokenManager(): void {
  tokenManagerInstance = null;
}

export { TokenManager };
