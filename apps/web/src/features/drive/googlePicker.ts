/**
 * Import from Google Drive with Google's own Picker. The person signs in to Google in a popup (Google
 * Identity Services' token client, scope drive.file: Crewtavo can only open the files they pick), picks
 * files, and the API copies them in (POST /api/drive/import). The token lives in this tab's memory for
 * its hour and nowhere else; nothing of the Google account is kept.
 *
 * Google's scripts load only when someone is about to import (loadGooglePicker). Safari only opens a
 * popup straight from a tap, so openGooglePicker must be called in the click handler itself, with
 * nothing awaited before it: once the scripts are loaded.
 */

const API_JS = "https://apis.google.com/js/api.js";
const GSI_JS = "https://accounts.google.com/gsi/client";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
/** The most files the API copies in one go. */
export const IMPORT_MAX = 20;

export interface GoogleKeys {
  clientId: string;
  apiKey: string;
  /** The Google Cloud project number. */
  appId: string;
}

/** A file picked in Google Drive: what POST /api/drive/import takes. */
export interface PickedFile {
  id: string;
  name?: string;
  mimeType?: string;
}

// ----- The parts of Google's scripts used here -----------------------------------------------

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
}
interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}
interface DocsView {
  setIncludeFolders(on: boolean): DocsView;
  setSelectFolderEnabled(on: boolean): DocsView;
  setEnableDrives(on: boolean): DocsView;
  setMode(mode: string): DocsView;
}
interface PickerResponse {
  action: string;
  docs?: Array<{ id: string; name?: string; mimeType?: string }>;
}
interface PickerBuilder {
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  setMaxItems(count: number): PickerBuilder;
  addView(view: DocsView): PickerBuilder;
  enableFeature(feature: string): PickerBuilder;
  setCallback(callback: (data: PickerResponse) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
}
interface GoogleNs {
  accounts?: {
    oauth2?: {
      initTokenClient(config: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type?: string }) => void }): TokenClient;
      hasGrantedAllScopes(r: TokenResponse, ...scopes: string[]): boolean;
    };
  };
  picker?: {
    PickerBuilder: new () => PickerBuilder;
    DocsView: new (viewId?: string) => DocsView;
    ViewId: { DOCS: string };
    DocsViewMode: { LIST: string };
    Feature: { MULTISELECT_ENABLED: string; SUPPORT_DRIVES: string };
    Action: { PICKED: string; CANCEL: string };
  };
}
interface Gapi {
  load(lib: string, options: { callback: () => void; onerror?: () => void; timeout?: number; ontimeout?: () => void }): void;
}

const globals = () => window as unknown as { google?: GoogleNs; gapi?: Gapi };

// ----- Loading -----------------------------------------------------------------------------------

function script(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing?.dataset.loaded) return resolve();
    const el = existing ?? document.createElement("script");
    el.addEventListener("load", () => {
      el.dataset.loaded = "1";
      resolve();
    }, { once: true });
    el.addEventListener("error", () => {
      // Gone, so the next try adds it again.
      el.remove();
      reject(new Error(`${src} didn't load`));
    }, { once: true });
    if (!existing) {
      el.src = src;
      el.async = true;
      document.head.appendChild(el);
    }
  });
}

let loading: Promise<void> | null = null;

/** Google's Picker and sign-in, loaded once. Safe to call again; a failure can be tried again. */
export function loadGooglePicker(): Promise<void> {
  loading ??= Promise.all([
    script(API_JS).then(
      () =>
        new Promise<void>((resolve, reject) => {
          const gapi = globals().gapi;
          if (!gapi) return reject(new Error("gapi missing"));
          gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("picker failed")), timeout: 20_000, ontimeout: () => reject(new Error("picker timed out")) });
        }),
    ),
    script(GSI_JS),
  ]).then(
    () => undefined,
    () => {
      loading = null;
      throw new Error("Google Drive didn't load. Check the connection and try again.");
    },
  );
  return loading;
}

