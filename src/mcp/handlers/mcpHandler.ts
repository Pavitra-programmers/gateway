/**
 * MCP Gateway Request Handlers
 * Handles incoming MCP requests from clients
 */

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { logger } from '../utils/logger.js';
import { getMCPContext } from '../middleware/hydrateContext.js';
import { getSessionManager, MCPSession } from '../services/mcpSession.js';
import {
  MCP_HEADERS,
  CONTENT_TYPES,
  JSONRPC_ERROR_CODES,
  ERROR_MESSAGES,
} from '../constants/index.js';
import type {
  JSONRPCRequest,
  JSONRPCResponse,
  TransportType,
} from '../types/index.js';

const log = logger.child('mcpHandler');

/**
 * Parse JSON-RPC request from body
 */
async function parseJSONRPCRequest(c: Context): Promise<JSONRPCRequest | JSONRPCRequest[]> {
  try {
    const body = await c.req.json();
    return body;
  } catch (error) {
    throw new HTTPException(400, { message: 'Invalid JSON in request body' });
  }
}

/**
 * Validate JSON-RPC request structure
 */
function validateJSONRPCRequest(request: unknown): request is JSONRPCRequest {
  if (!request || typeof request !== 'object') {
    return false;
  }

  const req = request as Record<string, unknown>;
  return (
    req.jsonrpc === '2.0' &&
    typeof req.method === 'string' &&
    req.method.length > 0
  );
}

/**
 * Create error response
 */
function createErrorResponse(
  id: string | number | undefined,
  code: number,
  message: string,
  data?: unknown
): JSONRPCResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  };
}

/**
 * Get or create session for request
 */
async function getOrCreateSession(c: Context): Promise<MCPSession> {
  const mcpContext = getMCPContext(c);
  const sessionManager = getSessionManager();

  // Check for existing session ID in header
  const existingSessionId = c.req.header(MCP_HEADERS.SESSION_ID);

  const session = await sessionManager.getOrCreateSession(existingSessionId, {
    serverUrl: mcpContext.serverUrl,
    apiKey: mcpContext.apiKey,
    serverConfig: mcpContext.serverConfig,
    tokens: mcpContext.tokens,
    toolkitConfig: mcpContext.toolkitConfig,
    clientTransportType: mcpContext.clientTransportType,
  });

  // Initialize if new
  if (session.getState() === ('new' as any)) {
    await session.initialize();
  }

  return session;
}

/**
 * Handle SSE connection request (GET)
 */
export async function handleSSERequest(c: Context): Promise<Response> {
  const mcpContext = getMCPContext(c);
  log.info('SSE connection request', {
    serverUrl: mcpContext.serverUrl,
  });

  try {
    const session = await getOrCreateSession(c);
    return session.createSSEResponse();
  } catch (error) {
    log.error('Failed to establish SSE connection', { error });
    throw new HTTPException(500, {
      message: error instanceof Error ? error.message : 'Failed to establish connection',
    });
  }
}

/**
 * Handle HTTP request (POST)
 */
export async function handleHTTPRequest(c: Context): Promise<Response> {
  const mcpContext = getMCPContext(c);

  log.debug('HTTP request', {
    serverUrl: mcpContext.serverUrl,
  });

  // Parse request body
  let body: JSONRPCRequest | JSONRPCRequest[];
  try {
    body = await parseJSONRPCRequest(c);
  } catch (error) {
    return c.json(
      createErrorResponse(undefined, JSONRPC_ERROR_CODES.PARSE_ERROR, 'Parse error'),
      400
    );
  }

  // Handle batch requests
  if (Array.isArray(body)) {
    return handleBatchRequest(c, body);
  }

  // Validate request
  if (!validateJSONRPCRequest(body)) {
    return c.json(
      createErrorResponse(
        (body as any)?.id,
        JSONRPC_ERROR_CODES.INVALID_REQUEST,
        'Invalid Request'
      ),
      400
    );
  }

  // Get or create session
  let session: MCPSession;
  try {
    session = await getOrCreateSession(c);
  } catch (error) {
    return c.json(
      createErrorResponse(
        body.id,
        JSONRPC_ERROR_CODES.INTERNAL_ERROR,
        error instanceof Error ? error.message : 'Failed to create session'
      ),
      500
    );
  }

  // Handle request
  try {
    const response = await session.handleClientRequest(body);

    // Add session ID to response headers
    return new Response(JSON.stringify(response), {
      headers: {
        'Content-Type': CONTENT_TYPES.JSON,
        [MCP_HEADERS.SESSION_ID]: session.sessionId,
      },
    });
  } catch (error) {
    log.error('Failed to handle request', { error, method: body.method });
    return c.json(
      createErrorResponse(
        body.id,
        JSONRPC_ERROR_CODES.INTERNAL_ERROR,
        error instanceof Error ? error.message : 'Internal error'
      ),
      500
    );
  }
}

