import type { MenuItemConstructorOptions } from "electron";

export function applicationMenu(
  platform: string,
  openSettings: () => void,
): MenuItemConstructorOptions[] {
  const settings: MenuItemConstructorOptions = {
    id: "settings",
    label: "Settings…",
    accelerator: "CommandOrControl+,",
    click: openSettings,
  };
  return [
    platform === "darwin"
      ? {
          label: "Embassys",
          submenu: [
            { role: "about" },
            { type: "separator" },
            settings,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }
      : { label: "File", submenu: [settings, { type: "separator" }, { role: "quit" }] },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}
