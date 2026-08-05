export type PushPlatform = "ios" | "android";
export type PushPermission = "granted" | "denied" | "undetermined";

export interface PushNative {
  permission(): Promise<PushPermission>;
  requestPermission(): Promise<PushPermission>;
  expoToken(): Promise<string>;
  readonly platform: PushPlatform;
}

export interface PushRegistrationOptions {
  readonly server: string;
  readonly sessionToken: () => string | null;
  readonly writerId: () => string | null;
  readonly native: PushNative;
  readonly fetch?: PushFetch;
}

export type PushFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type PushRegistrationResult =
  | { readonly kind: "registered"; readonly token: string }
  | { readonly kind: "denied" };

const TOKEN = /^[\x21-\x7e]+$/;

export function isValidPushToken(token: string): boolean {
  return token.length > 0 && token.length <= 512 && TOKEN.test(token);
}

function required(value: string | null, name: string): string {
  if (!value) throw new Error(`push: ${name} unavailable`);
  return value;
}

async function expectNoContent(response: Response): Promise<void> {
  if (response.status !== 204) throw new Error(`push: server returned ${response.status}`);
}

/** Route-ready registration service. App/runtime wiring deliberately lives elsewhere. */
export class PushRegistration {
  private readonly request: PushFetch;

  constructor(private readonly options: PushRegistrationOptions) {
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async register(): Promise<PushRegistrationResult> {
    let permission = await this.options.native.permission();
    if (permission !== "granted") permission = await this.options.native.requestPermission();
    if (permission !== "granted") return { kind: "denied" };

    const token = await this.options.native.expoToken();
    if (!isValidPushToken(token)) throw new Error("push: invalid Expo token");
    const session = required(this.options.sessionToken(), "session");
    const writerId = required(this.options.writerId(), "writer id");
    const response = await this.request(`${this.options.server}/api/v1/push/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
      body: JSON.stringify({ token, platform: this.options.native.platform, writer_id: writerId }),
    });
    await expectNoContent(response);
    return { kind: "registered", token };
  }

  async unregister(token: string): Promise<void> {
    if (!isValidPushToken(token)) throw new Error("push: invalid Expo token");
    const session = required(this.options.sessionToken(), "session");
    const response = await this.request(
      `${this.options.server}/api/v1/push/tokens/${encodeURIComponent(token)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${session}` } },
    );
    await expectNoContent(response);
  }
}

export interface NotificationContent {
  readonly title: unknown;
  readonly body: unknown;
  readonly subtitle?: unknown;
  readonly data: unknown;
}

export interface NotificationTap {
  readonly id: string;
  readonly content: NotificationContent;
}

export interface NotificationTapNative {
  lastResponse(): Promise<NotificationTap | null>;
  clearLastResponse(): Promise<void>;
  listen(listener: (tap: NotificationTap) => void): () => void;
}

/** Rejects payload enrichment before triggering the only allowed action: sync. */
export async function handleNotificationTap(
  content: NotificationContent,
  sync: () => Promise<unknown>,
): Promise<boolean> {
  const data = content.data;
  const emptyData = data === undefined || (typeof data === "object" && data !== null
    && !Array.isArray(data) && Object.keys(data).length === 0);
  if (content.title !== "New transaction" || content.body !== ""
    || (content.subtitle !== undefined && content.subtitle !== null) || !emptyData) return false;
  await sync();
  return true;
}

/** Installs the live listener and consumes the cold-start response without double syncing. */
export async function installNotificationTapHandling(
  native: NotificationTapNative,
  sync: () => Promise<unknown>,
  onLiveError: (error: unknown) => void,
): Promise<() => void> {
  const handled = new Map<string, Promise<void>>();
  let installed = false;
  const consume = (tap: NotificationTap): Promise<void> => {
    const existing = handled.get(tap.id);
    if (existing !== undefined) return existing;
    const pending = handleNotificationTap(tap.content, sync).then(() => undefined);
    handled.set(tap.id, pending);
    return pending;
  };
  const unsubscribe = native.listen((tap) => {
    void consume(tap).catch((error: unknown) => { if (installed) onLiveError(error); });
  });
  try {
    const last = await native.lastResponse();
    if (last !== null) {
      await consume(last);
      await native.clearLastResponse();
    }
    installed = true;
  } catch (error) {
    unsubscribe();
    throw error;
  }
  return unsubscribe;
}
