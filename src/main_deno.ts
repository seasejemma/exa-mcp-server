/**
 * Deno Entry Point for Exa MCP Server
 * 
 * This file provides a Deno-native HTTP server wrapper for the MCP server.
 * It handles:
 * - Authorization header validation (Bearer token)
 * - Streamable HTTP transport for MCP
 * - Integration with the existing server logic
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { toFetchResponse, toReqRes } from "fetch-to-node";
import { validateAuthToken, createUnauthorizedResponse, isAuthRequired } from "./utils/authMiddleware.ts";
import { getApiKeyManager } from "./utils/apiKeyManager.ts";
import { log } from "./utils/logger.ts";

// Import tool registration functions
import { registerWebSearchTool } from "./tools/webSearch.ts";
import { registerDeepSearchTool } from "./tools/deepSearch.ts";
import { registerCompanyResearchTool } from "./tools/companyResearch.ts";
import { registerCrawlingTool } from "./tools/crawling.ts";
import { registerLinkedInSearchTool } from "./tools/linkedInSearch.ts";
import { registerDeepResearchStartTool } from "./tools/deepResearchStart.ts";
import { registerDeepResearchCheckTool } from "./tools/deepResearchCheck.ts";
import { registerExaCodeTool } from "./tools/exaCode.ts";

// Type declarations for Deno
declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
  serve(options: { port: number; hostname?: string }, handler: (req: Request) => Promise<Response> | Response): void;
};

// Tool registry for managing available tools
const availableTools = {
  'web_search_exa': { name: 'Web Search (Exa)', description: 'Real-time web search using Exa AI', enabled: true },
  'get_code_context_exa': { name: 'Code Context Search', description: 'Search for code snippets, examples, and documentation', enabled: true },
  'deep_search_exa': { name: 'Deep Search (Exa)', description: 'Advanced web search with query expansion', enabled: false },
  'crawling_exa': { name: 'Web Crawling', description: 'Extract content from specific URLs', enabled: false },
  'deep_researcher_start': { name: 'Deep Researcher Start', description: 'Start a comprehensive AI research task', enabled: false },
  'deep_researcher_check': { name: 'Deep Researcher Check', description: 'Check status and retrieve results of research task', enabled: false },
  'linkedin_search_exa': { name: 'LinkedIn Search', description: 'Search LinkedIn profiles and companies', enabled: false },
  'company_research_exa': { name: 'Company Research', description: 'Research companies and organizations', enabled: false },
};

// Session storage for StreamableHTTP
const sessions = new Map<string, StreamableHTTPServerTransport>();

/**
 * Parse enabled tools from environment variable
 * Default: our preferred tool set
 */
function getEnabledTools(): string[] {
  const toolsEnv = Deno.env.get('ENABLED_TOOLS') || Deno.env.get('EXA_ENABLED_TOOLS');
  if (!toolsEnv) {
    // Default enabled tools
    return ['web_search_exa', 'get_code_context_exa', 'crawling_exa', 'deep_researcher_start', 'deep_researcher_check'];
  }
  
  return toolsEnv.split(',').map((t: string) => t.trim()).filter((t: string) => t.length > 0);
}

/**
 * Check if debug mode is enabled
 */
function isDebugMode(): boolean {
  return Deno.env.get('DEBUG') === 'true' || Deno.env.get('EXA_DEBUG') === 'true';
}

/**
 * Working Mode Detection
 * 
 * Pool Mode (our mode):
 *   - MCP_AUTH_TOKEN is set → requires auth, uses EXA_API_KEYS pool only
 * 
 * Passthrough Mode (original mode):
 *   - MCP_AUTH_TOKEN not set → no auth, uses client-provided key
 */
function isPoolMode(): boolean {
  return !!Deno.env.get('MCP_AUTH_TOKEN');
}

/**
 * Extract API key from request in passthrough mode
 * Supports: query param (?exaApiKey=...) or header (X-Exa-Api-Key: ...)
 */
function extractPassthroughKey(req: Request): string | undefined {
  const url = new URL(req.url);
  
  // Check query parameter first (original exa-mcp-server behavior)
  const queryKey = url.searchParams.get('exaApiKey');
  if (queryKey) return queryKey;
  
  // Check header
  const headerKey = req.headers.get('X-Exa-Api-Key');
  if (headerKey) return headerKey;
  
  return undefined;
}

