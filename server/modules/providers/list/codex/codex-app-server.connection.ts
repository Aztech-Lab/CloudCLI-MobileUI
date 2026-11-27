import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import readline from 'node:readline';

/**
 * [local] One long-lived `codex app-server` child, shared by every Codex
 * conversation of this CloudCLI process (the app-server runtime,
 * `codex-app-server.runtime.ts`).
 *
 * `codex-app-server.client.ts` spawns a fresh child per fork or side
 * question, which is fine for one-off exchanges. A conversation turn is
 * different: a turn that lives in the same process as the next message is
 * what later stages build steering, "stop only the turn" and background work
 * on. This class owns that process: it starts it lazily, performs the
 * `initialize` handshake, matches replies to requests, fans notifications out
 * to listeners, answers server-to-client requests through one handler, and
 * restarts it with a backoff after it dies.
 *
 * It never connects to the Codex desktop app's own app-server daemon: it only
 * ever spawns its own child, of the Codex CLI chats run (the user's own when
 * it is at least as new as the bundled one; see codex-cli.ts). The install is
 * resolved when the child starts, so an update applies from the next restart.
 */

/**
 * [local] What a request handler resolves to when the request needs no answer
 * any more: Codex withdrew it (`serverRequest/resolved`) or its turn is gone.
 */
export const CODEX_APP_SERVER_NO_REPLY = Symbol('codex-app-server-no-reply');

/** JSON-RPC error codes the app-server uses. */
const RPC_METHOD_NOT_FOUND = -32601;

export type CodexAppServerNotificationHandler = (method: string, params: unknown) => void;
export type CodexAppServerExitHandler = (reason: string) => void;
/**
 * Answers a server-to-client request (an approval, a question, …). Resolves
 * the JSON-RPC `result`; a rejection is sent back as a JSON-RPC error.
 * `requestId` is the request's JSON-RPC id, which `serverRequest/resolved`
 * names when Codex withdraws it ([local] stage 3: a person may take a while).
 */
export type CodexAppServerRequestHandler = (method: string, params: unknown, requestId: number | string) => Promise<unknown> | unknown;

export type CodexAppServerConnectionOptions = {
  /**
   * How to start the Codex CLI, without its `app-server` argument: the same
   * install chats, forks and the Shell tab run (see codex-cli.ts).
   */
  resolveCommand: () => { command: string; args: string[]; env: NodeJS.ProcessEnv };
  handleServerRequest: CodexAppServerRequestHandler;
  /** How long `initialize` and each request may take. */
  requestTimeoutMs?: number;
  /** First restart delay after a crash; doubles per consecutive crash. */
  restartBackoffMs?: number;
  /** Ceiling of the restart delay. */
  maxRestartBackoffMs?: number;
};

/**
 * The app-server could not be used at all (spawn failed, the handshake failed
 * or timed out, it exited, or it is inside its restart backoff). The runtime
 * falls back to `codex exec` for the message when nothing was shown yet.
 */
export class CodexAppServerUnavailableError extends Error {
  readonly code = 'CODEX_APP_SERVER_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'CodexAppServerUnavailableError';
  }
}

/** The app-server answered a request with a JSON-RPC error. */
export class CodexAppServerRpcError extends Error {
  readonly code = 'CODEX_APP_SERVER_ERROR';
  constructor(readonly method: string, message: string, readonly rpcCode: number | undefined) {
    super(message);
    this.name = 'CodexAppServerRpcError';
  }
}

/**
 * True when an RPC error means "this app-server does not speak what we sent"
 * rather than "this request failed": an unknown method, an unknown field or
 * variant, or a field gated behind a capability. Seen against Codex 0.169:
 * `Invalid request: unknown variant \`thread/doesNotExist\`, expected one of …`
 * and `thread/start.runtimeWorkspaceRoots requires experimentalApi capability`,
 * both with code -32600.
 */
export function isCodexProtocolMismatchError(error: unknown): boolean {
  if (!(error instanceof CodexAppServerRpcError)) {
    return false;
  }
  if (error.rpcCode === RPC_METHOD_NOT_FOUND) {
    return true;
  }
  return /unknown variant|unknown field|requires experimentalApi capability|method not found/i.test(error.message);
}

