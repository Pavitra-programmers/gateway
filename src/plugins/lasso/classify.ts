import { Message } from '../../types/requestBody';
import {
  HookEventType,
  PluginContext,
  PluginHandler,
  PluginParameters,
} from '../types';
import { post } from '../utils';

export const LASSO_BASE_URL = 'https://server.lasso.security';

interface LassoMessage {
  role: string;
  content: string;
}

interface LassoFinding {
  name: string;
  category: string;
  action: 'BLOCK' | 'AUTO_MASKING' | 'WARN';
  severity: string;
  score?: number;
}

enum LassoMessageType {
  PROMPT = 'PROMPT',
  COMPLETION = 'COMPLETION',
}

interface LassoV3ClassifyRequest {
  messages: LassoMessage[];
  messageType: LassoMessageType;
  sessionId?: string;
  userId?: string;
}

interface LassoV3ClassifyResponse {
  deputies: Record<string, boolean>;
  violations_detected: boolean;
  findings: Record<string, LassoFinding[]>;
}

function hasBlockAction(findings: Record<string, LassoFinding[]>): boolean {
  return Object.values(findings).some((deputyFindings) =>
    deputyFindings.some((finding) => finding.action === 'BLOCK')
  );
}

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export function isValidULID(value: string): boolean {
  return ULID_REGEX.test(value);
}

export function generateULID(): string {
  const now = Date.now();

  // Encode timestamp (48 bits → 10 base32 chars)
  let timestamp = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    timestamp = CROCKFORD_BASE32[t % 32] + timestamp;
    t = Math.floor(t / 32);
  }

  // Encode random (80 bits → 16 base32 chars)
  const randomBytes = new Uint8Array(10);
  crypto.getRandomValues(randomBytes);

  let random = '';
  let bits = 0;
  let numBits = 0;
  let byteIdx = 0;
  for (let i = 0; i < 16; i++) {
    while (numBits < 5) {
      bits = (bits << 8) | randomBytes[byteIdx++];
      numBits += 8;
    }
    numBits -= 5;
    random += CROCKFORD_BASE32[(bits >> numBits) & 31];
    bits &= (1 << numBits) - 1;
  }

  return timestamp + random;
}

export const classify = async (
  credentials: Record<string, any>,
  data: LassoV3ClassifyRequest,
  timeout?: number
) => {
  const options: {
    headers: Record<string, string>;
  } = {
    headers: {
      'lasso-api-key': `${credentials.apiKey}`,
    },
  };

  const baseURL = credentials.apiEndpoint || LASSO_BASE_URL;
  const url = `${baseURL}/gateway/v3/classify`;

  return post<LassoV3ClassifyResponse>(url, data, options, timeout);
};

export const handler: PluginHandler = async (
  context: PluginContext,
  parameters: PluginParameters,
  eventType: HookEventType,
  options
) => {
  let error = null;
  let verdict = true; // Default to allowing the request
  let data = null;

  try {
    // Derive messageType from eventType
    const messageType =
      eventType === 'beforeRequestHook'
        ? LassoMessageType.PROMPT
        : LassoMessageType.COMPLETION;

    let messages: LassoMessage[];

    if (eventType === 'afterRequestHook') {
      // Extract assistant response from LLM output
      const responseJson = context.response?.json;
      const assistantContent =
        responseJson?.choices?.[0]?.message?.content || '';
      messages = [{ role: 'assistant', content: assistantContent }];
    } else {
      // Extract messages from the request
      messages = (context.request?.json?.messages || []).map(
        (message: Message) => {
          if (typeof message.content === 'string') {
            return message;
          }
          const textContent = message.content?.reduce(
            (value: string, item: any) =>
              value + (item.type === 'text' ? item.text || '' : ''),
            ''
          );
          return { ...message, content: textContent };
        }
      );
    }

    // Prepare the v3 request payload
    const payload: LassoV3ClassifyRequest = {
      messages,
      messageType,
    };

    // Map conversationId to sessionId (must be a valid ULID for v3 API)
    const conversationId = parameters.conversationId as string | undefined;
    if (conversationId) {
      if (isValidULID(conversationId)) {
        payload.sessionId = conversationId;
      } else {
        const cacheKey = `lasso:sessionId:${conversationId}`;
        let sessionId = await options?.getFromCacheByKey?.(cacheKey);
        if (!sessionId) {
          sessionId = generateULID();
          await options?.putInCacheWithValue?.(cacheKey, sessionId);
        }
        payload.sessionId = sessionId;
      }
    }

    // Map userId to request body
    const userId = parameters.userId as string | undefined;
    if (userId) {
      payload.userId = userId;
    }

    // Call the Lasso Security Deputies API v3
    const result = await classify(
      parameters.credentials || {},
      payload,
      parameters.timeout
    );

    // Block only when violations are detected AND at least one finding has BLOCK action
    // WARN and AUTO_MASKING violations pass through with data
    if (result.violations_detected && hasBlockAction(result.findings)) {
      verdict = false;
    }

    data = result;
  } catch (e: any) {
    console.error('Error calling Lasso Security API:', e);
    delete e.stack;
    error = e;
    verdict = false; // Block on error to be safe
  }

  return { error, verdict, data };
};
