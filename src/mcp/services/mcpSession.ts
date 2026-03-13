/**
 * MCP Gateway Session Manager
 * Bridges upstream MCP server and downstream client
 */

import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';
import { getCache } from '../utils/cache.js';
import { createToolInvocationTracker } from '../utils/emitLog.js';
import { TIMEOUTS, MCP_PROTOCOL, JSONRPC_ERROR_CODES, ERROR_MESSAGES } from '../constants/index.js';
import { Upstream, createUpstream } from './upstream.js';
import { Downstream, createDownstream, SSEServerTransport, HTTPServerTransport } from './downstream.js';
import { createToolFilter, filterTools, validateToolCall } from './toolFilter.js';
import { sanitizeTools } from '../utils/sanitizer.js';
import { hashApiKey } from './oauthState.js';
import type {
  SessionState,
  SessionInfo,
  ServerConfig,
  ServerTokens,
  ToolkitConfig,
  TransportType,
  JSONRPCRequest,
  JSONRPCResponse,
  Tool,
  ToolListResponse,
  InitializeResult,
} from '../types/index.js';

const log = logger.child('mcpSession');

interface MCPSessionConfig {
  serverUrl: string;
  apiKey: string;
  serverConfig: ServerConfig;
  tokens?: ServerTokens;
  toolkitConfig?: ToolkitConfig;
  clientTransportType: TransportType;
}

/**
 * MCP Session
 * Manages a single MCP session between client and upstream server
 */
export class MCPSession {
  readonly sessionId: string;
  private config: MCPSessionConfig;
  private apiKeyHash: string;
  private state: SessionState = 'new' as SessionState;
  private upstream: Upstream | null = null;
  private downstream: Downstream;
  private toolFilter: ReturnType<typeof createToolFilter>;
  private invocationTracker: ReturnType<typeof createToolInvocationTracker>;
  private initialized: boolean = false;
  private createdAt: Date;
  private lastActivityAt: Date;

  constructor(config: MCPSessionConfig, sessionId?: string) {
    this.sessionId = sessionId || randomUUID();
    this.config = config;
    this.apiKeyHash = hashApiKey(config.apiKey);
    this.createdAt = new Date();
    this.lastActivityAt = new Date();
    this.toolFilter = createToolFilter(config.toolkitConfig);
    this.downstream = createDownstream(this.sessionId);
    this.invocationTracker = createToolInvocationTracker(
      config.apiKey,
      config.serverUrl
    );

    log.info('Session created', {
      sessionId: this.sessionId,
      serverUrl: config.serverUrl,
      apiKeyHash: this.apiKeyHash,
      hasToolkit: !!config.toolkitConfig,
    });
  }

  /**
   * Initialize or restore session
   */
  async initialize(): Promise<void> {
    if (this.state !== ('new' as SessionState)) {
      log.debug('Session already initialized', { sessionId: this.sessionId });
      return;
    }

    this.state = 'initializing' as SessionState;

    try {
      // Create upstream connection
      this.upstream = createUpstream({
        serverConfig: this.config.serverConfig,
        tokens: this.config.tokens,
        onMessage: (msg) => this.handleUpstreamMessage(msg),
        onError: (err) => this.handleUpstreamError(err),
        onClose: () => this.handleUpstreamClose(),
      });

      // Connect to upstream (for SSE transport)
      const preferredTransport = this.config.serverConfig.transport?.preferred || 'sse';
      if (preferredTransport === 'sse') {
        await this.upstream.connect();
      }

      this.state = 'initialized' as SessionState;
      this.updateActivity();

      log.info('Session initialized', { sessionId: this.sessionId });
    } catch (error) {
      this.state = 'closed' as SessionState;
      log.error('Failed to initialize session', { sessionId: this.sessionId, error });
      throw error;
    }
  }

  /**
   * Create SSE response for client
   */
  createSSEResponse(): Response {
    const sseTransport = this.downstream.createSSETransport();
    return sseTransport.createResponse();
  }