/**
 * Create and configure the MCP server
 */
function createServer(): McpServer {
  const debug = isDebugMode();
  const enabledTools = getEnabledTools();

  const server = new McpServer({
    name: "exa-search-server",
    title: "Exa",
    version: "3.1.2"
  });

  if (debug) {
    log("[Deno] Starting Exa MCP Server in debug mode");
    if (enabledTools) {
      log(`[Deno] Enabled tools from env: ${enabledTools.join(', ')}`);
    }
  }

  // Helper function to check if a tool should be registered
  const shouldRegisterTool = (toolId: string): boolean => {
    if (enabledTools && enabledTools.length > 0) {
      return enabledTools.includes(toolId);
    }
    return availableTools[toolId as keyof typeof availableTools]?.enabled ?? false;
  };

  // Config object for tools (API key is managed by apiKeyManager)
  const config = {
    exaApiKey: undefined,  // Will use apiKeyManager
    debug,
  };

  // Register tools based on configuration
  const registeredTools: string[] = [];

  if (shouldRegisterTool('web_search_exa')) {
    registerWebSearchTool(server, config);
    registeredTools.push('web_search_exa');
  }

  if (shouldRegisterTool('deep_search_exa')) {
    registerDeepSearchTool(server, config);
    registeredTools.push('deep_search_exa');
  }

  if (shouldRegisterTool('company_research_exa')) {
    registerCompanyResearchTool(server, config);
    registeredTools.push('company_research_exa');
  }

  if (shouldRegisterTool('crawling_exa')) {
    registerCrawlingTool(server, config);
    registeredTools.push('crawling_exa');
  }

  if (shouldRegisterTool('linkedin_search_exa')) {
    registerLinkedInSearchTool(server, config);
    registeredTools.push('linkedin_search_exa');
  }

  if (shouldRegisterTool('deep_researcher_start')) {
    registerDeepResearchStartTool(server, config);
    registeredTools.push('deep_researcher_start');
  }

  if (shouldRegisterTool('deep_researcher_check')) {
    registerDeepResearchCheckTool(server, config);
    registeredTools.push('deep_researcher_check');
  }

  if (shouldRegisterTool('get_code_context_exa')) {
    registerExaCodeTool(server, config);
    registeredTools.push('get_code_context_exa');
  }

  if (debug) {
    log(`[Deno] Registered ${registeredTools.length} tools: ${registeredTools.join(', ')}`);
  }

  // Register prompts
  server.prompt(
    "web_search_help",
    "Get help with web search using Exa",
    {},
    async () => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: "I want to search the web for current information. Can you help me search for recent news about artificial intelligence breakthroughs?"
        }
      }]
    })
  );

  // Register resources
  server.resource(
    "tools_list",
    "exa://tools/list",
    {
      mimeType: "application/json",
      description: "List of available Exa tools and their descriptions"
    },
    async () => {
      const toolsList = Object.entries(availableTools).map(([id, tool]) => ({
        id,
        name: tool.name,
        description: tool.description,
        enabled: registeredTools.includes(id)
      }));

      return {
        contents: [{
          uri: "exa://tools/list",
          text: JSON.stringify(toolsList, null, 2),
          mimeType: "application/json"
        }]
      };
    }
  );

  return server;
}

