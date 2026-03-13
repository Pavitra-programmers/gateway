/**
 * MCP Gateway Tool Invocation Logger
 * Logs tool invocations to the control plane for cost tracking
 */

import { logger } from './logger.js';
import { ENV_VARS } from '../constants/index.js';
import type { ToolInvocationLog } from '../types/index.js';

const log = logger.child('emitLog');

interface ControlPlaneConfig {
  url: string;
  apiKey: string;
}

function getControlPlaneConfig(): ControlPlaneConfig | null {
  const url = process.env[ENV_VARS.CONTROL_PLANE_URL];
  const apiKey = process.env[ENV_VARS.CONTROL_PLANE_API_KEY];

  if (!url || !apiKey) {
    log.debug('Control plane URL or API key not configured, tool logging disabled');
    return null;
  }

  return { url, apiKey };
}

/**
 * Log a tool invocation to the control plane for cost tracking
 * Uses client API key for authorization and server URL for context
 */
export async function logToolInvocation(
  invocation: ToolInvocationLog,
  clientApiKey: string,
  serverUrl: string
): Promise<void> {
  const config = getControlPlaneConfig();
  if (!config) {
    return;
  }

  try {
    const response = await fetch(`${config.url}/v2/mcp-tool-invocations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        'x-portkey-api-key': clientApiKey,
      },
      body: JSON.stringify({
        request_id: invocation.requestId,
        mcp_server_url: serverUrl,
        tool_name: invocation.toolName,
        input_tokens: invocation.inputTokens,
        output_tokens: invocation.outputTokens,
        duration_ms: invocation.durationMs,
        status: invocation.status,
        error_message: invocation.errorMessage,
      }),
    });

    if (!response.ok) {
      log.warn('Failed to log tool invocation', {
        status: response.status,
        statusText: response.statusText,
        toolName: invocation.toolName,
      });
    } else {
      log.debug('Tool invocation logged successfully', {
        toolName: invocation.toolName,
        durationMs: invocation.durationMs,
        status: invocation.status,
      });
    }
  } catch (error) {
    // Non-blocking - don't fail the request if logging fails
    log.warn('Error logging tool invocation', {
      error: error instanceof Error ? error.message : 'Unknown error',
      toolName: invocation.toolName,
    });
  }
}

/**
 * Helper to create a tool invocation logger with timing
 */
export function createToolInvocationTracker(
  apiKey: string,
  serverUrl: string,
  requestId?: string
) {
  const startTimes = new Map<string, number>();

  return {
    start(toolName: string): void {
      startTimes.set(toolName, Date.now());
    },

    async end(
      toolName: string,
      status: 'success' | 'error' | 'timeout',
      errorMessage?: string
    ): Promise<void> {
      const startTime = startTimes.get(toolName);
      const durationMs = startTime ? Date.now() - startTime : undefined;
      startTimes.delete(toolName);

      await logToolInvocation(
        {
          requestId,
          toolName,
          durationMs,
          status,
          errorMessage,
        },
        apiKey,
        serverUrl
      );
    },

    async logDirect(invocation: Omit<ToolInvocationLog, 'requestId'>): Promise<void> {
      await logToolInvocation(
        {
          ...invocation,
          requestId,
        },
        apiKey,
        serverUrl
      );
    },
  };
}

/**
 * Batch log multiple tool invocations (for efficiency)
 */
export async function logToolInvocationsBatch(
  invocations: ToolInvocationLog[],
  apiKey: string,
  serverUrl: string
): Promise<void> {
  // For now, just log individually
  // TODO: Implement batch endpoint in control plane if needed
  await Promise.all(
    invocations.map((inv) => logToolInvocation(inv, apiKey, serverUrl))
  );
}
