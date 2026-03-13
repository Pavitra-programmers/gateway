/**
 * Well-Known Routes for MCP Gateway
 * OAuth 2.1 Discovery endpoints
 * Uses URL-based routing pattern
 */

import { Hono } from 'hono';
import { createLogger } from '../../shared/utils/logger.js';

const logger = createLogger('wellknown-routes');

type Env = {
  Variables: {
    baseUrl?: string;
  };
};

const wellKnownRoutes = new Hono<Env>();

const CACHE_MAX_AGE = 3600; // 1 hour

/**
 * Helper to get base URL from request
 */
function getBaseUrl(c: any): string {
  // Check for explicit base URL in context
  const contextBaseUrl = c.get('baseUrl');
  if (contextBaseUrl) {
    return contextBaseUrl;
  }

  // Build from request
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

/**
 * OAuth 2.1 Authorization Server Discovery
 * https://datatracker.ietf.org/doc/html/rfc8414
 */
wellKnownRoutes.get('/oauth-authorization-server', async (c) => {
  const baseUrl = getBaseUrl(c);

  logger.debug('OAuth authorization server metadata requested', { baseUrl });

  const metadata = {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256', 'plain'],
    scopes_supported: ['mcp:servers:*', 'mcp:*', 'openid', 'profile'],
  };

  return c.json(metadata, 200, {
    'Cache-Control': `public, max-age=${CACHE_MAX_AGE}`,
  });
});

/**
 * OAuth 2.1 Protected Resource Metadata
 * https://datatracker.ietf.org/doc/html/rfc9728
 */
wellKnownRoutes.get('/oauth-protected-resource', async (c) => {
  const baseUrl = getBaseUrl(c);

  const metadata = {
    resource: baseUrl,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
    resource_documentation: `${baseUrl}/docs`,
    scopes_supported: ['mcp:servers:*', 'mcp:*'],
  };

  return c.json(metadata, 200, {
    'Cache-Control': `public, max-age=${CACHE_MAX_AGE}`,
  });
});

/**
 * MCP Protocol Discovery
 * For MCP clients to discover gateway capabilities
 * Uses URL-based routing: /mcp?url=<base64url_encoded_server_url>
 */
wellKnownRoutes.get('/mcp', async (c) => {
  const baseUrl = getBaseUrl(c);

  const metadata = {
    protocol: 'mcp',
    version: '2024-11-05',
    gateway: 'StringCost MCP Gateway',
    endpoints: {
      // URL-based routing pattern
      mcp: `${baseUrl}/mcp?url={base64url_encoded_server_url}`,
      sse: `${baseUrl}/sse?url={base64url_encoded_server_url}`,
    },
    transports: ['streamable-http', 'sse'],
    authentication: {
      types: ['bearer', 'api_key'],
      headers: {
        api_key: 'x-portkey-api-key',
      },
      oauth: {
        discovery: `${baseUrl}/.well-known/oauth-authorization-server`,
        authorize: `${baseUrl}/oauth/authorize?url={base64url_encoded_server_url}`,
      },
    },
    usage: {
      description: 'To use this gateway, encode your MCP server URL as base64url and pass it as the url query parameter',
      example: {
        server_url: 'https://mcp.example.com/sse',
        encoded_url: Buffer.from('https://mcp.example.com/sse').toString('base64url'),
        request_url: `${baseUrl}/mcp?url=${Buffer.from('https://mcp.example.com/sse').toString('base64url')}`,
      },
    },
  };

  return c.json(metadata, 200, {
    'Cache-Control': `public, max-age=${CACHE_MAX_AGE}`,
  });
});

export { wellKnownRoutes };
