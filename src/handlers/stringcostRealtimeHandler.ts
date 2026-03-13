/**
 * StringCost WebSocket Realtime Handler
 * 
 * Handles WebSocket connections for voice APIs with:
 * - Token-based authentication
 * - Cost monitoring and tracking
 * - Support for OpenAI Realtime, Google Gemini Live, Anthropic Voice
 */

import { Context } from 'hono';
import { WSContext, WSEvents } from 'hono/ws';
import WebSocket from 'ws';
import { createHmac } from 'node:crypto';
import { ProviderAPIConfig } from '../providers/types.js';
import Providers from '../providers/index.js';
import { Options } from '../types/requestBody.js';
import { RealtimeLlmEventParser } from '../services/realtimeLlmEventParser.js';

// ===== Token Verification (same as stringcostProxy) =====
interface AdapterTokenPayload {
  uid: string;
  sid: string;
  cid: string;
  tid?: string;
  provider: string;
  paths: string[];
  perms?: string[];
  vk?: string;
  iat: number;
  exp: number;
  nbf?: number;
  nonce: string;
  ip?: string;
  max_req?: number;
  max_uses?: number;
  meta?: Record<string, any>;
  v: number;
}

function verifyToken(
  token: string,
  requestPath: string,
  secretKey: string,
  requestIp?: string,
  skipPathValidation = false
): { isValid: boolean; payload: AdapterTokenPayload | null; error: string | null } {
  try {
    const tokenData = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
      p: string;
      s: string;
    };
    const canonical = Buffer.from(tokenData.p, 'base64url').toString('utf8');
    const payload = JSON.parse(canonical) as AdapterTokenPayload;
    const expectedSignature = createHmac('sha256', secretKey).update(canonical).digest('hex');
    if (tokenData.s !== expectedSignature) {
      return { isValid: false, payload, error: 'Invalid signature' };
    }

    if (!skipPathValidation) {
      const authorizedPaths = payload.paths || [];
      let allowed = false;
      for (const pattern of authorizedPaths) {
        if (pattern.endsWith('*')) {
          const prefix = pattern.slice(0, -1);
          if (requestPath.startsWith(prefix)) {
            allowed = true;
            break;
          }
        } else if (pattern === requestPath) {
          allowed = true;
          break;
        }
      }
      if (!allowed) {
        return { isValid: false, payload, error: 'Path not authorized' };
      }
    }

    const now = Math.floor(Date.now() / 1000);
    if (now > payload.exp) {
      return { isValid: false, payload, error: 'Token expired' };
    }
    if (payload.nbf && now < payload.nbf) {
      return { isValid: false, payload, error: 'Token not yet valid' };
    }
    if (payload.ip && requestIp && requestIp !== payload.ip) {
      return { isValid: false, payload, error: `IP mismatch. Expected ${payload.ip}, got ${requestIp}` };
    }

    return { isValid: true, payload, error: null };
  } catch (error) {
    return {
      isValid: false,
      payload: null,
      error: `Token parsing error: ${(error as Error).message}`,
    };
  }
}

// Global singleton for database pool
let dbPool: any | null = null;

async function getDbPool(): Promise<any> {
  if (dbPool) {
    return dbPool;
  }
  const connectionString = process.env.SIGNED_URL_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL must be configured for WebSocket proxy');
  }
  
  // Dynamically import pg to avoid bundling issues
  const { Pool } = await import('pg');
  dbPool = new Pool({
    connectionString,
    max: 3,
    min: 0,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: true,
  });
  return dbPool;
}

async function fetchProviderCredential(
  clientId: string,
  provider: string,
  virtualKey: string | undefined
): Promise<{ apiKey: string; metadata: unknown }> {
  const pool = await getDbPool();
  const encryptionKey = process.env.DATABASE_ENCRYPTION_KEY;
  
  if (!encryptionKey) {
    throw new Error('DATABASE_ENCRYPTION_KEY environment variable is required');
  }
  
  const result = await pool.query(
    `SELECT
       CASE
         WHEN encrypted_api_key IS NOT NULL THEN pgp_sym_decrypt(encrypted_api_key::bytea, $4)
         ELSE pgp_sym_decrypt(provider_api_key::bytea, $4)
       END as api_key,
       metadata
       FROM provider_credentials
      WHERE api_client_id = $1 AND provider = $2 AND virtual_key IS NOT DISTINCT FROM $3
      LIMIT 1`,
    [clientId, provider, virtualKey ?? null, encryptionKey]
  );
  if (result.rowCount === 0) {
    throw new Error(`No pre-configured credentials found for provider "${provider}"`);
  }
  return {
    apiKey: result.rows[0].api_key,
    metadata: result.rows[0].metadata,
  };
}