/** Whether the Picker can open right now, straight from a tap. */
export function googlePickerReady(): boolean {
  const google = globals().google;
  return Boolean(google?.picker && google.accounts?.oauth2);
}

// ----- Signing in and picking ------------------------------------------------------------------

let token: { value: string; expires: number } | null = null;
let client: { id: string; tokens: TokenClient } | null = null;
let waiting: { done: (accessToken: string) => void; failed: (message: string | null) => void } | null = null;

/** Forget this tab's Google sign-in (Google turned it down), so the next import asks again. */
export function forgetGoogleToken() {
  token = null;
}

function tokenClient(google: GoogleNs, clientId: string): TokenClient {
  if (client?.id === clientId) return client.tokens;
  const oauth2 = google.accounts!.oauth2!;
  const tokens = oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: (r) => {
      const wait = waiting;
      waiting = null;
      if (!wait) return;
      // Declining isn't a failure worth a message.
      if (r.error || !r.access_token) return wait.failed(r.error === "access_denied" ? null : "Google didn't sign you in. Try again.");
      if (!oauth2.hasGrantedAllScopes(r, SCOPE)) return wait.failed("To import, let Crewtavo see the files you pick in Google Drive. Try again and allow it.");
      token = { value: r.access_token, expires: Date.now() + Number(r.expires_in ?? 3599) * 1000 };
      wait.done(r.access_token);
    },
    error_callback: (e) => {
      const wait = waiting;
      waiting = null;
      if (!wait) return;
      if (e.type === "popup_closed") return wait.failed(null);
      wait.failed(e.type === "popup_failed_to_open" ? "Google's sign-in window didn't open. Allow pop-ups for Crewtavo, then try again." : "Google sign-in didn't finish. Try again.");
    },
  });
  client = { id: clientId, tokens };
  return tokens;
}

/**
 * Opens Google's Picker, signing in to Google first when this tab hasn't yet (or its hour is up).
 * Call it straight from a click once googlePickerReady(); returns false when the scripts aren't
 * loaded yet. `picked` gets at most IMPORT_MAX files and the token to copy them with.
 */
export function openGooglePicker(
  keys: GoogleKeys,
  on: { picked: (files: PickedFile[], accessToken: string) => void; failed: (message: string) => void; cancelled?: () => void },
): boolean {
  const google = globals().google;
  if (!google?.picker || !google.accounts?.oauth2) return false;
  const picker = google.picker;
  const show = (accessToken: string) => {
    const myDrive = new picker.DocsView(picker.ViewId.DOCS).setIncludeFolders(false).setMode(picker.DocsViewMode.LIST);
    const shared = new picker.DocsView(picker.ViewId.DOCS).setEnableDrives(true).setIncludeFolders(true).setSelectFolderEnabled(false);
    new picker.PickerBuilder()
      .setDeveloperKey(keys.apiKey)
      .setAppId(keys.appId)
      .setOAuthToken(accessToken)
      .setOrigin(window.location.origin)
      .setTitle("Pick files to copy into Crewtavo")
      .addView(myDrive)
      .addView(shared)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .enableFeature(picker.Feature.SUPPORT_DRIVES)
      .setMaxItems(IMPORT_MAX)
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED) {
          const files = (data.docs ?? []).slice(0, IMPORT_MAX).map((d) => ({ id: d.id, name: d.name, mimeType: d.mimeType }));
          if (files.length) on.picked(files, accessToken);
        } else if (data.action === picker.Action.CANCEL) on.cancelled?.();
      })
      .build()
      .setVisible(true);
  };
  if (token && token.expires - 60_000 > Date.now()) {
    show(token.value);
    return true;
  }
  waiting = { done: show, failed: (message) => (message ? on.failed(message) : on.cancelled?.()) };
  // The first time in this tab, let them choose which Google account; after that, the same one.
  tokenClient(google, keys.clientId).requestAccessToken({ prompt: token ? "" : "select_account" });
  return true;
}
