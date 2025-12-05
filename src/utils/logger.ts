/**
 * Simple logging utility for MCP server
 * 
 * Log levels:
 * - error: Always logged (critical errors)
 * - info: Always logged (startup info, important events)
 * - debug: Only logged when DEBUG=true (verbose debugging)
 */

// Check debug mode - works in both Node.js and Deno
function isDebugEnabled(): boolean {
  if (typeof (globalThis as any).Deno !== 'undefined') {
    const debug = (globalThis as any).Deno.env.get('DEBUG');
    const exaDebug = (globalThis as any).Deno.env.get('EXA_DEBUG');
    return debug === 'true' || exaDebug === 'true';
  }
  if (typeof process !== 'undefined' && process.env) {
    return process.env.DEBUG === 'true' || process.env.EXA_DEBUG === 'true';
  }
  return false;
}

// Declare process for Node.js environment
declare const process: { env: Record<string, string | undefined> } | undefined;

/**
 * Log error messages (always logged)
 */
export const logError = (message: string): void => {
  console.error(`[EXA-MCP] ERROR: ${message}`);
};

/**
 * Log info messages (always logged - startup, important events)
 */
export const logInfo = (message: string): void => {
  console.error(`[EXA-MCP] ${message}`);
};

/**
 * Log debug messages (only when DEBUG=true)
 */
export const logDebug = (message: string): void => {
  if (isDebugEnabled()) {
    console.error(`[EXA-MCP] DEBUG: ${message}`);
  }
};

/**
 * Legacy log function - now respects DEBUG flag
 * @deprecated Use logInfo, logDebug, or logError instead
 */
export const log = (message: string): void => {
  // For backward compatibility, treat as debug log
  logDebug(message);
};

export const createRequestLogger = (requestId: string, toolName: string) => {
  return {
    log: (message: string): void => {
      logDebug(`[${requestId}] [${toolName}] ${message}`);
    },
    start: (query: string): void => {
      logDebug(`[${requestId}] [${toolName}] Starting search for query: "${query}"`);
    },
    error: (error: unknown): void => {
      logError(`[${requestId}] [${toolName}] ${error instanceof Error ? error.message : String(error)}`);
    },
    complete: (): void => {
      logDebug(`[${requestId}] [${toolName}] Successfully completed request`);
    }
  };
}; 