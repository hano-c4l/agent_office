// Shuts down the computer the office server runs on (for example when every department is stuck on a usage limit).
// The shutdown is delayed, so it can still be cancelled from the dashboard or with `shutdown /a` (Windows).
// Set OFFICE_SHUTDOWN_DRY_RUN=1 to log the command instead of running it.

import { execFile } from "node:child_process";

export const SHUTDOWN_DELAY_S = 60;

// The command for this platform: [file, args].
export function shutdownCommand(action, { platform = process.platform, delay = SHUTDOWN_DELAY_S } = {}) {
  const minutes = String(Math.max(1, Math.ceil(delay / 60)));
  if (platform === "win32") {
    return action === "cancel"
      ? ["shutdown", ["/a"]]
      : ["shutdown", ["/s", "/t", String(delay), "/c", "Agent Office: shutting down this computer."]];
  }
  if (platform === "darwin") {
    // macOS shutdown has no cancel flag: the scheduled shutdown process is stopped instead.
    return action === "cancel" ? ["killall", ["shutdown"]] : ["shutdown", ["-h", `+${minutes}`]];
  }
  return action === "cancel" ? ["shutdown", ["-c"]] : ["shutdown", ["-h", `+${minutes}`]];
}

export function runShutdownCommand(action) {
  const [file, args] = shutdownCommand(action);
  if (process.env.OFFICE_SHUTDOWN_DRY_RUN) {
    console.log(`[dry run] ${file} ${args.join(" ")}`);
    return Promise.resolve({ dryRun: true, command: [file, ...args].join(" ") });
  }
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim() || `${file} failed`));
      resolve({ dryRun: false, command: [file, ...args].join(" ") });
    });
  });
}
