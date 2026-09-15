const GAPI_SRC = "https://apis.google.com/js/api.js";

/** Bounds the picker's *load* — the `apis.google.com` script and the `picker` module
 * registration behind it — and deliberately nothing past it; see `pickSharedFile` for why
 * the dialog itself carries no ceiling. Matches `REQUEST_TIMEOUT_MS` in
 * `google-drive-sync.ts`, and for the same reason: a foreign script that never answers must
 * not hold the session's `connecting` flag up forever. That flag gates Connect, Join *and*
 * the Settings erase, so a load with no ceiling here leaves a page reload as the only way
 * out. */
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

/** Races `promise` against a plain timeout, rejecting with `message` if the ceiling passes
 * first. Used only to bound the picker's own script/module load — see `pickSharedFile`'s
 * own doc comment for why the dialog-open phase deliberately carries no ceiling of its
 * own. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
 *
 * **The ceiling covers script and module load only, deliberately not the dialog itself.**
 * Loading `apis.google.com` and registering the picker module are machine-latency-bound —
 * exactly the shape `PICKER_TIMEOUT_MS` (matching `REQUEST_TIMEOUT_MS` in
 * `google-drive-sync.ts`) exists to bound, for the same reason: a foreign script that never
 * answers must not hold the session's `connecting` flag up forever, since that flag gates
 * Connect, Join *and* the Settings erase. Once the dialog is actually on screen, the wait is
 * a person browsing "Shared with me" and picking a file — ordinary selection time, not a
 * hung widget — and the Picker's own UI already offers its own way out (its close button
 * fires `CANCEL` like any other dismissal). A ceiling there would fire during completely
 * normal use and, worse, would still leave the dialog visibly open while lying that it
 * could not be opened at all.
 *
 * A timeout is a real failure, not a cancel, so it rejects: `runConnect`'s catch on
 * `pickFile` turns that into a visible error, where resolving `null` would be
 * indistinguishable from the user closing the dialog and would say nothing at all. And
 * because the ceiling no longer overlaps the dialog-visible phase, `SYNC_PICKER_FAILED`
 * ("Could not open the Google file picker") stays true of every case that can still reach
 * it: the dialog genuinely never opened.
 */
export async function pickSharedFile(
  apiKey: string,
  accessToken: string,
  appId: string,
): Promise<string | null> {
  try {
    await withTimeout(loadPickerModule(), PICKER_TIMEOUT_MS, "Picker failed to load in time");
  } catch (error) {
    // `gapiLoading` is memoised, so a load that *hangs* is worse than one that fails: the
    // `onerror` path clears it and a later Join retries, but a `<script>` that fires neither
    // `onload` nor `onerror` leaves that promise pending forever, and every Join afterwards
    // awaits the same corpse and dies on the same ceiling — a page reload the only way out.
    // Cleared here rather than inside the timeout so the two failure shapes get the same
    // answer in one place: the next attempt appends a fresh tag and starts over. Clearing it
    // on the module-registration hang too costs nothing — `gapi` is already on the page by
    // then, so `loadGapiScript` short-circuits and no second tag is appended.
    gapiLoading = undefined;
    throw error;
  }
  const picker = googlePicker()!.picker;
  return new Promise((resolve) => {
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
          resolve(response.docs?.[0]?.id ?? null);
        } else if (response.action === picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    instance.setVisible(true);
  });
}
