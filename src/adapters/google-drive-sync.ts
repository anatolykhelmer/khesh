import { err, ok, type Result } from "../kernel/result";
import type { SyncStorePort } from "../ports/sync-store";

const GIS_SRC = "https://accounts.google.com/gsi/client";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FILE_NAME = "khesh-book.json";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const ABOUT_URL = "https://www.googleapis.com/drive/v3/about";

type TokenResponse = { access_token?: string; expires_in?: number; error?: string };
type TokenClient = { requestAccessToken(config?: { prompt?: "" | "consent" }): void };
type Gis = {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: { type?: string }) => void;
      }): TokenClient;
      revoke(token: string, done?: () => void): void;
    };
  };
};

function gis(): Gis | undefined {
  return (globalThis as { google?: Gis }).google;
}

let gisLoading: Promise<void> | undefined;
function loadGisScript(): Promise<void> {
  if (gis()) return Promise.resolve();
  if (!gisLoading) {
    gisLoading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = GIS_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        gisLoading = undefined;
        reject(new Error("GIS script failed to load"));
      };
      document.head.appendChild(script);
    });
  }
  return gisLoading;
}

export interface GoogleAuth {
  getToken(interactive: boolean): Promise<Result<string>>;
  revoke(): Promise<void>;
}

/** In-memory hourly token. There are no refresh tokens in a pure frontend; when the
 * silent path fails (popup blocked without a user gesture), callers surface
 * needsAuth and retry from a tap. */
export function createGoogleAuth(clientId: string): GoogleAuth {
  let token: string | null = null;
  let expiresAt = 0;
  let pending: { callback: (response: TokenResponse) => void } | null = null;
  let client: TokenClient | null = null;

  function ensureClient(): TokenClient {
    if (!client) {
      client = gis()!.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: (response) => pending?.callback(response),
        error_callback: () => pending?.callback({ error: "popup" }),
      });
    }
    return client;
  }

  return {
    async getToken(interactive: boolean): Promise<Result<string>> {
      if (token !== null && Date.now() < expiresAt) return ok(token);
      try {
        await loadGisScript();
      } catch {
        return err("SYNC_STORE_FAILED", "Could not load Google auth");
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending = null;
          resolve(err("SYNC_AUTH_REQUIRED", "Sign-in timed out"));
        }, 15000);
        pending = {
          callback: (response) => {
            clearTimeout(timer);
            pending = null;
            if (response.access_token) {
              token = response.access_token;
              expiresAt = Date.now() + ((response.expires_in ?? 3600) - 60) * 1000;
              resolve(ok(token));
            } else {
              resolve(err("SYNC_AUTH_REQUIRED", "Sign-in was not completed"));
            }
          },
        };
        ensureClient().requestAccessToken(interactive ? undefined : { prompt: "" });
      });
    },

    async revoke(): Promise<void> {
      const current = token;
      token = null;
      expiresAt = 0;
      if (current && gis()) {
        await new Promise<void>((resolve) => gis()!.accounts.oauth2.revoke(current, resolve));
      }
    },
  };
}

export type DriveStoreDeps = {
  getToken: (interactive?: boolean) => Promise<Result<string>>;
  getFileId: () => string | null;
  onFileId: (id: string) => void | Promise<void>;
  fetchImpl?: typeof fetch;
};

export function createDriveSyncStore(deps: DriveStoreDeps): SyncStorePort {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function authFetch(url: string, init?: RequestInit): Promise<Result<Response>> {
    const token = await deps.getToken(false);
    if (!token.ok) return token;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${token.value}` },
      });
    } catch {
      return err("SYNC_STORE_FAILED", "Network failure talking to Drive");
    }
    if (response.status === 401) return err("SYNC_AUTH_REQUIRED", "Drive rejected the token");
    if (response.status === 404) return err("SYNC_FILE_MISSING", "Sync file not found in Drive");
    if (!response.ok) return err("SYNC_STORE_FAILED", `Drive responded ${response.status}`);
    return ok(response);
  }

  /** Resolve the fileId: the cached one, else a search by name (another device may
   * have created the file), else null. */
  async function resolveFileId(): Promise<Result<string | null>> {
    const cached = deps.getFileId();
    if (cached !== null) return ok(cached);
    const query = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
    const found = await authFetch(`${FILES_URL}?q=${query}&spaces=drive&fields=files(id,modifiedTime)`);
    if (!found.ok) return found;
    const data = (await found.value.json()) as { files?: Array<{ id: string }> };
    const id = data.files?.[0]?.id ?? null;
    if (id !== null) await deps.onFileId(id);
    return ok(id);
  }

  async function metadata(id: string): Promise<Result<string>> {
    const response = await authFetch(`${FILES_URL}/${id}?fields=modifiedTime`);
    if (!response.ok) return response;
    const data = (await response.value.json()) as { modifiedTime?: string };
    return ok(data.modifiedTime ?? "");
  }

  return {
    async probe() {
      const id = await resolveFileId();
      if (!id.ok) return id;
      if (id.value === null) return ok(null);
      const rev = await metadata(id.value);
      if (!rev.ok) return rev;
      return ok({ rev: rev.value });
    },

    async read() {
      const id = await resolveFileId();
      if (!id.ok) return id;
      if (id.value === null) return ok(null);
      const rev = await metadata(id.value);
      if (!rev.ok) return rev;
      const media = await authFetch(`${FILES_URL}/${id.value}?alt=media`);
      if (!media.ok) return media;
      return ok({ payload: await media.value.text(), rev: rev.value });
    },

    async write(payload: string) {
      const id = await resolveFileId();
      if (!id.ok) return id;
      if (id.value !== null) {
        const patched = await authFetch(`${UPLOAD_URL}/${id.value}?uploadType=media&fields=id,modifiedTime`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: payload,
        });
        if (!patched.ok) return patched;
        const data = (await patched.value.json()) as { modifiedTime?: string };
        return ok({ rev: data.modifiedTime ?? "" });
      }
      const boundary = "khesh-envelope";
      const body = [
        `--${boundary}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        JSON.stringify({ name: FILE_NAME }),
        `--${boundary}`,
        "Content-Type: application/json",
        "",
        payload,
        `--${boundary}--`,
        "",
      ].join("\r\n");
      const created = await authFetch(`${UPLOAD_URL}?uploadType=multipart&fields=id,modifiedTime`, {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      });
      if (!created.ok) return created;
      const data = (await created.value.json()) as { id: string; modifiedTime?: string };
      await deps.onFileId(data.id);
      return ok({ rev: data.modifiedTime ?? "" });
    },
  };
}

export async function fetchAccountEmail(
  getToken: (interactive?: boolean) => Promise<Result<string>>,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<string>> {
  const token = await getToken(false);
  if (!token.ok) return token;
  try {
    const response = await fetchImpl(`${ABOUT_URL}?fields=user(emailAddress)`, {
      headers: { Authorization: `Bearer ${token.value}` },
    });
    if (!response.ok) return err("SYNC_STORE_FAILED", `Drive responded ${response.status}`);
    const data = (await response.json()) as { user?: { emailAddress?: string } };
    return ok(data.user?.emailAddress ?? "");
  } catch {
    return err("SYNC_STORE_FAILED", "Network failure talking to Drive");
  }
}
