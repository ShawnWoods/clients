/* eslint-disable @typescript-eslint/no-require-imports */

////
// Same watch + Electron pipeline as start.js, but every piece of host state the client touches
// is redirected into the repo-root .debug/ directory, so a debug run never disturbs an
// installed client:
//
//   .debug/desktop-profile/           app data (vault, settings, logs)
//   .debug/chrome-profile/            native messaging manifest for the debug browser
//   .debug/.bitwarden-ssh-agent.sock  SSH agent socket
//   .debug/s.<name>                   IPC sockets
////

const { execFileSync } = require("child_process");
const path = require("path");

const concurrently = require("concurrently");
// Absolute path to the Electron binary, so it can be `exec`d directly (see the Elec command).
const electronBinary = require("electron");
const rimraf = require("rimraf");

const args = process.argv.splice(2);

const DEBUG_DIR = path.resolve(__dirname, "../../..", ".debug");

process.env.BITWARDEN_APPDATA_DIR = path.join(DEBUG_DIR, "desktop-profile");
process.env.BITWARDEN_CHROME_PROFILE_DIR = path.join(DEBUG_DIR, "chrome-profile");
process.env.BITWARDEN_SSH_AUTH_SOCK = path.join(DEBUG_DIR, ".bitwarden-ssh-agent.sock");
process.env.BITWARDEN_IPC_SOCKET_DIR = DEBUG_DIR;

process.env.NODE_ENV = "development";

// Debug Electron instances are identified by their unique inspect port, so leftovers from a
// previous run (or from one that outlived its parent) can be cleaned up.
const INSPECT_FLAG = "--inspect=5858";

// Webpack is invoked directly (instead of via `npm run build:*:watch`) and `exec`d, so each
// concurrently command's direct child *is* the watcher. Going through npm leaves the watcher as a
// grandchild that survives the kill signal on shutdown.
const WEBPACK = path.resolve(__dirname, "../../../node_modules/.bin/webpack");

function watchCommand(configName) {
  return `exec "${WEBPACK}" --config webpack.config.js --config-name ${configName} --watch`;
}

function killStrayClients() {
  try {
    execFileSync("pkill", ["-9", "-f", `Electron.*${INSPECT_FLAG}`]);
  } catch {
    // pkill exits non-zero when nothing matched.
  }
}

killStrayClients();
process.on("exit", killStrayClients);

rimraf.sync("build");

const { commands } = concurrently(
  [
    {
      name: "Main",
      command: `npm run build-native && ${watchCommand("main")}`,
      prefixColor: "yellow",
    },
    {
      name: "Prel",
      command: watchCommand("preload"),
      prefixColor: "magenta",
    },
    {
      name: "Rend",
      command: watchCommand("renderer"),
      prefixColor: "cyan",
    },
    {
      name: "Elec",
      // `exec` replaces the shell with Electron, so the kill signal below reaches Electron itself
      // instead of a wrapper that leaves an orphan client behind on Ctrl+C.
      //
      // Deliberately no `--watch`: that flag enables electron-reload, which spawns a *new* Electron
      // process per rebuild and leaves the previous one hanging around unresponsive. Webpack still
      // rebuilds on save; reload the window (Cmd/Ctrl+R) to pick up renderer changes, and restart
      // the script for main-process changes.
      command: `npx wait-on ./build/main.js ./build/index.html ./build/app/main.js && exec "${electronBinary}" --no-sandbox ${INSPECT_FLAG} --remote-debugging-port=9222 ${args.join(
        " ",
      )} ./build`,
      prefixColor: "green",
    },
  ],
  {
    prefix: "name",
    outputStream: process.stdout,
    killOthersOn: ["success", "failure"],
    // Electron ignores SIGINT/SIGTERM here (tray + quit handlers keep it alive), which left an
    // orphan client running after Ctrl+C. Nothing in a debug run needs a graceful shutdown.
    killSignal: "SIGKILL",
  },
);

// Ctrl+C: reap the whole pipeline before leaving. Electron ignores the terminal's SIGINT, and the
// watchers only see it when they share the terminal's process group.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    commands.forEach((command) => command.kill("SIGKILL"));
    killStrayClients();
    process.exit(0);
  });
}
