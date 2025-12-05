/**
 * Exa API Client with Key Rotation Support
 * 
 * Wraps HTTP requests to Exa API with automatic key rotation on balance/quota errors.
 * Supports both axios (Node.js) and native fetch (Deno).
 */

// Declare process for Node.js environment (will be available at runtime)
declare const process: { env: Record<string, string | undefined> } | undefined;

import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from "axios";
import { API_CONFIG } from "../tools/config.js";
import { getApiKeyManager } from "./apiKeyManager.js";
import { log } from "./logger.js";

// Check if running in Deno environment
const isDeno = typeof (globalThis as any).Deno !== 'undefined';

/**
 * Error patterns that indicate balance/quota issues
 * Based on Exa API documentation:
 * - 402: Payment required
 * - 403: Forbidden (may include quota exceeded)
 * - 429: Too many requests (rate limit, may indicate quota)
 */
const BALANCE_ERROR_CODES = [402, 429];
const BALANCE_ERROR_KEYWORDS = ['balance', 'quota', 'credit', 'limit', 'insufficient', 'exceeded', 'payment'];

/**
 * Check if an error indicates a balance/quota issue
 */
function isBalanceError(status: number, errorMessage?: string): boolean {
  // Direct balance-related status codes
  if (BALANCE_ERROR_CODES.includes(status)) {
    return true;
  }

  // Check 403 errors for balance-related keywords
  if (status === 403 && errorMessage) {
    const lowerMessage = errorMessage.toLowerCase();
    return BALANCE_ERROR_KEYWORDS.some(keyword => lowerMessage.includes(keyword));
  }

  return false;
}

/**
 * Extract error message from various error response formats
 */
function extractErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<{ error?: string; message?: string }>;
    return axiosError.response?.data?.error 
      || axiosError.response?.data?.message 
      || axiosError.message 
      || 'Unknown axios error';
  }
  
  if (error instanceof Error) {
    return error.message;
  }
  
  return String(error);
}

/**
 * Extract status code from error
 */
function extractStatusCode(error: unknown): number {
  if (axios.isAxiosError(error)) {
    return (error as AxiosError).response?.status || 0;
  }
  return 0;
}

export interface ExaRequestConfig {
  exaApiKey?: string;  // Optional override key (for backward compatibility)
  timeout?: number;
  method?: 'GET' | 'POST';  // HTTP method (default: POST)
}

export interface ExaRequestResult<T> {
  data: T;
  usedKey: string;  // For debugging/logging (masked)
}

/**
 * Make a request to the Exa API with automatic key rotation
 */
export async function makeExaRequest<T>(
  endpoint: string,
  data: object | null,
  config: ExaRequestConfig = {}
): Promise<T> {
  const keyManager = getApiKeyManager();
  await keyManager.initialize();

  // Use override key if provided, otherwise get from manager
  let apiKey = config.exaApiKey;
  let usingManagedKey = false;

  if (!apiKey) {
    apiKey = keyManager.getActiveKey() || '';
    usingManagedKey = true;
  }

  if (!apiKey) {
    throw new Error('No API key available. All keys may be exhausted or in cooldown.');
  }

  const timeout = config.timeout || 25000;

  // Attempt the request
  const method = config.method || 'POST';
  
  try {
    const response = await executeRequest<T>(endpoint, data, apiKey, timeout, method);
    return response;
  } catch (error) {
    const statusCode = extractStatusCode(error);
    const errorMessage = extractErrorMessage(error);

    // Check if this is a balance/quota error and we're using managed keys
    if (usingManagedKey && isBalanceError(statusCode, errorMessage)) {
      log(`[ExaClient] Balance/quota error detected (${statusCode}): ${errorMessage}`);
      
      const rotated = await keyManager.markCurrentKeyFailed(errorMessage);
      
      if (rotated) {
        // Get new key and retry once
        const newKey = keyManager.getActiveKey();
        if (newKey) {
          log('[ExaClient] Retrying with rotated key...');
          try {
            return await executeRequest<T>(endpoint, data, newKey, timeout, method);
          } catch (retryError) {
            // If retry also fails, throw the original error context
            log(`[ExaClient] Retry also failed: ${extractErrorMessage(retryError)}`);
            throw retryError;
          }
        }
      }

      // All keys exhausted
      const status = keyManager.getStatus();
      throw new Error(
        `All API keys exhausted. Status: ${status.active} active, ${status.cooldown} in cooldown, ${status.dead} dead out of ${status.total} total.`
      );
    }

    // Not a balance error or not using managed keys, rethrow
    throw error;
  }
}