  /**
   * Handle client request
   */
  async handleClientRequest(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    this.updateActivity();

    const { method, id, params } = request;
    log.debug('Handling client request', { sessionId: this.sessionId, method, id });

    try {
      // Handle gateway-level methods
      if (method === MCP_PROTOCOL.METHODS.INITIALIZE) {
        return await this.handleInitialize(request);
      }

      if (method === MCP_PROTOCOL.METHODS.TOOLS_LIST) {
        return await this.handleToolsList(request);
      }

      if (method === MCP_PROTOCOL.METHODS.TOOLS_CALL) {
        return await this.handleToolsCall(request);
      }

      // Forward other methods to upstream
      return await this.forwardToUpstream(request);
    } catch (error) {
      log.error('Error handling request', { sessionId: this.sessionId, method, error });
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: JSONRPC_ERROR_CODES.INTERNAL_ERROR,
          message: error instanceof Error ? error.message : 'Internal error',
        },
      };
    }
  }

  /**
   * Handle initialize request
   */
  private async handleInitialize(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    // Forward to upstream
    const response = await this.forwardToUpstream(request);

    // Add gateway info to response
    if (response.result) {
      const result = response.result as InitializeResult;
      result.serverInfo = {
        name: `StringCost MCP Gateway -> ${this.config.serverConfig.serverLabel}`,
        version: '1.0.0',
      };

      if (this.toolFilter.isEnabled()) {
        result.instructions = `${result.instructions || ''}\n\nNote: This session uses tool filtering. Some tools may not be available.`.trim();
      }
    }

    this.initialized = true;
    return response;
  }

  /**
   * Handle tools/list request with sanitization and filtering
   */
  private async handleToolsList(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    // Get tools from upstream
    const response = await this.forwardToUpstream(request);

    if (response.result) {
      const toolsResponse = response.result as ToolListResponse;
      const originalCount = toolsResponse.tools.length;

      // SECURITY: Sanitize tool metadata to prevent Tool Poisoning Attacks (TPA)
      // This removes potential prompt injection patterns from tool descriptions
      toolsResponse.tools = sanitizeTools(toolsResponse.tools);

      // Apply filtering if toolkit is configured
      if (this.toolFilter.isEnabled()) {
        toolsResponse.tools = this.toolFilter.filter(toolsResponse.tools);
      }

      log.debug('Tools processed', {
        sessionId: this.sessionId,
        original: originalCount,
        afterSanitization: toolsResponse.tools.length,
        afterFiltering: toolsResponse.tools.length,
      });
    }

    return response;
  }

  /**
   * Handle tools/call request with validation and parameter checking
   */
  private async handleToolsCall(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    const params = request.params as Record<string, unknown> | undefined;
    const toolName = params?.name as string | undefined;
    const toolArguments = params?.arguments as Record<string, unknown> | undefined;

    if (!toolName) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: JSONRPC_ERROR_CODES.INVALID_PARAMS,
          message: 'Tool name is required',
        },
      };
    }

    // Validate tool is allowed by glob patterns
    if (!this.toolFilter.validate(toolName)) {
      log.warn('Tool call blocked by pattern', { sessionId: this.sessionId, toolName });
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: JSONRPC_ERROR_CODES.INVALID_PARAMS,
          message: ERROR_MESSAGES.TOOL_NOT_ALLOWED,
        },
      };
    }

    // SECURITY: Validate tool parameters against fine-grained permission rules
    const paramValidation = this.toolFilter.validateParams(toolName, toolArguments);
    if (!paramValidation.valid) {
      log.warn('Tool call blocked by parameter validation', {
        sessionId: this.sessionId,
        toolName,
        error: paramValidation.error,
        paramName: paramValidation.paramName,
      });
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: JSONRPC_ERROR_CODES.INVALID_PARAMS,
          message: paramValidation.error || 'Parameter validation failed',
        },
      };
    }

    // Track invocation
    this.invocationTracker.start(toolName);

    try {
      const response = await this.forwardToUpstream(request);

      // Log successful invocation
      const status = response.error ? 'error' : 'success';
      await this.invocationTracker.end(toolName, status, response.error?.message);

      return response;
    } catch (error) {
      // Log failed invocation
      await this.invocationTracker.end(
        toolName,
        'error',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  /**
   * Forward request to upstream
   */
  private async forwardToUpstream(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    if (!this.upstream) {
      throw new Error('Upstream not connected');
    }

    return this.upstream.send(request);
  }

  /**
   * Handle message from upstream
   */
  private handleUpstreamMessage(message: JSONRPCResponse): void {
    log.debug('Upstream message', { sessionId: this.sessionId, id: message.id });
    this.downstream.sendMessage(message);
    this.updateActivity();
  }

  /**
   * Handle upstream error
   */
  private handleUpstreamError(error: Error): void {
    log.error('Upstream error', { sessionId: this.sessionId, error: error.message });
    // TODO: Notify client of error
  }

  /**
   * Handle upstream close
   */
  private handleUpstreamClose(): void {
    log.info('Upstream closed', { sessionId: this.sessionId });
    this.state = 'dormant' as SessionState;
  }

  /**
   * Update last activity timestamp
   */
  private updateActivity(): void {
    this.lastActivityAt = new Date();
  }

  /**
   * Get session info
   */
  getInfo(): SessionInfo {
    return {
      sessionId: this.sessionId,
      serverUrl: this.config.serverUrl,
      apiKeyHash: this.apiKeyHash,
      state: this.state,
      clientTransportType: this.config.clientTransportType,
      upstreamTransportType: this.config.serverConfig.transport?.preferred || 'sse',
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      toolkitConfig: this.config.toolkitConfig,
    };
  }

  /**
   * Get session state
   */
  getState(): SessionState {
    return this.state;
  }

  /**
   * Check if session is expired
   */
  isExpired(): boolean {
    const elapsed = Date.now() - this.lastActivityAt.getTime();
    return elapsed > TIMEOUTS.SESSION_TTL;
  }

  /**
   * Close session
   */
  close(): void {
    log.info('Closing session', { sessionId: this.sessionId });

    this.state = 'closed' as SessionState;

    if (this.upstream) {
      this.upstream.close();
      this.upstream = null;
    }

    this.downstream.close();
  }
}

/**
 * Session Manager
 * Manages multiple MCP sessions with caching
 */
class SessionManager {
  private sessions: Map<string, MCPSession> = new Map();
  private cache = getCache();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, TIMEOUTS.SESSION_TTL / 2);
  }

  /**
   * Create a new session
   */
  async createSession(config: MCPSessionConfig): Promise<MCPSession> {
    const session = new MCPSession(config);
    this.sessions.set(session.sessionId, session);

    // Cache session info
    await this.cache.setSession(session.sessionId, session.getInfo());

    return session;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): MCPSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get or create session
   */
  async getOrCreateSession(
    sessionId: string | undefined,
    config: MCPSessionConfig
  ): Promise<MCPSession> {
    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing && !existing.isExpired()) {
        return existing;
      }
    }

    return this.createSession(config);
  }

  /**
   * Close session
   */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.close();
      this.sessions.delete(sessionId);
      this.cache.deleteSession(sessionId);
    }
  }

  /**
   * Cleanup expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, session] of this.sessions) {
      if (session.isExpired()) {
        session.close();
        this.sessions.delete(sessionId);
        this.cache.deleteSession(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      log.info('Cleaned up expired sessions', { count: cleaned });
    }
  }

  /**
   * Get all sessions
   */
  getAllSessions(): MCPSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get session count
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Close all sessions
   */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// Singleton instance
let sessionManagerInstance: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!sessionManagerInstance) {
    sessionManagerInstance = new SessionManager();
  }
  return sessionManagerInstance;
}

export { SessionManager };
