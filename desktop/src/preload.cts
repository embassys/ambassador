import electron = require("electron");
const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("ambassador", {
  command: (command: unknown) => ipcRenderer.invoke("ambassador:command", command),
  copy: (text: string) => ipcRenderer.invoke("ambassador:copy", text),
  onChange: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("ambassador:changed", listener);
    return () => ipcRenderer.removeListener("ambassador:changed", listener);
  },
});
