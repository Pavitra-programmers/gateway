/**
 * MCP Gateway Downstream Transport
 * Handles client-facing SSE and HTTP transports
 */

import { logger } from '../utils/logger.js';
import { TIMEOUTS, SSE_EVENTS, CONTENT_TYPES, MCP_HEADERS } from '../constants/index.js';
import type {
  TransportType,
  JSONRPCResponse,
  JSONRPCRequest,
  JSONRPCNotification,
} from '../types/index.js';

const log = logger.child('downstream');

interface SSEWriter {
  write: (chunk: string) => void;
  close: () => void;
}

/**
 * SSE Server Transport
 * Manages Server-Sent Events connection to client
 */
export class SSEServerTransport {
  private writer: SSEWriter | null = null;
  private keepaliveInterval: NodeJS.Timeout | null = null;
  private closed: boolean = false;
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Create SSE response for Hono
   */
  createResponse(): Response {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start: (ctrl) => {
        controller = ctrl;

        this.writer = {
          write: (chunk: string) => {
            if (!this.closed) {
              controller.enqueue(encoder.encode(chunk));
            }
          },
          close: () => {
            if (!this.closed) {
              this.closed = true;
              controller.close();
            }
          },
        };

        // Start keepalive
        this.startKeepalive();

        // Send initial endpoint event with session ID
        this.sendEvent(SSE_EVENTS.ENDPOINT, JSON.stringify({
          sessionId: this.sessionId,
        }));
      },
      cancel: () => {
        log.debug('SSE stream cancelled by client', { sessionId: this.sessionId });
        this.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': CONTENT_TYPES.SSE,
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        [MCP_HEADERS.SESSION_ID]: this.sessionId,
      },
    });
  }

  /**
   * Send an SSE event
   */
  private sendEvent(event: string, data: string): void {
    if (this.writer && !this.closed) {
      this.writer.write(`event: ${event}\n`);
      this.writer.write(`data: ${data}\n\n`);
    }
  }

  /**
   * Send a JSON-RPC message to client
   */
  sendMessage(message: JSONRPCResponse | JSONRPCNotification): void {
    if (!this.writer || this.closed) {
      log.warn('Cannot send message, SSE not connected', { sessionId: this.sessionId });
      return;
    }

    const data = JSON.stringify(message);
    this.sendEvent(SSE_EVENTS.MESSAGE, data);
    log.debug('Sent SSE message', { sessionId: this.sessionId, id: (message as any).id });
  }

  /**
   * Send result for a request
   */
  sendResult(requestId: string | number | undefined, result: unknown): void {
    const response: JSONRPCResponse = {
      jsonrpc: '2.0',
      id: requestId,
      result,
    };
    this.sendMessage(response);
  }

  /**
   * Send error for a request
   */
  sendError(
    requestId: string | number | undefined,
    code: number,
    message: string,
    data?: unknown
  ): void {
    const response: JSONRPCResponse = {
      jsonrpc: '2.0',
      id: requestId,
      error: { code, message, data },
    };
    this.sendMessage(response);
  }

  /**
   * Start keepalive ping
   */
  private startKeepalive(): void {
    this.keepaliveInterval = setInterval(() => {
      if (this.writer && !this.closed) {
        this.sendEvent(SSE_EVENTS.PING, Date.now().toString());
      }
    }, TIMEOUTS.SSE_KEEPALIVE);
  }

  /**
   * Close the SSE connection
   */
  close(): void {
    if (this.closed) return;

    log.debug('Closing SSE transport', { sessionId: this.sessionId });
    this.closed = true;

    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }

    if (this.writer) {
      this.writer.close();
      this.writer = null;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return !this.closed && this.writer !== null;
  }

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }
}

/**
 * HTTP Server Transport
 * Handles stateless HTTP request/response for Streamable HTTP transport
 */
export class HTTPServerTransport {
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Create JSON response
   */
  createResponse(result: JSONRPCResponse | JSONRPCResponse[]): Response {
    return new Response(JSON.stringify(result), {
      headers: {
        'Content-Type': CONTENT_TYPES.JSON,
        [MCP_HEADERS.SESSION_ID]: this.sessionId,
      },
    });
  }

  /**
   * Create result response
   */
  createResultResponse(
    requestId: string | number | undefined,
    result: unknown
  ): Response {
    const response: JSONRPCResponse = {
      jsonrpc: '2.0',
      id: requestId,
      result,
    };
    return this.createResponse(response);
  }

  /**
   * Create error response
   */
  createErrorResponse(
    requestId: string | number | undefined,
    code: number,
    message: string,
    data?: unknown
  ): Response {
    const response: JSONRPCResponse = {
      jsonrpc: '2.0',
      id: requestId,
      error: { code, message, data },
    };
    return new Response(JSON.stringify(response), {
      status: this.getStatusForErrorCode(code),
      headers: {
        'Content-Type': CONTENT_TYPES.JSON,
        [MCP_HEADERS.SESSION_ID]: this.sessionId,
      },
    });
  }

  /**
   * Map JSON-RPC error code to HTTP status
   */
  private getStatusForErrorCode(code: number): number {
    switch (code) {
      case -32700: // Parse error
        return 400;
      case -32600: // Invalid request
        return 400;
      case -32601: // Method not found
        return 404;
      case -32602: // Invalid params
        return 400;
      case -32603: // Internal error
        return 500;
      default:
        return code >= -32099 && code <= -32000 ? 400 : 500;
    }
  }

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }
}

/**
 * Downstream transport factory
 */
export class Downstream {
  private sessionId: string;
  private sseTransport: SSEServerTransport | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Create SSE transport
   */
  createSSETransport(): SSEServerTransport {
    if (this.sseTransport) {
      this.sseTransport.close();
    }
    this.sseTransport = new SSEServerTransport(this.sessionId);
    return this.sseTransport;
  }

  /**
   * Create HTTP transport for a request
   */
  createHTTPTransport(): HTTPServerTransport {
    return new HTTPServerTransport(this.sessionId);
  }

  /**
   * Get active SSE transport
   */
  getSSETransport(): SSEServerTransport | null {
    return this.sseTransport;
  }

  /**
   * Send message via active SSE transport
   */
  sendMessage(message: JSONRPCResponse | JSONRPCNotification): boolean {
    if (this.sseTransport && this.sseTransport.isConnected()) {
      this.sseTransport.sendMessage(message);
      return true;
    }
    return false;
  }

  /**
   * Close all transports
   */
  close(): void {
    if (this.sseTransport) {
      this.sseTransport.close();
      this.sseTransport = null;
    }
  }

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }
}

/**
 * Create a downstream handler
 */
export function createDownstream(sessionId: string): Downstream {
  return new Downstream(sessionId);
}
