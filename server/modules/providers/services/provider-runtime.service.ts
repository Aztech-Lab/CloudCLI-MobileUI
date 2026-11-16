import { errorMessage } from '@/shared/utils.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  BackgroundTaskSummary,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRunFunction,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  SideQuestionOutcome,
  SideQuestionRequest,
  SideQuestionSink,
} from '@/shared/types.js';

type ProviderRuntimeServiceDependencies = {
  listProviders(): IProvider[];
  resolveProvider(provider: string): IProvider;
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels: typeof providerModelsService.getProviderModels;
  /**
   * Builds the SDK query for a side-question run. Production leaves this
   * unset so the runtime uses the SDK's own; tests supply a scripted stream.
   */
  createQuery?: ProviderRuntimeContext['createQuery'];
};

const defaultDependencies: ProviderRuntimeServiceDependencies = {
  listProviders: () => providerRegistry.listProviders(),
  resolveProvider: (provider) => providerRegistry.resolveProvider(provider),
  resolveProviderSessionId: (sessionId) => sessionsService.resolveProviderSessionId(sessionId),
  resolveResumeModel: (provider, sessionId, requestedModel) =>
    providerModelsService.resolveResumeModel(provider, sessionId, requestedModel),
  getProviderModels: (provider) => providerModelsService.getProviderModels(provider),
};

/**
 * Creates the application-facing provider runtime dispatcher.
 *
 * The provider registry owns each concrete runtime. This service supplies the
 * registry-backed model/session lookups at execution time so runtime adapters
 * never import services that resolve back through the registry.
 */
export function createProviderRuntimeService(
  dependencyOverrides: Partial<ProviderRuntimeServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  const createRuntimeContext = (
    provider: IProvider,
  ): ProviderRuntimeContext => ({
    resolveProviderSessionId: dependencies.resolveProviderSessionId,
    resolveResumeModel: (sessionId, requestedModel) =>
      dependencies.resolveResumeModel(provider.id, sessionId, requestedModel),
    getProviderModels: async () => dependencies.getProviderModels(provider.id),
    normalizeMessage: (raw, sessionId) => provider.sessions.normalizeMessage(raw, sessionId),
    async isProviderInstalled() {
      try {
        return (await provider.auth.getStatus()).installed;
      } catch {
        // Preserve the runtime's original error when installation probing fails.
        return true;
      }
    },
  });

  const run = (
    providerName: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown> => {
    const provider = dependencies.resolveProvider(providerName);
    return provider.runtime.run(command, options, writer, createRuntimeContext(provider));
  };

  return {
    run,

    hasRuntime(providerName: string): boolean {
      try {
        return Boolean(dependencies.resolveProvider(providerName).runtime);
      } catch {
        return false;
      }
    },

    getRunner(provider: LLMProvider): ProviderRunFunction {
      return (command, options, writer) => run(provider, command, options, writer);
    },

    async abort(providerName: LLMProvider, sessionId: string): Promise<boolean> {
      return Boolean(await dependencies.resolveProvider(providerName).runtime.abort(sessionId));
    },

    async stopBackgroundTask(providerName: LLMProvider, sessionId: string, taskId: string): Promise<boolean> {
      // A runtime that never holds background work has no task to stop.
      const { runtime } = dependencies.resolveProvider(providerName);
      return Boolean(await runtime.stopBackgroundTask?.(sessionId, taskId));
    },

    // [local] "Stop all background work".
    async stopAllBackgroundWork(providerName: LLMProvider, sessionId: string): Promise<boolean> {
      const { runtime } = dependencies.resolveProvider(providerName);
      return Boolean(await runtime.stopAllBackgroundWork?.(sessionId));
    },

    async steer(providerName: LLMProvider, sessionId: string, command: string, options: AnyRecord): Promise<boolean> {
      // A runtime that cannot write into a running turn has nothing to steer.
      const { runtime } = dependencies.resolveProvider(providerName);
      return Boolean(await runtime.steer?.(sessionId, command, options));
    },

    // [local] Withdraw an unread steered message.
    async cancelSteer(providerName: LLMProvider, sessionId: string, messageId: string): Promise<boolean> {
      const { runtime } = dependencies.resolveProvider(providerName);
      return Boolean(await runtime.cancelSteer?.(sessionId, messageId));
    },

    // [local] "Move to background" for a running foreground tool call.
    async backgroundTask(providerName: LLMProvider, sessionId: string, toolUseId?: string): Promise<boolean> {
      const { runtime } = dependencies.resolveProvider(providerName);
      return Boolean(await runtime.backgroundTask?.(sessionId, toolUseId));
    },

    hasBackgroundWork(sessionId: string): boolean {
      return dependencies.listProviders().some((provider) =>
        (provider.runtime.listBackgroundWork?.() ?? []).some((entry) => entry.sessionId === sessionId));
    },

    // [local] Every session's outstanding background work, across providers:
    // the subscribe ack, the restart ledger and the health summary read it.
    listBackgroundWork(): Array<{ sessionId: string; tasks: BackgroundTaskSummary[] }> {
      return dependencies.listProviders().flatMap((provider) => provider.runtime.listBackgroundWork?.() ?? []);
    },

    // [local] One session's outstanding background tasks.
    listBackgroundTasks(sessionId: string): BackgroundTaskSummary[] {
      return dependencies.listProviders().flatMap((provider) =>
        (provider.runtime.listBackgroundWork?.() ?? [])
          .filter((entry) => entry.sessionId === sessionId)
          .flatMap((entry) => entry.tasks));
    },

    resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void {
      for (const provider of dependencies.listProviders()) {
        provider.runtime.permissions?.resolve(requestId, decision);
      }
    },

    getPendingApprovalsForSession(sessionId: string): unknown[] {
      return dependencies.listProviders().flatMap(
        (provider) => provider.runtime.permissions?.listPending(sessionId) ?? [],
      );
    },

    async askSideQuestion(
      providerName: LLMProvider,
      request: SideQuestionRequest,
      sink: SideQuestionSink,
    ): Promise<SideQuestionOutcome> {
      try {
        const provider = dependencies.resolveProvider(providerName);
        const context: ProviderRuntimeContext = {
          ...createRuntimeContext(provider),
          createQuery: dependencies.createQuery,
        };

        if (provider.runtime.askSideQuestion) {
          return await provider.runtime.askSideQuestion(request, sink, context);
        }

        // No runtime support: name it and stop, instead of guessing at an answer.
        return { status: 'error', error: `Provider "${providerName}" has no side questions.`, answer: '' };
      } catch (error) {
        return { status: 'error', error: errorMessage(error), answer: '' };
      }
    },
  };
}

export const providerRuntimeService = createProviderRuntimeService();
