const GAPI_SRC = "https://apis.google.com/js/api.js";

type PickerResponse = { action: string; docs?: { id: string }[] };
type PickerInstance = { setVisible(visible: boolean): void };
type DocsView = { setOwnedByMe(ownedByMe: boolean): DocsView };
type PickerBuilder = {
  addView(view: DocsView): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setCallback(callback: (response: PickerResponse) => void): PickerBuilder;
  build(): PickerInstance;
};
type GooglePicker = {
  picker: {
    PickerBuilder: new () => PickerBuilder;
    DocsView: new (viewId?: string) => DocsView;
    ViewId: { DOCS: string };
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
 */
export async function pickSharedFile(apiKey: string, accessToken: string): Promise<string | null> {
  await loadPickerModule();
  const picker = googlePicker()!.picker;
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS).setOwnedByMe(false);
    const instance = new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey(apiKey)
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
