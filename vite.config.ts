import { copyFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { defineConfig, type Plugin } from "vite";

/** After the build, write a service worker that precaches every built file (offline use). */
function offline(): Plugin {
  return {
    name: "petvoice-offline",
    apply: "build",
    closeBundle() {
      const dist = "dist";
      for (const name of ["LICENSE", "THIRD-PARTY-NOTICES.md"]) {
        copyFileSync(name, join(dist, name));
      }
      copyFileSync("vendor/chimera/LICENSE", join(dist, "licenses", "CHIMERA.txt"));
      const files: string[] = [];
      const walk = (d: string) => {
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          if (statSync(p).isDirectory()) walk(p);
          else if (f !== "sw.js") files.push("./" + relative(dist, p).replaceAll("\\", "/"));
        }
      };
      walk(dist);
      const version = Date.now().toString(36);
      writeFileSync(
        join(dist, "sw.js"),
        `const CACHE = "petvoice-${version}";
const FILES = ${JSON.stringify(["./", ...files])};
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
`,
      );
    },
  };
}

export default defineConfig({
  // relative paths: the build works from any sub-path (GitHub Pages, a zip on a static host)
  base: "./",
  plugins: [offline()],
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: false },
  server: { host: "127.0.0.1", port: 5173 },
  preview: { host: "127.0.0.1", port: 4173 },
});
