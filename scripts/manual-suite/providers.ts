import type { ModelProvider, ModelRequest, ModelResponse } from '../../src/provider/types.js';

export class StaticPatchProvider implements ModelProvider {
  public readonly id = 'stub';
  public readonly capabilities = {
    streaming: false,
    toolCalling: false,
    responseChunks: false,
    reasoningTokens: false,
    separateSystemPrompt: true,
  } as const;

  public constructor(private readonly patchFactory: (request: ModelRequest) => Promise<string> | string) {}

  public async invoke(request: ModelRequest): Promise<ModelResponse> {
    return {
      content: await this.patchFactory(request),
    };
  }
}

export class StaticAnalysisProvider implements ModelProvider {
  public readonly id = 'stub';
  public readonly capabilities = {
    streaming: false,
    toolCalling: false,
    responseChunks: false,
    reasoningTokens: false,
    separateSystemPrompt: true,
  } as const;

  public async invoke(_request: ModelRequest): Promise<ModelResponse> {
    return {
      content: JSON.stringify({
        shouldEditVerifier: true,
        summary: 'Manual verifier command is stale.',
        reason: 'The provided command exits immediately and does not validate project state.',
        confidence: 'high',
        suggestedVerifierChanges: ['Use the markdown-defined npm test step instead of the manual failing command.'],
        suggestedCodeChanges: [],
      }),
    };
  }
}

export class InspectingProvider implements ModelProvider {
  public readonly id = 'stub';
  public readonly capabilities = {
    streaming: false,
    toolCalling: false,
    responseChunks: false,
    reasoningTokens: false,
    separateSystemPrompt: true,
  } as const;

  public constructor(private readonly inspect: (request: ModelRequest) => void) {}

  public async invoke(request: ModelRequest): Promise<ModelResponse> {
    this.inspect(request);
    return {
      content: JSON.stringify({
        type: 'final',
        message: 'inspected context request',
      }),
    };
  }
}

export class SequenceProvider implements ModelProvider {
  public readonly id = 'stub';
  public readonly capabilities = {
    streaming: false,
    toolCalling: false,
    responseChunks: false,
    reasoningTokens: false,
    separateSystemPrompt: true,
  } as const;

  private index = 0;

  public constructor(
    private readonly responses: Array<string | ((request: ModelRequest, index: number) => string | Promise<string>)>,
    private readonly inspect?: (request: ModelRequest, index: number) => void,
  ) {}

  public async invoke(request: ModelRequest): Promise<ModelResponse> {
    const currentIndex = this.index;
    const response = this.responses[currentIndex];
    if (!response) {
      throw new Error(`Unexpected planner/model request index ${currentIndex}`);
    }

    this.inspect?.(request, currentIndex);
    this.index += 1;
    return {
      content: typeof response === 'string' ? response : await response(request, currentIndex),
    };
  }
}

export class FlakyProvider implements ModelProvider {
  public readonly id = 'stub';
  public readonly capabilities = {
    streaming: false,
    toolCalling: false,
    responseChunks: false,
    reasoningTokens: false,
    separateSystemPrompt: true,
  } as const;

  private attempts = 0;

  public constructor(
    private readonly failuresBeforeSuccess: number,
    private readonly successFactory: (request: ModelRequest, attempt: number) => Promise<string> | string,
  ) {}

  public async invoke(request: ModelRequest): Promise<ModelResponse> {
    this.attempts += 1;
    if (this.attempts <= this.failuresBeforeSuccess) {
      throw new Error('Provider request failed with status 429: {"error":{"message":"Upstream rate limit exceeded, please retry later"}}');
    }

    return {
      content: await this.successFactory(request, this.attempts),
    };
  }
}

export class BranchingProvider implements ModelProvider {
  public readonly id = 'stub';
  public readonly capabilities = {
    streaming: false,
    toolCalling: false,
    responseChunks: false,
    reasoningTokens: false,
    separateSystemPrompt: true,
  } as const;

  public constructor(
    private readonly handler: (request: ModelRequest) => Promise<string> | string,
  ) {}

  public async invoke(request: ModelRequest): Promise<ModelResponse> {
    return {
      content: await this.handler(request),
    };
  }
}