// ===== WebSocket Handler =====

export async function stringcostRealtimeHandler(
  c: Context
): Promise<WSEvents<unknown>> {
  try {
    let incomingWebsocket: WSContext<unknown> | null = null;
    
    // Extract token from URL path: /stringcost-ws/t/{token}/v1/realtime
    const url = new URL(c.req.url);
    const pathParts = url.pathname.split('/');
    const tokenIndex = pathParts.indexOf('t');
    
    if (tokenIndex === -1 || tokenIndex + 1 >= pathParts.length) {
      console.error('[stringcost-ws] Token not found in URL path (token redacted for security)');
      throw new Error('Missing WebSocket token in URL');
    }
    
    const token = pathParts[tokenIndex + 1];
    const intendedPath = '/' + pathParts.slice(tokenIndex + 2).join('/');
    
    console.log('[stringcost-ws] WebSocket connection attempt', {
      tokenPresent: Boolean(token),
      intendedPath,
      // Note: fullPath omitted to prevent token leakage in logs
    });

    // Verify token
    const secretKey = process.env.ADAPTER_TOKEN_SECRET;
    if (!secretKey) {
      throw new Error('ADAPTER_TOKEN_SECRET not configured');
    }

    const clientIp = c.req.header('x-forwarded-for') || c.req.header('x-real-ip');
    const verification = verifyToken(token, intendedPath, secretKey, clientIp);
    
    if (!verification.isValid || !verification.payload) {
      throw new Error(`Token validation failed: ${verification.error}`);
    }

    const payload = verification.payload;
    console.log('[stringcost-ws] Token validated', {
      provider: payload.provider,
    });

    // Fetch provider credentials
    const credential = await fetchProviderCredential(
      payload.cid,
      payload.provider,
      payload.vk
    );

    // Build WebSocket URL
    // For custom paths (like Gemini Live), use the intended path from token
    // For standard paths (like OpenAI Realtime), use Portkey's provider config
    let wsUrl: string;
    
    if (intendedPath.startsWith('/ws/')){
      // Custom WebSocket path (e.g., Gemini Live)
      // Extract the base URL for the provider
      let baseHost: string;
      
      if (payload.provider === 'google') {
        // Determine if it's AI Studio or Vertex AI based on path
        if (intendedPath.includes('generativelanguage')) {
          baseHost = 'wss://generativelanguage.googleapis.com';
        } else if (intendedPath.includes('aiplatform')) {
          baseHost = 'wss://aiplatform.googleapis.com';
        } else {
          baseHost = 'wss://generativelanguage.googleapis.com';
        }
      } else {
        // Default to provider's base URL
        const apiConfig: ProviderAPIConfig = Providers[payload.provider].api;
        const tempProviderOptions: Options = {
          provider: payload.provider,
          apiKey: credential.apiKey,
          ...(payload.meta?.config || {}),
        };
        const httpBaseUrl = apiConfig.getBaseURL({
          providerOptions: tempProviderOptions,
          c,
          gatewayRequestURL: c.req.url,
        });
        baseHost = httpBaseUrl.replace('https://', 'wss://').replace('http://', 'ws://');
      }
      
      // Append the custom path and API key
      wsUrl = `${baseHost}${intendedPath}?key=${credential.apiKey}`;
    } else {
      // Standard path - use Portkey's provider config
      const apiConfig: ProviderAPIConfig = Providers[payload.provider].api;
      const providerOptions: Options = {
        provider: payload.provider,
        apiKey: credential.apiKey,
        ...(payload.meta?.config || {}),
      };

      const baseUrl = apiConfig.getBaseURL({
        providerOptions,
        c,
        gatewayRequestURL: c.req.url,
      });
      
      const endpoint = apiConfig.getEndpoint({
        c,
        providerOptions,
        fn: 'realtime',
        gatewayRequestBodyJSON: {},
        gatewayRequestURL: c.req.url,
      });
      
      wsUrl = `${baseUrl}${endpoint}`;
      wsUrl = wsUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    }

    console.log('[stringcost-ws] Connecting to provider', {
      provider: payload.provider,
      wsUrl: wsUrl.replace(/key=[^&]+/, 'key=***'),
      intendedPath,
    });

    // Sanitize wsUrl for storage (remove API keys from query params)
    const sanitizedWsUrl = wsUrl.replace(/([?&])(key|apikey|api_key|token|access_token)=[^&]+/gi, '$1$2=***');

    // Session options for cost tracking
    // Note: Config is nested under payload.meta.config, and model can be in either
    // payload.meta.model or payload.meta.config.model
    const sessionOptions = {
      id: payload.sid,
      providerOptions: {
        provider: payload.provider,
        apiKey: credential.apiKey,
        requestURL: sanitizedWsUrl, // Store sanitized URL (no API keys)
        rubeusURL: 'realtime',
        model: payload.meta?.model || payload.meta?.config?.model || undefined,
        ...(payload.meta?.config || {}),
      },
      requestHeaders: {
        'x-stringcost-session-id': payload.sid,
        'x-stringcost-user-id': payload.uid,
        'x-stringcost-client-id': payload.cid,
        'x-stringcost-provider': payload.provider,
        ...(payload.meta?.external_session ? { 'x-stringcost-external-session': payload.meta.external_session } : {}),
        ...(payload.meta?.external_user ? { 'x-stringcost-external-user': payload.meta.external_user } : {}),
      },
      requestParams: {},
    };

    // Connect to provider WebSocket with auth headers
    // Get provider auth headers
    const apiConfig: ProviderAPIConfig = Providers[payload.provider].api;
    const providerOptions: Options = {
      provider: payload.provider,
      apiKey: credential.apiKey,
      ...(payload.meta?.config || {}),
    };
    
    const headers = await apiConfig.headers({
      c,
      providerOptions,
      fn: 'realtime',
      transformedRequestUrl: wsUrl,
      transformedRequestBody: {},
    });

    const outgoingWebSocket = new WebSocket(wsUrl, {
      headers,
    });
    
    // Import realtimeEventLogger and pass it directly to the parser
    const { realtimeEventLogger } = await import('../services/realtimeEventLogger.js');
    const eventParser = new RealtimeLlmEventParser(realtimeEventLogger);
    let messageCount = 0;
    let bytesReceived = 0;
    let bytesSent = 0;

    outgoingWebSocket.addEventListener('message', (event) => {
      const data = event.data as string;
      bytesReceived += Buffer.byteLength(data, 'utf8');
      messageCount++;
      
      incomingWebsocket?.send(data);
      
      try {
        const parsedData = JSON.parse(data);
        // Pass the context to the event parser so it can access realtimeEventParser
        eventParser.handleEvent(c, parsedData, sessionOptions);
      } catch (err: any) {
        console.error(`[stringcost-ws] eventParser error: ${err.message}`);
      }
    });

    outgoingWebSocket.addEventListener('close', (event) => {
      console.log('[stringcost-ws] Provider WebSocket closed', {
        sessionId: payload.sid,
        code: event.code,
        reason: event.reason,
        messageCount,
        bytesReceived,
        bytesSent,
      });
      incomingWebsocket?.close(event.code, event.reason);
    });

    outgoingWebSocket.addEventListener('error', (event) => {
      console.error(`[stringcost-ws] Provider WebSocket error:`, event.message);
      incomingWebsocket?.close();
    });

    // Wait for upstream WebSocket to open
    const checkWebSocketOpen = new Promise((resolve, reject) => {
      outgoingWebSocket.addEventListener('open', () => {
        console.log('[stringcost-ws] Connected to provider', {
          sessionId: payload.sid,
          provider: payload.provider,
        });
        resolve(true);
      });
      
      outgoingWebSocket.addEventListener('error', (event) => {
        reject(new Error(`Failed to connect to provider: ${event.message}`));
      });
      
      // Timeout after 10 seconds
      setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, 10000);
    });

    await checkWebSocketOpen;

    return {
      onOpen(evt, ws) {
        incomingWebsocket = ws;
        console.log('[stringcost-ws] Client WebSocket opened', {
          sessionId: payload.sid,
          userId: payload.uid,
        });
      },
      onMessage(event) {
        const data = event.data as string;
        bytesSent += Buffer.byteLength(data, 'utf8');
        outgoingWebSocket?.send(data);
      },
      onError(evt) {
        console.error(`[stringcost-ws] Client WebSocket error:`, evt.type);
        outgoingWebSocket?.close();
      },
      onClose() {
        console.log('[stringcost-ws] Client WebSocket closed', {
          sessionId: payload.sid,
          messageCount,
          bytesReceived,
          bytesSent,
        });
        outgoingWebSocket?.close();
      },
    };
  } catch (err) {
    console.error('[stringcost-ws] WebSocket handler error:', err);
    c.set('websocketError', true);
    return {
      onOpen(evt, ws) {
        ws.close(1008, (err as Error).message);
      },
      onMessage() {},
      onError() {},
      onClose() {},
    };
  }
}
