const GAPI_SRC = "https://apis.google.com/js/api.js";

/** Matches `REQUEST_TIMEOUT_MS` in `google-drive-sync.ts`, and for the same reason: a
 * foreign widget that never answers must not hold the session's `connecting` flag up
 * forever. That flag gates Connect, Join *and* the Settings erase, so a hung picker with
 * no ceiling here leaves a page reload as the only way out. */
const PICKER_TIMEOUT_MS = 15000;

type PickerResponse = { action: string; docs?: { id: string }[] };
type PickerInstance = { setVisible(visible: boolean): void };
type DocsView = {
  setOwnedByMe(ownedByMe: boolean): DocsView;
  setMimeTypes(mimeTypes: string): DocsView;
  setMode(mode: string): DocsView;
};
type PickerBuilder = {
  addView(view: DocsView): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(appId: string): PickerBuilder;
  setCallback(callback: (response: PickerResponse) => void): PickerBuilder;
  build(): PickerInstance;
};
type GooglePicker = {
  picker: {
    PickerBuilder: new () => PickerBuilder;
    DocsView: new (viewId?: string) => DocsView;
    ViewId: { DOCS: string };
    DocsViewMode: { LIST: string };
    Action: { PICKED: string; CANCEL: string };
  };
};
type Gapi = { load(api: string, callback: () => void): void };

function gapi(): Gapi | undefined {
  return (globalThis as { gapi?: Gapi }).gapi;
}

function googlePicker(): GooglePicker | undefined {
  return (globalThis as { google?: GooglePicker }).google;
}

let gapiLoading: Promise<void> | undefined;
function loadGapiScript(): Promise<void> {
  if (gapi()) return Promise.resolve();
  if (!gapiLoading) {
    gapiLoading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = GAPI_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        gapiLoading = undefined;
        reject(new Error("Google API script failed to load"));
      };
      document.head.appendChild(script);
    });
  }
  return gapiLoading;
}

function loadPickerModule(): Promise<void> {
  return loadGapiScript().then(
    () =>
      new Promise((resolve) => {
        gapi()!.load("picker", () => resolve());
      }),
  );
}

/**
 * Opens the Google Picker scoped to files the signed-in account does not own — i.e.
 * files someone else shared with them — and resolves to the id of the file they picked,
 * or `null` if they closed the dialog without picking one.
 *
 * `drive.file` scope (chosen in BL-030) only ever sees files this app created, or files
 * the user has explicitly opened through it. A file merely shared via Drive's own
 * "Share" dialog does not show up in a `files.list` search under that scope until the
 * user picks it here once — this is that one-time pick.
 *
 * `appId` is the Cloud project number, which `setAppId` needs for the per-file grant this
 * pick creates to be attributed to *this* app. Without it the file id can come back and
 * the very next Drive call still fail — Google documents it as required under `drive.file`.
 *
 * The view is narrowed to `application/json` in LIST mode: the first drops native Docs,
 * Sheets and Slides (and so most accidental mis-picks) from the dialog, the second is what
 * Google recommends for any scope narrower than `drive`/`drive.readonly`, where the user
 * has granted no thumbnail access for a grid to draw.
 */
export async function pickSharedFile(
  apiKey: string,
  accessToken: string,
  appId: string,
): Promise<string | null> {
  await loadPickerModule();
  const picker = googlePicker()!.picker;
  return new Promise((resolve, reject) => {
    // A timeout is a real failure, not a cancel, so it rejects: `runConnect`'s catch on
    // `pickFile` turns that into a visible error, where resolving `null` would be
    // indistinguishable from the user closing the dialog and would say nothing at all.
    const timer = setTimeout(() => reject(new Error("Picker timed out")), PICKER_TIMEOUT_MS);
    const settle = (value: string | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    const view = new picker.DocsView(picker.ViewId.DOCS)
      .setOwnedByMe(false)
      .setMimeTypes("application/json")
      .setMode(picker.DocsViewMode.LIST);
    const instance = new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey(apiKey)
      .setAppId(appId)
      .setCallback((response) => {
        if (response.action === picker.Action.PICKED) {
          settle(response.docs?.[0]?.id ?? null);
        } else if (response.action === picker.Action.CANCEL) {
          settle(null);
        }
      })
      .build();
    instance.setVisible(true);
  });
}