/**
 * Execute the actual HTTP request (supports both axios and fetch)
 */
async function executeRequest<T>(
  endpoint: string,
  data: object | null,
  apiKey: string,
  timeout: number,
  method: 'GET' | 'POST' = 'POST'
): Promise<T> {
  if (isDeno) {
    return executeWithFetch<T>(endpoint, data, apiKey, timeout, method);
  } else {
    return executeWithAxios<T>(endpoint, data, apiKey, timeout, method);
  }
}

/**
 * Execute request using axios (Node.js)
 */
async function executeWithAxios<T>(
  endpoint: string,
  data: object | null,
  apiKey: string,
  timeout: number,
  method: 'GET' | 'POST' = 'POST'
): Promise<T> {
  const axiosInstance = axios.create({
    baseURL: API_CONFIG.BASE_URL,
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    timeout,
  });

  if (method === 'GET') {
    const response: AxiosResponse<T> = await axiosInstance.get(endpoint);
    return response.data;
  } else {
    const response: AxiosResponse<T> = await axiosInstance.post(endpoint, data);
    return response.data;
  }
}

/**
 * Execute request using native fetch (Deno)
 */
async function executeWithFetch<T>(
  endpoint: string,
  data: object | null,
  apiKey: string,
  timeout: number,
  method: 'GET' | 'POST' = 'POST'
): Promise<T> {
  const url = `${API_CONFIG.BASE_URL}${endpoint}`;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const fetchOptions: RequestInit = {
    method,
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    signal: controller.signal,
  };

  if (method === 'POST' && data) {
    fetchOptions.body = JSON.stringify(data);
  }

  try {
    const response = await fetch(url, fetchOptions);

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text();
      let errorMessage: string;
      try {
        const errorJson = JSON.parse(errorBody);
        errorMessage = errorJson.error || errorJson.message || errorBody;
      } catch {
        errorMessage = errorBody;
      }

      // Create an error that mimics axios error structure for consistency
      const error = new Error(errorMessage) as any;
      error.response = {
        status: response.status,
        data: { error: errorMessage },
      };
      error.isAxiosError = false;  // Mark as non-axios for proper handling
      throw error;
    }

    return await response.json() as T;
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    
    if (error instanceof Error && error.name === 'AbortError') {
      const timeoutError = new Error(`Request timeout after ${timeout}ms`) as any;
      timeoutError.response = { status: 408 };
      throw timeoutError;
    }
    
    throw error;
  }
}

/**
 * Create a legacy axios instance for backward compatibility
 * This allows gradual migration of existing tools
 */
export function createExaAxiosInstance(config?: ExaRequestConfig): ReturnType<typeof axios.create> {
  const keyManager = getApiKeyManager();
  
  // Synchronously get key - initialization should be done elsewhere
  let apiKey = config?.exaApiKey || '';
  
  if (!apiKey) {
    // Fallback to environment variable for backward compatibility
    const envKey = typeof process !== 'undefined' 
      ? (process.env.EXA_API_KEY || '')
      : '';
    apiKey = envKey;
  }

  return axios.create({
    baseURL: API_CONFIG.BASE_URL,
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    timeout: config?.timeout || 25000,
  });
}

/**
 * Get masked version of API key for logging
 */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
}