type JsonRpcLine = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** A crash after the child ran this long starts the backoff over. */
const STABLE_UPTIME_MS = 60_000;

export class CodexAppServerConnection {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private ready = false;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<CodexAppServerNotificationHandler>();
  private readonly exitListeners = new Set<CodexAppServerExitHandler>();
  private stderrTail = '';
  private startedAt = 0;
  private consecutiveFailures = 0;
  private nextStartAllowedAt = 0;
  private lastFailure: string | null = null;
  /** Bumped per spawned child so a late event from an old child is ignored. */
  private generation = 0;

  constructor(private readonly options: CodexAppServerConnectionOptions) {}

  private get requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? 30_000;
  }

  /** Whether a child is up and has finished the handshake. */
  isRunning(): boolean {
    return this.ready && this.child !== null;
  }

  /** Registers a listener for every notification. Returns its remover. */
  onNotification(handler: CodexAppServerNotificationHandler): () => void {
    this.notificationListeners.add(handler);
    return () => this.notificationListeners.delete(handler);
  }

  /** Registers a listener for the child going away for any reason but stop(). */
  onExit(handler: CodexAppServerExitHandler): () => void {
    this.exitListeners.add(handler);
    return () => this.exitListeners.delete(handler);
  }

  /**
   * Starts the child and performs the handshake, unless it is already up.
   * Rejects with CodexAppServerUnavailableError while a restart backoff is
   * running or when the start fails; it never waits out a backoff, so a
   * caller can fall back at once.
   */
  async ensureStarted(): Promise<void> {
    if (this.isRunning()) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }
    const waitMs = this.nextStartAllowedAt - Date.now();
    if (waitMs > 0) {
      throw new CodexAppServerUnavailableError(
        `Codex app-server is restarting after a failure (${this.lastFailure ?? 'unknown'}); next attempt in ${Math.ceil(waitMs / 1000)}s.`,
      );
    }
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    let launch: { command: string; args: string[]; env: NodeJS.ProcessEnv };
    try {
      launch = this.options.resolveCommand();
    } catch (error) {
      this.recordFailure(error instanceof Error ? error.message : String(error));
      throw new CodexAppServerUnavailableError(this.lastFailure ?? 'Codex CLI not found');
    }

    const generation = ++this.generation;
    const child = spawn(launch.command, [...launch.args, 'app-server'], {
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.stderrTail = '';
    this.startedAt = Date.now();

    // Sandbox and skill warnings land on stderr at every start; only the tail
    // is kept, to explain a child that dies.
    child.stderr?.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-2000);
    });
    child.stderr?.on('error', () => {});

    const reader = readline.createInterface({ input: child.stdout! });
    reader.on('line', (line) => {
      if (generation === this.generation) {
        this.handleLine(line);
      }
    });

    const onGone = (reason: string) => {
      if (generation !== this.generation) {
        return;
      }
      reader.close();
      this.handleChildGone(reason);
    };
    child.on('error', (error) => onGone(error.message));
    child.on('exit', (code, signal) => onGone(`codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`));
    // A write to a dead child raises EPIPE on the stream; unhandled, that
    // would take the whole server down.
    child.stdin?.on('error', (error) => onGone(error.message));
    child.stdout?.on('error', (error) => onGone(error.message));

    try {
      // `experimentalApi`: Codex 0.169 refuses `runtimeWorkspaceRoots` on
      // thread/start, thread/resume and turn/start without it.
      await this.request('initialize', {
        clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '1' },
        capabilities: { experimentalApi: true },
      });
      this.write({ jsonrpc: '2.0', method: 'initialized', params: {} });
      this.ready = true;
      // One line per start, so the server log shows the runtime is in use.
      console.log(`[Codex] app-server started for Codex conversations (pid ${child.pid ?? 'unknown'})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = this.stderrTail.trim().split('\n').slice(-1)[0];
      this.generation += 1;
      this.stopChild();
      this.recordFailure(message);
      throw new CodexAppServerUnavailableError(`Codex app-server failed to start: ${message}${detail ? ` — ${detail}` : ''}`);
    }
  }

  /** Sends a request and resolves its result. */
  request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new CodexAppServerUnavailableError('Codex app-server is not running.'));
        return;
      }
      const id = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerUnavailableError(`Codex app-server did not answer "${method}" within ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /**
   * Stops the child on purpose (idle, server shutdown). Not a crash: no
   * backoff, and exit listeners are told so in-flight turns can end.
   */
  stop(reason = 'Codex app-server was stopped.'): void {
    if (!this.child) {
      return;
    }
    console.log(`[Codex] app-server stopped: ${reason}`);
    // Invalidate first so the child's own exit event is ignored.
    this.generation += 1;
    this.stopChild();
    this.failEverything(reason);
    this.consecutiveFailures = 0;
    this.nextStartAllowedAt = 0;
  }

  private stopChild(): void {
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (!child) {
      return;
    }
    // The launcher is a node wrapper around the native binary; on Windows a
    // kill ends only the wrapper. Closing stdin is what makes the native
    // app-server itself exit (it stops at EOF).
    try {
      child.stdin?.end();
    } catch {
      // Already closed.
    }
    child.kill();
  }

  private handleChildGone(reason: string): void {
    const uptime = Date.now() - this.startedAt;
    const wasReady = this.ready;
    this.child = null;
    this.ready = false;
    if (!wasReady) {
      // Died during the handshake: start() records the failure when the
      // pending `initialize` rejects here.
      this.failEverything(reason);
      return;
    }
    const detail = this.stderrTail.trim().split('\n').slice(-1)[0];
    const fullReason = detail ? `${reason} — ${detail}` : reason;
    if (uptime >= STABLE_UPTIME_MS) {
      this.consecutiveFailures = 0;
    }
    this.recordFailure(fullReason);
    console.warn(`[Codex] app-server stopped unexpectedly: ${fullReason}`);
    this.failEverything(fullReason);
  }

  private recordFailure(reason: string): void {
    this.lastFailure = reason;
    this.consecutiveFailures += 1;
    const base = this.options.restartBackoffMs ?? 1_000;
    const ceiling = this.options.maxRestartBackoffMs ?? 60_000;
    const delay = Math.min(ceiling, base * 2 ** (this.consecutiveFailures - 1));
    this.nextStartAllowedAt = Date.now() + delay;
  }

  private failEverything(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexAppServerUnavailableError(`Codex app-server is not running: ${reason}`));
    }
    this.pending.clear();
    for (const listener of [...this.exitListeners]) {
      try {
        listener(reason);
      } catch (error) {
        console.error('[Codex] app-server exit listener failed:', error);
      }
    }
  }

  private write(message: unknown): void {
    try {
      this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      console.warn('[Codex] Failed to write to the app-server:', error);
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcLine;
    try {
      message = JSON.parse(line) as JsonRpcLine;
    } catch {
      return;
    }

    // A line with `method` is never a reply, even when its id matches one of
    // ours: the app-server numbers its own requests independently.
    if (typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) {
        void this.answerServerRequest(message.id, message.method, message.params);
        return;
      }
      for (const listener of [...this.notificationListeners]) {
        try {
          listener(message.method, message.params);
        } catch (error) {
          console.error(`[Codex] app-server notification handler failed for ${message.method}:`, error);
        }
      }
      return;
    }

    if (typeof message.id !== 'number') {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new CodexAppServerRpcError(
        pending.method,
        message.error.message || `Codex app-server rejected "${pending.method}".`,
        message.error.code,
      ));
      return;
    }
    pending.resolve(message.result);
  }

  private async answerServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    // [local] An answer can take minutes (a person decides); one that comes
    // after this child went away must not reach its successor, whose own
    // requests reuse the same ids.
    const generation = this.generation;
    try {
      const result = await this.options.handleServerRequest(method, params, id);
      if (generation !== this.generation || result === CODEX_APP_SERVER_NO_REPLY) {
        return;
      }
      this.write({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: RPC_METHOD_NOT_FOUND, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}
