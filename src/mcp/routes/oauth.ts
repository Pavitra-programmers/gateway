/**
 * OAuth Routes for MCP Gateway
 * Handles OAuth 2.1 authorization flows using URL-based routing
 * Uses nonce-based state tokens for security
 */

import { Hono } from 'hono';
import { createLogger } from '../../shared/utils/logger.js';
import { getControlPlane } from '../middleware/controlPlane.js';
import {
  createOAuthState,
  validateOAuthStateToken,
  getOAuthStateData,
  deleteOAuthState,
  normalizeServerUrl,
} from '../services/oauthState.js';
import type { ServerConfig } from '../types/index.js';

const logger = createLogger('oauth-routes');

type Env = {
  Variables: {
    serverConfig?: ServerConfig;
    tokenInfo?: any;
  };
};

const oauthRoutes = new Hono<Env>();

/**
 * OAuth Authorization endpoint
 * URL-based: /oauth/authorize?url=<base64url>
 * Redirects to upstream OAuth provider
 */
oauthRoutes.get('/oauth/authorize', async (c) => {
  const encodedUrl = c.req.query('url');
  const apiKey = c.req.header('x-portkey-api-key');

  if (!encodedUrl) {
    return c.json({ error: 'Missing url query parameter' }, 400);
  }

  if (!apiKey) {
    return c.json({ error: 'Missing x-portkey-api-key header' }, 401);
  }

  let serverUrl: string;
  try {
    serverUrl = Buffer.from(encodedUrl, 'base64url').toString('utf-8');
    if (!serverUrl.startsWith('http://') && !serverUrl.startsWith('https://')) {
      throw new Error('Invalid URL scheme');
    }
    serverUrl = normalizeServerUrl(serverUrl);
  } catch {
    return c.json({ error: 'Invalid url parameter' }, 400);
  }

  // Get server config to check OAuth settings
  const controlPlane = getControlPlane();
  const clientInfo = await controlPlane.getMCPClientInfoByUrl(apiKey, serverUrl);

  // For URL-based routing, we may not have pre-configured OAuth
  // The OAuth config should be discovered from the MCP server
  // For now, return an error if not configured
  if (!clientInfo?.oauthConfig) {
    logger.info('OAuth auto-discovery not yet implemented', { serverUrl });
    return c.json({
      error: 'OAuth not configured for this server',
      hint: 'OAuth auto-discovery from MCP server is not yet implemented'
    }, 400);
  }

  const oauthConfig = clientInfo.oauthConfig;

  // Create secure state token (stores apiKey + serverUrl in cache)
  const stateToken = await createOAuthState(apiKey, serverUrl);

  // Build authorization URL
  const baseUrl = new URL(c.req.url).origin;
  const redirectUri = `${baseUrl}/oauth/callback`;

  const authUrl = new URL(oauthConfig.authorization_url);
  authUrl.searchParams.set('client_id', oauthConfig.client_id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', stateToken);
  if (oauthConfig.scopes) {
    authUrl.searchParams.set('scope', oauthConfig.scopes.join(' '));
  }
  // RFC 8707: Resource Indicator - bind token to specific MCP server
  authUrl.searchParams.set('resource', serverUrl);

  logger.info('Redirecting to OAuth authorization', {
    serverUrl,
    authUrl: authUrl.origin,
  });

  return c.redirect(authUrl.toString());
});

/**
 * OAuth Callback endpoint
 * Handles the OAuth callback and exchanges code for tokens
 * Uses state token to retrieve apiKey and serverUrl
 */
oauthRoutes.get('/oauth/callback', async (c) => {
  const code = c.req.query('code');
  const stateToken = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    logger.error('OAuth callback error', {
      error,
      description: c.req.query('error_description'),
    });
    return c.html(`
      <!DOCTYPE html>
      <html>
        <head><title>OAuth Error</title></head>
        <body>
          <h1>Authorization Failed</h1>
          <p>Error: ${error}</p>
          <p>${c.req.query('error_description') || ''}</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'oauth-error', error: '${error}' }, '*');
              window.close();
            }
          </script>
        </body>
      </html>
    `);
  }

  if (!code) {
    return c.json({ error: 'Authorization code missing' }, 400);
  }

  if (!stateToken) {
    return c.json({ error: 'State parameter missing' }, 400);
  }

  // Validate state token and get cached data
  const payload = validateOAuthStateToken(stateToken);
  if (!payload) {
    logger.warn('Invalid or expired state token');
    return c.json({ error: 'Invalid or expired state' }, 400);
  }

  const stateData = await getOAuthStateData(payload.nonce);
  if (!stateData) {
    logger.warn('State data not found in cache');
    return c.json({ error: 'State data not found' }, 400);
  }

  const { apiKey, serverUrl } = stateData;

  // Clean up state from cache
  await deleteOAuthState(payload.nonce);

  // Get OAuth config for token exchange
  const controlPlane = getControlPlane();
  const clientInfo = await controlPlane.getMCPClientInfoByUrl(apiKey, serverUrl);

  if (!clientInfo?.oauthConfig) {
    return c.json({ error: 'OAuth configuration not found' }, 500);
  }

  const oauthConfig = clientInfo.oauthConfig;

  try {
    // Exchange code for tokens
    const baseUrl = new URL(c.req.url).origin;
    const redirectUri = `${baseUrl}/oauth/callback`;

    const tokenResponse = await fetch(oauthConfig.token_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: oauthConfig.client_id,
        ...(oauthConfig.client_secret && {
          client_secret: oauthConfig.client_secret,
        }),
        // RFC 8707: Resource Indicator - must match authorize request
        resource: serverUrl,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      logger.error('Token exchange failed', { status: tokenResponse.status, error: errorData });
      throw new Error(`Token exchange failed: ${tokenResponse.status}`);
    }

    const tokens = await tokenResponse.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };

    // Store tokens using apiKey + serverUrl
    await controlPlane.saveMCPTokensByUrl(apiKey, serverUrl, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : undefined,
      token_type: tokens.token_type || 'Bearer',
      scopes: tokens.scope?.split(' '),
    });

    logger.info('OAuth tokens obtained successfully', { serverUrl });

    // Return success page
    return c.html(`
      <!DOCTYPE html>
      <html>
        <head><title>Authorization Successful</title></head>
        <body>
          <h1>Authorization Successful</h1>
          <p>You can close this window and return to your MCP client.</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'oauth-success' }, '*');
              window.close();
            }
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    logger.error('OAuth token exchange failed', error);
    return c.html(`
      <!DOCTYPE html>
      <html>
        <head><title>Authorization Failed</title></head>
        <body>
          <h1>Authorization Failed</h1>
          <p>Failed to complete authorization. Please try again.</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'oauth-error', error: 'token_exchange_failed' }, '*');
              window.close();
            }
          </script>
        </body>
      </html>
    `);
  }
});

/**
 * Token endpoint for refresh_token and client_credentials flows
 * Implements OAuth 2.1 token refresh with RFC 8707 resource indicator support
 */
oauthRoutes.post('/oauth/token', async (c) => {
  const body = await c.req.parseBody();
  const grantType = body['grant_type'] as string;
  const apiKey = c.req.header('x-portkey-api-key');

  if (!apiKey) {
    return c.json({ error: 'invalid_client', error_description: 'API key required' }, 401);
  }

  // Handle refresh_token grant type
  if (grantType === 'refresh_token') {
    const refreshToken = body['refresh_token'] as string;
    const serverUrl = body['server_url'] as string;

    if (!refreshToken) {
      return c.json(
        { error: 'invalid_request', error_description: 'refresh_token required' },
        400
      );
    }

    if (!serverUrl) {
      return c.json(
        { error: 'invalid_request', error_description: 'server_url required' },
        400
      );
    }

    try {
      const controlPlane = getControlPlane();
      const clientInfo = await controlPlane.getMCPClientInfoByUrl(apiKey, serverUrl);

      if (!clientInfo?.oauthConfig) {
        return c.json({ error: 'invalid_client', error_description: 'OAuth not configured' }, 400);
      }

      const oauthConfig = clientInfo.oauthConfig;

      // Exchange refresh token for new tokens at upstream OAuth server
      const tokenResponse = await fetch(oauthConfig.token_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: oauthConfig.client_id,
          ...(oauthConfig.client_secret && {
            client_secret: oauthConfig.client_secret,
          }),
          // RFC 8707: Resource Indicator - bind token to specific resource
          resource: serverUrl,
        }),
      });

      if (!tokenResponse.ok) {
        const errorData = await tokenResponse.text();
        logger.error('Token refresh failed', { status: tokenResponse.status, error: errorData });
        return c.json(
          { error: 'invalid_grant', error_description: 'Token refresh failed' },
          400
        );
      }

      const tokens = await tokenResponse.json() as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
        scope?: string;
      };

      // Store new tokens with resource binding (RFC 8707)
      await controlPlane.saveMCPTokensByUrl(apiKey, serverUrl, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : undefined,
        token_type: tokens.token_type || 'Bearer',
        scopes: tokens.scope?.split(' '),
      });

      logger.info('OAuth tokens refreshed successfully', { serverUrl });

      // Return tokens in standard OAuth format
      return c.json({
        access_token: tokens.access_token,
        token_type: tokens.token_type || 'Bearer',
        expires_in: tokens.expires_in,
        refresh_token: tokens.refresh_token,
        scope: tokens.scope,
      });
    } catch (error) {
      logger.error('Token refresh failed', error);
      return c.json(
        { error: 'server_error', error_description: 'Internal error during token refresh' },
        500
      );
    }
  }

  // Handle client_credentials grant type (placeholder)
  if (grantType === 'client_credentials') {
    // In a full implementation, validate client credentials and issue tokens
    return c.json({ error: 'not_implemented' }, 501);
  }

  return c.json(
    { error: 'unsupported_grant_type', error_description: 'Supported: refresh_token, client_credentials' },
    400
  );
});

/**
 * Token revocation endpoint
 */
oauthRoutes.post('/oauth/revoke', async (c) => {
  const body = await c.req.parseBody();
  const token = body['token'];

  if (!token) {
    return c.json({ error: 'invalid_request', error_description: 'Token required' }, 400);
  }

  // In a full implementation, revoke the token
  logger.info('Token revocation requested');

  return c.newResponse(null, 200);
});

export { oauthRoutes };
