/**
 * Auth Middleware for MCP Server
 * 
 * Validates Authorization header token for streamable HTTP mode.
 * Supports multi-token configuration with user allocation and expiry control.
 * 
 * Configuration:
 * - MCP_AUTH_TOKENS: Multi-token with user/expiry (format: "token1:user1:expiry1,token2:user2,...")
 * - MCP_AUTH_TOKEN: Single token (backward compatible)
 */

import { getTokenManager, TokenValidationResult } from "./tokenManager.js";

// Declare process for Node.js environment (will be available at runtime)
declare const process: { env: Record<string, string | undefined> } | undefined;

// Check if running in Deno environment
const isDeno = typeof (globalThis as any).Deno !== 'undefined';

/**
 * Check if any auth tokens are configured
 */
function hasAuthTokens(): boolean {
  let tokensEnv = '';
  let singleToken = '';

  if (isDeno) {
    tokensEnv = (globalThis as any).Deno.env.get('MCP_AUTH_TOKENS') || '';
    singleToken = (globalThis as any).Deno.env.get('MCP_AUTH_TOKEN') || '';
  } else if (typeof process !== 'undefined' && process.env) {
    tokensEnv = process.env.MCP_AUTH_TOKENS || '';
    singleToken = process.env.MCP_AUTH_TOKEN || '';
  }

  return !!(tokensEnv || singleToken);
}

/**
 * Validate the Authorization header against configured tokens
 * 
 * @param authHeader - The full Authorization header value (e.g., "Bearer <token>")
 * @returns true if valid, false otherwise
 */
export function validateAuthToken(authHeader: string | null | undefined): boolean {
  const tokenManager = getTokenManager();
  const result = tokenManager.validateAuthHeader(authHeader);
  return result.valid;
}

/**
 * Validate auth header and get detailed result including user info
 * 
 * @param authHeader - The full Authorization header value
 * @returns TokenValidationResult with details about the validation
 */
export function validateAuthTokenWithDetails(authHeader: string | null | undefined): TokenValidationResult {
  const tokenManager = getTokenManager();
  return tokenManager.validateAuthHeader(authHeader);
}

/**
 * Record token usage (call after successful request)
 */
export async function recordTokenUsage(authHeader: string | null | undefined): Promise<void> {
  const tokenManager = getTokenManager();
  await tokenManager.recordUsageFromAuthHeader(authHeader);
}

/**
 * Get user ID from a validated auth header
 */
export function getUserFromAuthHeader(authHeader: string | null | undefined): string | null {
  const result = validateAuthTokenWithDetails(authHeader);
  return result.token?.userId || null;
}

/**
 * Check if Pool Mode is enabled (auth tokens are configured)
 * 
 * Pool Mode: MCP_AUTH_TOKEN(S) set → auth required, uses EXA_API_KEYS
 * Passthrough Mode: No auth configured → no auth, uses client key
 */
export function isAuthRequired(): boolean {
  return hasAuthTokens();
}

/**
 * Create HTTP 401 Unauthorized response
 */
export function createUnauthorizedResponse(reason?: string): { status: number; body: object; headers: Record<string, string> } {
  return {
    status: 401,
    body: {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: reason || 'Unauthorized: Invalid or missing authentication token',
      },
      id: null,
    },
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer realm="MCP Server"',
    },
  };
}

/**
 * Create HTTP 403 Forbidden response (for expired tokens)
 */
export function createForbiddenResponse(reason?: string): { status: number; body: object; headers: Record<string, string> } {
  return {
    status: 403,
    body: {
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: reason || 'Forbidden: Token has expired or is disabled',
      },
      id: null,
    },
    headers: {
      'Content-Type': 'application/json',
    },
  };
}

/**
 * Initialize the auth middleware (must be called before validating tokens)
 */
export async function initializeAuth(): Promise<void> {
  const tokenManager = getTokenManager();
  await tokenManager.initialize();
}

/**
 * Get token usage statistics
 */
export function getTokenStats() {
  const tokenManager = getTokenManager();
  return tokenManager.getStats();
}

/**
 * List all tokens (for admin purposes)
 */
export function listTokens() {
  const tokenManager = getTokenManager();
  return tokenManager.listTokens();
}

/**
 * Check if the auth header contains an admin token
 */
export function isAdminToken(authHeader: string | null | undefined): boolean {
  const tokenManager = getTokenManager();
  return tokenManager.isAdminAuthHeader(authHeader);
}
