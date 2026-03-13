/**
 * OAuth Middleware for MCP Gateway
 * Handles OAuth 2.1 authentication for MCP connections
 */

import { createMiddleware } from 'hono/factory';
import { createLogger } from '../../../shared/utils/logger.js';
import { getTokenCache } from '../../../shared/services/cache/index.js';
import type { Context } from 'hono';

const logger = createLogger('mcp/oauth');

type Env = {
  Variables: {
    tokenInfo?: TokenIntrospectionResponse;
    userId?: string;
    controlPlane?: any;
  };
};

export interface TokenIntrospectionResponse {
  active: boolean;
  token?: string;
  username?: string;
  client_id?: string;
  scope?: string;
  exp?: number;
  iat?: number;
  sub?: string;
  aud?: string | string[];
  iss?: string;
  jti?: string;
  token_type?: string;
  workspace_id?: string;
  [key: string]: any;
}

interface OAuthConfig {
  required?: boolean;
  scopes?: string[];
  skipPaths?: string[];
}

/**
 * Extract bearer token from request
 */
function extractBearerToken(c: Context): string | null {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
}

/**
 * Introspect token with control plane or local validation
 */
async function introspectToken(
  token: string,
  c: Context
): Promise<TokenIntrospectionResponse> {
  // Check cache first
  const tokenCache = getTokenCache();
  const cacheKey = `introspection:${token.slice(-8)}`;

  try {
    const cached = await tokenCache.get<TokenIntrospectionResponse>(
      cacheKey,
      'token_introspection'
    );
    if (cached) {
      logger.debug('Token introspection cache hit');
      return cached;
    }
  } catch (e) {
    // Cache miss, continue with introspection
  }

  // Try control plane introspection
  const controlPlane = c.get('controlPlane');
  if (controlPlane) {
    try {
      const result = await controlPlane.introspectToken(token);
      if (result) {
        // Cache the result
        await tokenCache.set(cacheKey, result, {
          namespace: 'token_introspection',
          ttl: 60 * 1000, // 1 minute cache
        });
        return result;
      }
    } catch (e) {
      logger.warn('Control plane token introspection failed', e);
    }
  }

  // Fallback: treat token as valid (for local development)
  // In production, this should be more strict
  return {
    active: true,
    token,
    username: 'local-user',
  };
}

/**
 * Create WWW-Authenticate header for 401 responses
 */
function createWWWAuthenticateHeader(
  realm: string,
  error?: string,
  errorDescription?: string
): string {
  let header = `Bearer realm="${realm}"`;
  if (error) {
    header += `, error="${error}"`;
  }
  if (errorDescription) {
    header += `, error_description="${errorDescription}"`;
  }
  return header;
}

/**
 * OAuth middleware factory
 */
export function oauthMiddleware(config: OAuthConfig = {}) {
  const { required = true, scopes = [], skipPaths = [] } = config;

  return createMiddleware<Env>(async (c, next) => {
    const path = c.req.path;

    // Skip OAuth for certain paths
    if (skipPaths.some((skip) => path.includes(skip))) {
      logger.debug(`Skipping OAuth for path: ${path}`);
      return next();
    }

    // Extract token
    const token = extractBearerToken(c);

    if (!token) {
      if (required) {
        logger.warn(`Missing bearer token for ${path}`);
        return c.json(
          {
            error: 'unauthorized',
            error_description: 'Bearer token required',
          },
          401,
          {
            'WWW-Authenticate': createWWWAuthenticateHeader(
              'mcp',
              'invalid_token',
              'Bearer token required'
            ),
          }
        );
      }
      return next();
    }

    // Introspect token
    const introspection = await introspectToken(token, c);
    introspection.token = token;

    if (!introspection.active) {
      logger.warn(`Invalid or expired token for ${path}`);
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Token is invalid or expired',
        },
        401,
        {
          'WWW-Authenticate': createWWWAuthenticateHeader(
            'mcp',
            'invalid_token',
            'Token is invalid or expired'
          ),
        }
      );
    }

    // Check scopes if required
    if (scopes.length > 0 && introspection.scope) {
      const tokenScopes = introspection.scope.split(' ');
      const hasRequiredScope = scopes.some(
        (required) =>
          tokenScopes.includes(required) ||
          tokenScopes.includes('mcp:*') ||
          tokenScopes.includes('*')
      );

      if (!hasRequiredScope) {
        logger.warn(`Insufficient scope for ${path}`);
        return c.json(
          {
            error: 'insufficient_scope',
            error_description: `Required scope: ${scopes.join(' or ')}`,
          },
          403,
          {
            'WWW-Authenticate': createWWWAuthenticateHeader(
              'mcp',
              'insufficient_scope',
              `Required scope: ${scopes.join(' or ')}`
            ),
          }
        );
      }
    }

    // Store token info in context
    c.set('tokenInfo', introspection);
    c.set('userId', introspection.username || introspection.sub);

    logger.debug('OAuth authentication successful', {
      path,
      userId: introspection.username,
    });

    return next();
  });
}

/**
 * API Key to Token mapper middleware
 * Maps x-portkey-api-key header to OAuth-style token info
 */
export function apiKeyToTokenMapper() {
  return createMiddleware<Env>(async (c, next) => {
    const apiKey = c.req.header('x-portkey-api-key');

    if (!apiKey) {
      return next();
    }

    // For API key auth, we create a synthetic token info
    // The actual validation should happen via control plane
    const controlPlane = c.get('controlPlane');

    if (controlPlane) {
      try {
        // Validate API key through control plane
        const keyInfo = await controlPlane.validateApiKey(apiKey);
        if (keyInfo) {
          c.set('tokenInfo', {
            active: true,
            token: apiKey,
            username: keyInfo.userId || 'api-key-user',
            client_id: keyInfo.clientId,
          });
          c.set('userId', keyInfo.userId);
          return next();
        }
      } catch (e) {
        logger.warn('API key validation failed', e);
      }
    }

    // Fallback: create minimal token info from API key
    // In production, this should validate against the control plane
    c.set('tokenInfo', {
      active: true,
      token: apiKey,
      username: 'api-key-user',
    });

    return next();
  });
}

export type { OAuthConfig };
