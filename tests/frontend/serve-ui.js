import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = normalize(join(import.meta.dirname, "..", "..", "src"));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = normalize(join(root, relative));
  if (!path.startsWith(root)) { response.writeHead(403).end(); return; }
  try {
    let content = await readFile(path);
    if (relative === "index.html" && url.searchParams.has("fixture")) {
      const fixture = `<script>
      const defaultSettings = {
        destination: "", organize_by_type: false, theme: "",
        speed_limit_bytes: 0,
        schedule: { enabled: false, start_minute: 120, end_minute: 420, days: [true, true, true, true, true, true, true], max_concurrent: 5 }
      };
      const storedSettings = () => {
        try {
          const stored = JSON.parse(localStorage.getItem("sandwich-fixture-settings") ?? "{}");
          return { ...defaultSettings, ...stored, schedule: { ...defaultSettings.schedule, ...stored.schedule } };
        } catch { return { ...defaultSettings, schedule: { ...defaultSettings.schedule } }; }
      };
      // Specs can seed the backend view before startup. Otherwise localStorage stands in for
      // settings.json so a reload proves transfer limits really survive one.
      window.__sandwichSettings ??= storedSettings();
      window.__sandwichScheduleStatus ??= { enabled: false, open: true, waiting: 0 };
      window.__SANDWICH_TEST_BRIDGE__ = {
        invoke: async (command, payload) => {
          if (command === "load_settings") return window.__sandwichSettings;
          if (command === "save_settings") {
            window.__sandwichSettings = payload.settings;
            localStorage.setItem("sandwich-fixture-settings", JSON.stringify(payload.settings));
            return window.__sandwichScheduleStatus;
          }
          if (command === "schedule_status") return window.__sandwichScheduleStatus;
          if (command === "list_downloads") return [
            { id: "active-1", filename: "ubuntu-24.04.iso", status: "active", completed_bytes: 5242880, total_bytes: 10485760, bytes_per_second: 1048576, eta_seconds: 5, connections: 8, num_pieces: 40, bitfield: "ffffe000000000000000", source_url: "https://releases.example.com/ubuntu-24.04.iso", directory: "C:\\Users\\Tester\\Downloads" },
            { id: "paused-1", filename: "album.flac", status: "paused", completed_bytes: 1048576, total_bytes: 4194304, bytes_per_second: 0, connections: 0, num_pieces: 16, bitfield: "f000", source_url: "https://music.example.com/album.flac", directory: "C:\\Users\\Tester\\Downloads" },
            { id: "failed-1", filename: "report.pdf", status: "failed", completed_bytes: 0, total_bytes: 2048, bytes_per_second: 0, connections: 0, num_pieces: 1, bitfield: "0", error: { code: 22, message: "The response status is not successful. status=403" }, source_url: "https://docs.example.com/report.pdf", directory: "C:\\Users\\Tester\\Downloads" },
            { id: "completed-1", filename: "setup.exe", status: "completed", completed_bytes: 4096, total_bytes: 4096, bytes_per_second: 0, connections: 0, num_pieces: 8, bitfield: "ff", source_url: "https://apps.example.com/setup.exe", directory: "C:\\Users\\Tester\\Downloads" }
          ];
          if (command === "choose_destination") return "C:\\\\Users\\\\Tester\\\\Downloads";
          if (command === "submit_url") return { id: "queued-2", filename: "manual.iso", status: "queued", completed_bytes: 0, total_bytes: 2097152, bytes_per_second: 0 };
          if (command === "control_download") {
            if (payload.action === "retry") return { id: "retried-" + payload.downloadId, filename: "report.pdf", status: "active", completed_bytes: 0, total_bytes: 2048, bytes_per_second: 128, connections: 1, num_pieces: 1, bitfield: "0", source_url: "https://docs.example.com/report.pdf", directory: "C:\\Users\\Tester\\Downloads" };
            return { id: payload.downloadId, filename: "example.zip", status: payload.action === "pause" ? "paused" : "cancelled", completed_bytes: 5242880, total_bytes: 10485760, bytes_per_second: 0 };
          }
        },
        listen: async (event, handler) => {
          // Registry so tests can fire any engine event by hand.
          (window.__sandwichHandlers ??= {})[event] = handler;
          if (event === "clipboard-url-offer") setTimeout(() => handler({ payload: { display_url: "https://example.com/copied.zip", token: "fixture-offer" } }), 50);
          return () => {};
        }
      };</script>`;
      content = Buffer.from(content.toString().replace('<script type="module" src="./main.js"></script>', fixture + '<script type="module" src="./main.js"></script>'));
    }
    // No caching: a stale ES module in the browser is indistinguishable from a broken change,
    // which is a genuinely expensive way to lose an afternoon.
    response.writeHead(200, {
      "Content-Type": types[extname(path)] ?? "application/octet-stream",
      "Cache-Control": "no-store, must-revalidate"
    });
    response.end(content);
  }
  catch { response.writeHead(404).end("Not found"); }
}).listen(4317, "127.0.0.1", () => console.log("Sandwich UI: http://127.0.0.1:4317"));
