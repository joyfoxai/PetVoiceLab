import "./style.css";
import { App } from "./ui/app.ts";

new App();

// offline use: cache the built files (no-op in dev)
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