/**
 * Handle incoming HTTP requests
 * 
 * Two working modes:
 * - Pool Mode: MCP_AUTH_TOKEN set → auth required, uses EXA_API_KEYS
 * - Passthrough Mode: MCP_AUTH_TOKEN not set → no auth, uses client key
 */
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const debug = isDebugMode();
  const poolMode = isPoolMode();

  // Health check endpoint
  if (url.pathname === '/health' || url.pathname === '/') {
    if (req.method === 'GET') {
      return new Response(JSON.stringify({
        status: 'ok',
        server: 'exa-mcp-server',
        version: '3.1.2',
        mode: poolMode ? 'pool' : 'passthrough',
        authRequired: poolMode,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // MCP endpoint
  if (url.pathname === '/mcp' || url.pathname === '/') {
    // Mode-specific authentication
    if (poolMode) {
      // Pool Mode: require MCP auth token
      const authHeader = req.headers.get('Authorization');
      if (!validateAuthToken(authHeader)) {
        const unauthorized = createUnauthorizedResponse();
        return new Response(JSON.stringify(unauthorized.body), {
          status: unauthorized.status,
          headers: unauthorized.headers,
        });
      }
    } else {
      // Passthrough Mode: require client-provided API key
      const clientKey = extractPassthroughKey(req);
      if (!clientKey) {
        return new Response(JSON.stringify({
          error: 'Missing API key',
          message: 'Provide exaApiKey query param or X-Exa-Api-Key header',
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Store key in request context for tools to use
      (req as any).__exaApiKey = clientKey;
    }

    // Handle MCP protocol
    if (req.method === 'POST') {
      return handleMcpPost(req, debug);
    }

    if (req.method === 'GET') {
      return handleMcpGet(req, debug);
    }

    if (req.method === 'DELETE') {
      return handleMcpDelete(req, debug);
    }

    return new Response('Method not allowed', { status: 405 });
  }

  return new Response('Not found', { status: 404 });
}

/**
 * Handle MCP request using fetch-to-node conversion
 */
async function handleMCPRequest(
  transport: StreamableHTTPServerTransport,
  request: Request,
): Promise<Response> {
  const { req, res } = toReqRes(request);
  await transport.handleRequest(req, res);
  const response = await toFetchResponse(res);
  return response;
}

/**
 * Handle MCP POST requests (new messages)
 */
async function handleMcpPost(req: Request, debug: boolean): Promise<Response> {
  try {
    const sessionId = req.headers.get('mcp-session-id');
    let transport: StreamableHTTPServerTransport;

    // Clone the request for body reading while keeping original for handleRequest
    const originalRequest = req.clone();
    const body = await req.text();

    // Check if this is an initialize request
    let parsedBody: any = null;
    try {
      parsedBody = body ? JSON.parse(body) : {};
    } catch {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' },
        id: null,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const isInit = isInitializeRequest(parsedBody);

    if (sessionId && sessions.has(sessionId)) {
      transport = sessions.get(sessionId)!;
    } else if (isInit) {
      // Create new session for initialize request
      const server = createServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id: string) => {
          sessions.set(id, transport);
          if (debug) log(`[Deno] Session initialized: ${id}`);
        },
      });

      await server.server.connect(transport);
    } else {
      // No session and not an initialize request
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid request: session not found' },
        id: null,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Use fetch-to-node to handle the request
    return await handleMCPRequest(transport, originalRequest);
  } catch (error) {
    log(`[Deno] Error handling POST: ${error}`);
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal error' },
      id: null,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Handle MCP GET requests (SSE stream)
 */
async function handleMcpGet(req: Request, debug: boolean): Promise<Response> {
  const sessionId = req.headers.get('mcp-session-id');
  
  if (!sessionId || !sessions.has(sessionId)) {
    return new Response('Session not found', { status: 404 });
  }

  const transport = sessions.get(sessionId)!;
  
  try {
    return await handleMCPRequest(transport, req);
  } catch (error) {
    log(`[Deno] Error handling GET: ${error}`);
    return new Response('Internal error', { status: 500 });
  }
}

/**
 * Handle MCP DELETE requests (close session)
 */
async function handleMcpDelete(req: Request, debug: boolean): Promise<Response> {
  const sessionId = req.headers.get('mcp-session-id');
  
  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId)!;
    await transport.close();
    sessions.delete(sessionId);
    if (debug) log(`[Deno] Session closed: ${sessionId}`);
  }

  return new Response(null, { status: 204 });
}

/**
 * Main entry point
 */
async function main() {
  // Initialize API key manager
  const keyManager = getApiKeyManager();
  await keyManager.initialize();

  const status = keyManager.getStatus();
  log(`[Deno] API Key Manager initialized: ${status.total} key(s), ${status.active} active`);

  const port = parseInt(Deno.env.get('PORT') || '8000', 10);
  const hostname = Deno.env.get('HOSTNAME') || '0.0.0.0';

  log(`[Deno] Starting Exa MCP Server on ${hostname}:${port}`);
  log(`[Deno] Auth required: ${isAuthRequired()}`);

  Deno.serve({ port, hostname }, handleRequest);
}

// Run the server
main().catch((error) => {
  log(`[Deno] Fatal error: ${error}`);
  throw error;
});
