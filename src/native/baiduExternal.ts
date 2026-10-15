/** Desktop authorization belongs in the system browser, not an Obsidian popup. */
export async function openBaiduExternal(
  url: string,
  desktop: boolean,
  host: Window | null
) {
  if (desktop) {
    let shell: { openExternal: (url: string) => Promise<void> } | undefined;
    try {
      shell = require("electron").shell;
    } catch {
      /* Browser/mobile builds can use the ordinary link below. */
    }
    if (shell?.openExternal) {
      await shell.openExternal(url);
      return;
    }
  }
  if (!host) throw new Error("browser_unavailable");
  // noopener may return null even when the browser opens. Always show a manual link in the UI.
  host.open(url, "_blank", "noopener,noreferrer");
}
