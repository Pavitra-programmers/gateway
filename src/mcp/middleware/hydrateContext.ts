/**
 * MCP Gateway Context Hydration Middleware
 * Extracts serverUrl and apiKey, builds server config, and adds to context
 */

import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getControlPlane } from './controlPlane.js';
import { logger } from '../utils/logger.js';
import { MCP_HEADERS, ERROR_MESSAGES, CONTENT_TYPES } from '../constants/index.js';
import { normalizeServerUrl } from '../services/oauthState.js';
import type { MCPContext, ServerConfig, ToolkitConfig, ToolPermission, TransportType } from '../types/index.js';

const log = logger.child('hydrateContext');

// Key for storing MCP context in Hono's c.set()
export const MCP_CONTEXT_KEY = 'mcpContext';

/**
 * Extract server URL from request
 * Priority: context (set by validateUrlMiddleware) > query param
 */
export function extractServerUrl(c: Context): string | null {
  // From context (set by validateUrlMiddleware)
  const contextUrl = c.get('serverUrl') as string | undefined;
  if (contextUrl) {
    return normalizeServerUrl(contextUrl);
  }

  // From query param (fallback - decode base64url)
  const encodedUrl = c.req.query('url');
  if (encodedUrl) {
    try {
      const decoded = Buffer.from(encodedUrl, 'base64url').toString('utf-8');
      return normalizeServerUrl(decoded);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Extract API key from request
 * Checks headers first, then falls back to presigned token info
 */
export function extractApiKey(c: Context): string | null {
  // From headers
  const headerKey = c.req.header('x-portkey-api-key') || c.req.header(MCP_HEADERS.API_KEY);
  if (headerKey) {
    return headerKey;
  }

  // From presigned auth token info (set by presignedAuthMiddleware)
  const tokenInfo = c.get('tokenInfo') as { client_id?: string; token?: string } | undefined;
  if (tokenInfo?.client_id) {
    // Use client_id from token as the "apiKey" for cache keys
    return `presigned:${tokenInfo.client_id}`;
  }

  return null;
}

/**
 * Extract toolkit ID from request (optional)
 */
function extractToolkitId(c: Context): string | null {
  return c.req.header(MCP_HEADERS.TOOLKIT_ID) || c.req.query('toolkit') || null;
}

/**
 * Determine client transport type from request
 */
function determineClientTransportType(c: Context): TransportType {
  const accept = c.req.header(MCP_HEADERS.ACCEPT) || '';

  if (accept.includes(CONTENT_TYPES.SSE)) {
    return 'sse';
  }

  if (accept.includes(CONTENT_TYPES.JSON)) {
    return 'http';
  }

  // Default based on method
  if (c.req.method === 'GET') {
    return 'sse';
  }

  return 'http';
}

/**
 * Build server config from URL (for URL-based routing)
 */
function buildServerConfigFromUrl(serverUrl: string): ServerConfig {
  // Detect transport type from URL
  let transport: TransportType = 'http';
  if (serverUrl.includes('/sse') || serverUrl.endsWith('/sse')) {
    transport = 'sse';
  }

  return {
    serverId: serverUrl, // Use URL as serverId for cache keys
    url: serverUrl,
    serverLabel: `MCP Server: ${new URL(serverUrl).hostname}`,
    transport: {
      preferred: transport,
      allowFallback: true,
    },
    authType: 'none', // Will be updated if OAuth tokens are found
    isActive: true,
  };
}

/**
 * Hydrate context middleware
 * Extracts serverUrl and apiKey, builds config, adds to request context
 */
export async function hydrateContext(c: Context, next: Next): Promise<void | Response> {
  const serverUrl = extractServerUrl(c);
  const apiKey = extractApiKey(c);
  const toolkitId = extractToolkitId(c);

  log.debug('Hydrating context', { serverUrl, hasApiKey: !!apiKey, toolkitId });

  // Validate required parameters
  if (!serverUrl) {
    log.warn('Missing server URL');
    throw new HTTPException(400, { message: 'Missing server URL. Provide url query parameter.' });
  }

  if (!apiKey) {
    log.warn('Missing API key');
    throw new HTTPException(401, { message: 'Missing API key. Provide x-portkey-api-key header.' });
  }

  const controlPlane = getControlPlane();

  // Build server config from URL
  // In production, this could be enhanced to fetch additional config from control plane
  let serverConfig: ServerConfig = buildServerConfigFromUrl(serverUrl);

  // Fetch toolkit config if toolkit ID provided
  let toolkitConfig: ToolkitConfig | undefined;
  if (toolkitId) {
    try {
      const toolkit = await controlPlane.getMCPToolkitByApiKey(apiKey, toolkitId);
      if (toolkit) {
        if (!toolkit.isActive) {
          log.warn('Toolkit not active', { toolkitId });
          throw new HTTPException(403, { message: ERROR_MESSAGES.TOOLKIT_NOT_ACTIVE });
        }
        toolkitConfig = toolkit;
      } else {
        log.warn('Toolkit not found', { toolkitId });
        throw new HTTPException(404, { message: ERROR_MESSAGES.TOOLKIT_NOT_FOUND });
      }
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      log.error('Failed to fetch toolkit config', { toolkitId, error });
      throw new HTTPException(500, { message: 'Failed to fetch toolkit configuration' });
    }
  }

  // If no toolkit from header, check for tool_permissions in presigned token metadata
  if (!toolkitConfig) {
    const tokenInfo = c.get('tokenInfo') as { payload?: { meta?: Record<string, unknown> } } | undefined;
    const tokenToolPermissions = tokenInfo?.payload?.meta?.tool_permissions as Record<string, unknown> | undefined;

    if (tokenToolPermissions && Object.keys(tokenToolPermissions).length > 0) {
      // Build a synthetic toolkit config from token's tool_permissions
      toolkitConfig = {
        id: `presigned:${tokenInfo?.payload?.meta?.mcp_server_name || 'anonymous'}`,
        name: `Presigned Token Permissions`,
        description: 'Fine-grained permissions from presigned URL token',
        allowedTools: [],  // Not using glob patterns, using fine-grained permissions
        blockedTools: [],
        toolPermissions: tokenToolPermissions as Record<string, ToolPermission>,
        mcpServerIds: [],
        isActive: true,
      };
      log.debug('Built toolkit config from presigned token', {
        permissionCount: Object.keys(tokenToolPermissions).length,
      });
    }
  }

  // Fetch OAuth tokens using apiKey + serverUrl
  let tokens;
  try {
    tokens = await controlPlane.getMCPTokensByUrl(apiKey, serverUrl);
    if (tokens) {
      // If we have tokens, update auth type
      serverConfig = {
        ...serverConfig,
        authType: 'oauth',
      };
      log.debug('Found OAuth tokens for server', { serverUrl });
    }
  } catch (error) {
    log.debug('No OAuth tokens found', { serverUrl, error });
    // Continue without tokens
  }

  // Determine client transport type
  const clientTransportType = determineClientTransportType(c);

  // Create MCP context
  const mcpContext: MCPContext = {
    serverUrl,
    apiKey,
    serverConfig,
    toolkitConfig,
    tokens: tokens ?? undefined,
    clientTransportType,
  };

  // Store in Hono context
  c.set(MCP_CONTEXT_KEY, mcpContext);

  log.debug('Context hydrated successfully', {
    serverUrl,
    serverLabel: serverConfig.serverLabel,
    hasToolkit: !!toolkitConfig,
    hasTokens: !!tokens,
    clientTransportType,
  });

  await next();
}

/**
 * Get MCP context from Hono context
 */
export function getMCPContext(c: Context): MCPContext {
  const ctx = c.get(MCP_CONTEXT_KEY) as MCPContext | undefined;
  if (!ctx) {
    throw new Error('MCP context not found. Did you forget to apply hydrateContext middleware?');
  }
  return ctx;
}

/**
 * Check if MCP context exists
 */
export function hasMCPContext(c: Context): boolean {
  return c.get(MCP_CONTEXT_KEY) !== undefined;
}
