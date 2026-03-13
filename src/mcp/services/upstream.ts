/**
 * MCP Gateway Upstream Transport
 * Handles connections to upstream MCP servers via SSE or HTTP
 */

import { logger } from '../utils/logger.js';
import { TIMEOUTS, MCP_PROTOCOL, CONTENT_TYPES } from '../constants/index.js';
import type {
  ServerConfig,
  ServerTokens,
  TransportType,
  JSONRPCRequest,
  JSONRPCResponse,
  EventHandler,
} from '../types/index.js';

const log = logger.child('upstream');

interface UpstreamConfig {
  serverConfig: ServerConfig;
  tokens?: ServerTokens;
  onMessage?: (message: JSONRPCResponse) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
  /** Callback to refresh tokens when expired */
  onTokenRefresh?: (serverUrl: string) => Promise<ServerTokens | undefined>;
}

/** Buffer time before token expiry to trigger refresh (5 minutes) */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

type RequestCallback = {
  resolve: (response: JSONRPCResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

/**
 * Upstream connection to an MCP server
 */
export class Upstream {
  private config: UpstreamConfig;
  private connected: boolean = false;
  private abortController: AbortController | null = null;
  private pendingRequests: Map<string | number, RequestCallback> = new Map();
  private messageHandler?: (message: JSONRPCResponse) => void;
  private requestIdCounter: number = 1;
  private sseMessageUrl: string | null = null; // URL for sending SSE messages (from endpoint event)
  private endpointReady: Promise<void> | null = null; // Promise that resolves when endpoint is received
  private endpointResolve: (() => void) | null = null;

  constructor(config: UpstreamConfig) {
    this.config = config;
    this.messageHandler = config.onMessage;
  }

  /**
   * Get authorization headers based on server auth config
   */
  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const { serverConfig, tokens } = this.config;

    switch (serverConfig.authType) {
      case 'bearer':
        if (serverConfig.authConfig?.token) {
          headers['Authorization'] = `Bearer ${serverConfig.authConfig.token}`;
        }
        break;

      case 'api_key':
        if (serverConfig.authConfig?.api_key) {
          const headerName = (serverConfig.authConfig.header_name as string) || 'X-API-Key';
          headers[headerName] = serverConfig.authConfig.api_key as string;
        }
        break;

      case 'oauth':
        if (tokens?.access_token) {
          const tokenType = tokens.token_type || 'Bearer';
          headers['Authorization'] = `${tokenType} ${tokens.access_token}`;
        }
        break;
    }

    // Add any custom headers from server config
    if (serverConfig.headers) {
      Object.assign(headers, serverConfig.headers);
    }

    return headers;
  }

  /**
   * Check if OAuth token is expired or about to expire
   */
  private isTokenExpiring(): boolean {
    const { tokens } = this.config;
    if (!tokens?.expires_at) {
      return false;
    }

    const expiresAt = new Date(tokens.expires_at).getTime();
    const now = Date.now();

    return expiresAt - now < TOKEN_REFRESH_BUFFER_MS;
  }

  /**
   * Validate RFC 8707 resource indicator
   * Prevents cross-resource token replay attacks
   */
  private validateResourceBinding(): void {
    const { serverConfig, tokens } = this.config;

    if (tokens?.resource && tokens.resource !== serverConfig.url) {
      const error = `Token resource mismatch: token bound to '${tokens.resource}' but used with '${serverConfig.url}'`;
      log.error('RFC 8707 resource validation failed', {
        tokenResource: tokens.resource,
        serverUrl: serverConfig.url,
      });
      throw new Error(error);
    }
  }

  /**
   * Ensure OAuth token is valid before making request
   * Auto-refreshes if token is expiring and refresh callback is provided
   */
  private async ensureValidToken(): Promise<void> {
    const { serverConfig, tokens } = this.config;

    // Only relevant for OAuth auth type
    if (serverConfig.authType !== 'oauth') {
      return;
    }

    // SECURITY: Validate RFC 8707 resource binding
    this.validateResourceBinding();

    // Check if token is expiring
    if (!this.isTokenExpiring()) {
      return;
    }

    // Check if we can refresh
    if (!tokens?.refresh_token || !this.config.onTokenRefresh) {
      log.warn('Token expiring but no refresh mechanism available', {
        hasRefreshToken: !!tokens?.refresh_token,
        hasCallback: !!this.config.onTokenRefresh,
        expiresAt: tokens?.expires_at,
      });
      return;
    }

    log.info('Token expiring, attempting refresh', {
      serverUrl: serverConfig.url,
      expiresAt: tokens.expires_at,
    });

    try {
      const newTokens = await this.config.onTokenRefresh(serverConfig.url);
      if (newTokens) {
        // Update tokens in config
        this.config.tokens = newTokens;
        log.info('Token refreshed successfully', {
          serverUrl: serverConfig.url,
          newExpiresAt: newTokens.expires_at,
        });
      }
    } catch (error) {
      log.error('Token refresh failed', {
        serverUrl: serverConfig.url,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Continue with existing token - it may still work
    }
  }

  /**
   * Connect to the upstream server (for SSE)
   */
  async connect(): Promise<void> {
    if (this.connected) {
      log.warn('Already connected');
      return;
    }

    const { serverConfig } = this.config;
    const preferredTransport = serverConfig.transport?.preferred || 'sse';

    if (preferredTransport !== 'sse') {
      // HTTP transport doesn't maintain persistent connection
      this.connected = true;
      return;
    }

    log.info('Connecting to upstream SSE', { url: serverConfig.url });

    const abortController = new AbortController();
    this.abortController = abortController;

    // Create promise that resolves when endpoint URL is received
    this.endpointReady = new Promise((resolve) => {
      this.endpointResolve = resolve;
      // Set timeout in case server doesn't send endpoint event
      setTimeout(() => {
        if (!this.sseMessageUrl) {
          log.debug('No endpoint event received, using server URL for messages');
          resolve();
        }
      }, 5000);
    });

    try {
      const response = await fetch(serverConfig.url, {
        method: 'GET',
        headers: {
          Accept: CONTENT_TYPES.SSE,
          ...this.getAuthHeaders(),
        },
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('SSE connection has no body');
      }

      this.connected = true;
      log.info('Connected to upstream SSE');

      // Start reading SSE stream
      this.readSSEStream(response.body);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        log.debug('SSE connection aborted');
        return;
      }
      log.error('Failed to connect to upstream', { error });
      throw error;
    }
  }

  /**
   * Read SSE stream and dispatch messages
   */
  private async readSSEStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          log.debug('SSE stream ended');
          this.handleClose();
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete events
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = 'message'; // Default SSE event type
        let eventData = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            eventData += line.slice(6);
          } else if (line === '' && eventData) {
            // End of event - dispatch based on event type
            this.handleSSEEvent(eventType, eventData);
            eventType = 'message';
            eventData = '';
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      log.error('Error reading SSE stream', { error });
      this.handleError(error as Error);
    }
  }

  /**
   * Handle SSE event based on event type
   */
  private handleSSEEvent(eventType: string, data: string): void {
    log.debug('Received SSE event', { eventType, data: data.substring(0, 100) });

    switch (eventType) {
      case 'endpoint':
        // MCP SDK SSE transport sends endpoint event with message URL
        this.handleEndpointEvent(data);
        break;
      case 'message':
      default:
        // Regular JSON-RPC message
        this.handleSSEMessage(data);
        break;
    }
  }

  /**
   * Handle endpoint event (MCP SDK SSE transport)
   */
  private handleEndpointEvent(data: string): void {
    const { serverConfig } = this.config;
    const baseUrl = new URL(serverConfig.url);

    // The endpoint data is a relative or absolute path
    let messageUrl: string;
    if (data.startsWith('http://') || data.startsWith('https://')) {
      messageUrl = data;
    } else if (data.startsWith('/')) {
      // Relative path from server root
      messageUrl = `${baseUrl.origin}${data}`;
    } else {
      // Relative path from current URL
      const basePath = baseUrl.pathname.replace(/\/[^/]*$/, '/');
      messageUrl = `${baseUrl.origin}${basePath}${data}`;
    }

    this.sseMessageUrl = messageUrl;
    log.info('SSE endpoint received', { messageUrl });

    // Resolve the endpoint ready promise
    if (this.endpointResolve) {
      this.endpointResolve();
      this.endpointResolve = null;
    }
  }

  /**
   * Handle incoming SSE message
   */
  private handleSSEMessage(data: string): void {
    try {
      const message = JSON.parse(data) as JSONRPCResponse;
      log.debug('Received SSE message', { id: message.id });

      // Check if this is a response to a pending request
      if (message.id !== undefined) {
        const pending = this.pendingRequests.get(message.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(message.id);

          if (message.error) {
            pending.reject(new Error(message.error.message));
          } else {
            pending.resolve(message);
          }
          return;
        }
      }

      // Otherwise, pass to message handler
      if (this.messageHandler) {
        this.messageHandler(message);
      }
    } catch (error) {
      log.error('Failed to parse SSE message', { data, error });
    }
  }

  /**
   * Handle connection close
   */
  private handleClose(): void {
    this.connected = false;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();

    if (this.config.onClose) {
      this.config.onClose();
    }
  }

  /**
   * Handle error
   */
  private handleError(error: Error): void {
    if (this.config.onError) {
      this.config.onError(error);
    }
    this.handleClose();
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  async send(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    const { serverConfig } = this.config;

    // SECURITY: Ensure OAuth token is valid (auto-refresh if needed)
    await this.ensureValidToken();

    // Assign ID if not present
    const requestWithId: JSONRPCRequest = {
      ...request,
      id: request.id ?? this.requestIdCounter++,
    };

    log.debug('Sending request to upstream', {
      method: requestWithId.method,
      id: requestWithId.id,
    });

    const preferredTransport = serverConfig.transport?.preferred || 'sse';
    if (preferredTransport === 'sse') {
      return this.sendSSE(requestWithId);
    } else {
      return this.sendHTTP(requestWithId);
    }
  }

  /**
   * Send request via SSE POST endpoint
   */
  private async sendSSE(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    const { serverConfig } = this.config;

    // Wait for endpoint URL to be received (with timeout)
    if (this.endpointReady) {
      await this.endpointReady;
    }

    // Determine URL for sending messages
    // Use sseMessageUrl if available (from endpoint event), otherwise fall back to server URL
    const messageUrl = this.sseMessageUrl || serverConfig.url;

    log.debug('Sending SSE request', { url: messageUrl, method: request.method });

    // Create pending request promise
    const responsePromise = new Promise<JSONRPCResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id!);
        reject(new Error(`Request timeout: ${request.method}`));
      }, TIMEOUTS.REQUEST_TIMEOUT);

      this.pendingRequests.set(request.id!, { resolve, reject, timeout });
    });

    // Send the request via HTTP POST to the message endpoint
    try {
      const response = await fetch(messageUrl, {
        method: 'POST',
        headers: {
          'Content-Type': CONTENT_TYPES.JSON,
          ...this.getAuthHeaders(),
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // For SSE, we wait for the response via the stream
      return responsePromise;
    } catch (error) {
      // Clean up pending request on error
      const pending = this.pendingRequests.get(request.id!);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(request.id!);
      }
      throw error;
    }
  }

  /**
   * Send request via HTTP
   */
  private async sendHTTP(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    const { serverConfig } = this.config;

    const response = await fetch(serverConfig.url, {
      method: 'POST',
      headers: {
        'Content-Type': CONTENT_TYPES.JSON,
        ...this.getAuthHeaders(),
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json() as JSONRPCResponse;
    return result;
  }

  /**
   * Send notification (no response expected)
   */
  async notify(notification: JSONRPCRequest): Promise<void> {
    const { serverConfig } = this.config;

    await fetch(serverConfig.url, {
      method: 'POST',
      headers: {
        'Content-Type': CONTENT_TYPES.JSON,
        ...this.getAuthHeaders(),
      },
      body: JSON.stringify({
        ...notification,
        id: undefined, // Notifications don't have IDs
      }),
    });
  }

  /**
   * Close the upstream connection
   */
  close(): void {
    log.debug('Closing upstream connection');

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    this.handleClose();
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get server config
   */
  getServerConfig(): ServerConfig {
    return this.config.serverConfig;
  }
}

/**
 * Create an upstream connection
 */
export function createUpstream(config: UpstreamConfig): Upstream {
  return new Upstream(config);
}
