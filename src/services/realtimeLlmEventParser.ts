import { Context } from 'hono';
import { addBackgroundTask } from '../utils/misc';

export class RealtimeLlmEventParser {
  private sessionState: any;
  private eventLogger: Function | null;

  constructor(eventLogger?: Function) {
    this.sessionState = {
      sessionDetails: null,
      conversation: {
        items: new Map<string, any>(),
      },
      responses: new Map<string, any>(),
    };
    this.eventLogger = eventLogger || null;
  }

  // Main entry point for processing events
  handleEvent(c: Context, event: any, sessionOptions: any): void {
    // Handle Gemini Live API format (different from OpenAI Realtime)
    // Gemini sends: { serverContent: {...}, usageMetadata: {...} }
    // OpenAI sends: { type: 'response.done', response: {...} }
    
    if (event.serverContent || event.usageMetadata) {
      // This is a Gemini Live API response
      this.handleGeminiResponse(c, event, sessionOptions);
      return;
    }
    
    if (event.setupComplete) {
      // Gemini setup complete - log session start
      this.handleGeminiSetup(c, event, sessionOptions);
      return;
    }
    
    // Handle OpenAI Realtime API format
    switch (event.type) {
      case 'session.created':
        this.handleSessionCreated(c, event, sessionOptions);
        break;
      case 'session.updated':
        this.handleSessionUpdated(c, event, sessionOptions);
        break;
      case 'conversation.item.created':
        this.handleConversationItemCreated(c, event);
        break;
      case 'conversation.item.deleted':
        this.handleConversationItemDeleted(c, event);
        break;
      case 'response.done':
        this.handleResponseDone(c, event, sessionOptions);
        break;
      case 'error':
        this.handleError(c, event, sessionOptions);
        break;
      default:
        break;
    }
  }

  // Handle `session.created` event
  private handleSessionCreated(
    c: Context,
    data: any,
    sessionOptions: any
  ): void {
    this.sessionState.sessionDetails = { ...data.session };
    console.log('[RealtimeLlmEventParser] session.created', {
      hasLogger: Boolean(this.eventLogger),
    });
    if (this.eventLogger) {
      addBackgroundTask(
        c,
        this.eventLogger(
          sessionOptions,
          {},
          { ...data.session },
          data.type
        )
      );
    } else {
      console.error('[RealtimeLlmEventParser] eventLogger not configured for session.created');
    }
  }

  // Handle `session.updated` event
  private handleSessionUpdated(
    c: Context,
    data: any,
    sessionOptions: any
  ): void {
    this.sessionState.sessionDetails = { ...data.session };
    console.log('[RealtimeLlmEventParser] session.updated', {
      hasLogger: Boolean(this.eventLogger),
    });
    if (this.eventLogger) {
      addBackgroundTask(
        c,
        this.eventLogger(
          sessionOptions,
          {},
          { ...data.session },
          data.type
        )
      );
    } else {
      console.error('[RealtimeLlmEventParser] eventLogger not configured for session.updated');
    }
  }

  // Conversation-specific handlers
  private handleConversationItemCreated(c: Context, data: any): void {
    const { item } = data;
    this.sessionState.conversation.items.set(item.id, data);
  }

  private handleConversationItemDeleted(c: Context, data: any): void {
    this.sessionState.conversation.items.delete(data.item_id);
  }

  private handleResponseDone(c: Context, data: any, sessionOptions: any): void {
    const { response } = data;
    this.sessionState.responses.set(response.id, response);
    for (const item of response.output) {
      const inProgressItem = this.sessionState.conversation.items.get(item.id);
      this.sessionState.conversation.items.set(item.id, {
        ...inProgressItem,
        item,
      });
    }
    console.log('[RealtimeLlmEventParser] response.done', {
      hasLogger: Boolean(this.eventLogger),
      usage: response.usage,
    });
    if (this.eventLogger) {
      const itemSequence = this.rebuildConversationSequence(
        this.sessionState.conversation.items
      );
      addBackgroundTask(
        c,
        this.eventLogger(
          sessionOptions,
          {
            conversation: {
              items: this.getOrderedConversationItems(itemSequence).slice(
                0,
                -1
              ),
            },
          },
          data,
          data.type
        )
      );
    } else {
      console.error('[RealtimeLlmEventParser] eventLogger not configured for response.done');
    }
  }

  private handleError(c: Context, data: any, sessionOptions: any): void {
    console.log('[RealtimeLlmEventParser] error', {
      hasLogger: Boolean(this.eventLogger),
    });
    if (this.eventLogger) {
      addBackgroundTask(
        c,
        this.eventLogger(sessionOptions, {}, data, data.type)
      );
    } else {
      console.warn('[RealtimeLlmEventParser] eventLogger not configured for error');
    }
  }

  private rebuildConversationSequence(items: Map<string, any>): string[] {
    const orderedItemIds: string[] = [];

    // Find the first item (no previous_item_id)
    let currentId: string | undefined = Array.from(items.values()).find(
      (data) => data.previous_item_id === null
    )?.item?.id;

    // Traverse through the chain using previous_item_id
    while (currentId) {
      orderedItemIds.push(currentId);
      const nextItem = Array.from(items.values()).find(
        (data) => data.previous_item_id === currentId
      );
      currentId = nextItem?.item?.id;
    }

    return orderedItemIds;
  }

  private getOrderedConversationItems(sequence: string[]): any {
    return sequence.map((id) => this.sessionState.conversation.items.get(id)!);
  }

  // Handle Gemini Live API setup complete
  private handleGeminiSetup(c: Context, data: any, sessionOptions: any): void {
    console.log('[RealtimeLlmEventParser] Gemini setup complete', {
      hasLogger: Boolean(this.eventLogger),
    });
    if (this.eventLogger) {
      addBackgroundTask(
        c,
        this.eventLogger(
          sessionOptions,
          {},
          { setupComplete: true },
          'session.created'
        )
      );
    }
  }

  // Handle Gemini Live API response with usage metadata
  private handleGeminiResponse(c: Context, data: any, sessionOptions: any): void {
    console.log('[RealtimeLlmEventParser] Gemini response', {
      hasLogger: Boolean(this.eventLogger),
      hasUsage: Boolean(data.usageMetadata),
      usage: data.usageMetadata,
    });
    
    if (this.eventLogger && data.usageMetadata) {
      // Convert Gemini usage format to standard format
      const response = {
        usage: {
          input_tokens: data.usageMetadata.promptTokenCount || 0,
          output_tokens: data.usageMetadata.responseTokenCount || data.usageMetadata.candidatesTokenCount || 0,
          total_tokens: data.usageMetadata.totalTokenCount || 0,
        },
        model: sessionOptions.providerOptions?.model || 'gemini-2.5-flash-native-audio-preview-12-2025',
      };
      
      addBackgroundTask(
        c,
        this.eventLogger(
          sessionOptions,
          {},
          { response, serverContent: data.serverContent },
          'response.done'
        )
      );
    } else {
      console.error('[RealtimeLlmEventParser] eventLogger not configured or no usage metadata');
    }
  }

}
