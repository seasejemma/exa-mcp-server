/**
 * Auth Middleware for MCP Server
 * 
 * Validates Authorization header token for streamable HTTP mode.
 * Token is read from MCP_AUTH_TOKEN environment variable.
 */

// Declare process for Node.js environment (will be available at runtime)
declare const process: { env: Record<string, string | undefined> } | undefined;

// Get auth token from environment
function getAuthToken(): string | undefined {
  // Support both Deno and Node.js environments
  if (typeof (globalThis as any).Deno !== 'undefined') {
    return (globalThis as any).Deno.env.get('MCP_AUTH_TOKEN');
  }
  if (typeof process !== 'undefined' && process.env) {
    return process.env.MCP_AUTH_TOKEN;
  }
  return undefined;
}

/**
 * Validate the Authorization header against the configured token
 * 
 * @param authHeader - The full Authorization header value (e.g., "Bearer <token>")
 * @returns true if valid, false otherwise
 */
export function validateAuthToken(authHeader: string | null | undefined): boolean {
  const expectedToken = getAuthToken();
  
  // If no token is configured, skip validation (backward compatible)
  if (!expectedToken) {
    return true;
  }

  if (!authHeader) {
    return false;
  }

  // Extract Bearer token
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return false;
  }

  const providedToken = match[1];
  
  // Constant-time comparison to prevent timing attacks
  return constantTimeEqual(providedToken, expectedToken);
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  
  return result === 0;
}

/**
 * Check if Pool Mode is enabled (MCP_AUTH_TOKEN is configured)
 * 
 * Pool Mode: MCP_AUTH_TOKEN set → auth required, uses EXA_API_KEYS
 * Passthrough Mode: MCP_AUTH_TOKEN not set → no auth, uses client key
 */
export function isAuthRequired(): boolean {
  return !!getAuthToken();
}

/**
 * Create HTTP 401 Unauthorized response
 */
export function createUnauthorizedResponse(): { status: number; body: object; headers: Record<string, string> } {
  return {
    status: 401,
    body: {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Unauthorized: Invalid or missing authentication token',
      },
      id: null,
    },
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer realm="MCP Server"',
    },
  };
}