/**
 * Handle batch request
 */
async function handleBatchRequest(
  c: Context,
  requests: JSONRPCRequest[]
): Promise<Response> {
  if (requests.length === 0) {
    return c.json(
      createErrorResponse(undefined, JSONRPC_ERROR_CODES.INVALID_REQUEST, 'Empty batch'),
      400
    );
  }

  // Get or create session
  let session: MCPSession;
  try {
    session = await getOrCreateSession(c);
  } catch (error) {
    return c.json(
      requests.map((req) =>
        createErrorResponse(
          (req as any)?.id,
          JSONRPC_ERROR_CODES.INTERNAL_ERROR,
          'Failed to create session'
        )
      ),
      500
    );
  }

  // Process each request
  const responses: JSONRPCResponse[] = [];
  for (const request of requests) {
    if (!validateJSONRPCRequest(request)) {
      responses.push(
        createErrorResponse(
          (request as any)?.id,
          JSONRPC_ERROR_CODES.INVALID_REQUEST,
          'Invalid Request'
        )
      );
      continue;
    }

    try {
      const response = await session.handleClientRequest(request);
      responses.push(response);
    } catch (error) {
      responses.push(
        createErrorResponse(
          request.id,
          JSONRPC_ERROR_CODES.INTERNAL_ERROR,
          error instanceof Error ? error.message : 'Internal error'
        )
      );
    }
  }

  return new Response(JSON.stringify(responses), {
    headers: {
      'Content-Type': CONTENT_TYPES.JSON,
      [MCP_HEADERS.SESSION_ID]: session.sessionId,
    },
  });
}

/**
 * Main MCP request handler
 * Routes to SSE or HTTP based on request method and headers
 */
export async function handleMCPRequest(c: Context): Promise<Response> {
  const method = c.req.method;
  const accept = c.req.header('accept') || '';

  // GET requests establish SSE connections
  if (method === 'GET') {
    // Check if client wants SSE
    if (accept.includes(CONTENT_TYPES.SSE)) {
      return handleSSERequest(c);
    }

    // Otherwise, treat as HTTP request (for tools/list etc.)
    return handleHTTPRequest(c);
  }

  // POST requests are HTTP JSON-RPC
  if (method === 'POST') {
    return handleHTTPRequest(c);
  }

  // Unsupported method
  throw new HTTPException(405, { message: 'Method not allowed' });
}

/**
 * Health check handler
 */
export function handleHealthCheck(c: Context): Response {
  const sessionManager = getSessionManager();
  return c.json({
    status: 'ok',
    sessions: sessionManager.getSessionCount(),
  });
}

/**
 * Session info handler (for debugging/admin)
 */
export async function handleSessionInfo(c: Context): Promise<Response> {
  const sessionId = c.req.param('sessionId');
  if (!sessionId) {
    throw new HTTPException(400, { message: 'Session ID required' });
  }

  const sessionManager = getSessionManager();
  const session = sessionManager.getSession(sessionId);

  if (!session) {
    throw new HTTPException(404, { message: ERROR_MESSAGES.SESSION_NOT_FOUND });
  }

  return c.json(session.getInfo());
}

/**
 * Close session handler
 */
export async function handleCloseSession(c: Context): Promise<Response> {
  const sessionId = c.req.param('sessionId');
  if (!sessionId) {
    throw new HTTPException(400, { message: 'Session ID required' });
  }

  const sessionManager = getSessionManager();
  sessionManager.closeSession(sessionId);

  return c.json({ message: 'Session closed' });
}
