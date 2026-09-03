#!/usr/bin/env node

////
// Launch Chrome for Testing with the unpacked extension from build/.
//
// Chrome restricts --load-extension on the stable channel, so this
// deliberately uses a Chrome for Testing binary, where the flag still
// works. The binary is resolved from the puppeteer cache and downloaded
// on first run.
//
//   node scripts/dev-chrome.mjs [--watch] [--popup] [--channel=<c>]
//
// --watch  reload the extension whenever build/ changes
// --popup  open the extension popup once loaded
////

import { watch } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BROWSER_DIR = resolve(SCRIPT_DIR, "..");
const BUILD_DIR = join(BROWSER_DIR, "build");
const REPO_ROOT = resolve(BROWSER_DIR, "../..");

// Shared with `npm run debug:desktop`, which writes the desktop client's native messaging
// manifest into this profile so the two debug instances can reach each other.
const PROFILE_DIR = join(REPO_ROOT, ".debug", "chrome-profile");

// The desktop client's IPC socket directory. Chrome spawns the native messaging proxy, so the
// proxy inherits this from Chrome's environment and finds the debug client's socket instead of
// the installed client's default one. Must match debug-start.js.
const IPC_SOCKET_DIR = join(REPO_ROOT, ".debug");

// Matches the chrome-devtools-attach server in the repo root .mcp.json,
// so MCP tooling can attach to this instance without extra config.
const DEBUG_PORT = 9200;

const DEFAULT_CHANNEL = "stable";
const SERVICE_WORKER = "service_worker";
const EXTENSION_SCHEME = "chrome-extension://";

// Coalesce the burst of fs events a webpack rebuild emits into one reload.
const REBUILD_SETTLE_MS = 400;

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const channelArg = argv.find((a) => a.startsWith("--channel="));

  return {
    watch: argv.includes("--watch"),
    popup: argv.includes("--popup"),
    channel: channelArg ? channelArg.split("=")[1] : DEFAULT_CHANNEL,
  };
}

// puppeteer-core is intentionally not a dependency of this monorepo. Fail
// with the install line rather than a bare MODULE_NOT_FOUND.
function loadDeps() {
  try {
    return {
      puppeteer: require("puppeteer-core"),
      browsers: require("@puppeteer/browsers"),
    };
  } catch {
    throw new Error(
      "Missing dev dependencies. Install them first:\n" +
        "  npm install --no-save puppeteer-core @puppeteer/browsers",
    );
  }
}

async function assertBuilt() {
  try {
    await access(join(BUILD_DIR, "manifest.json"));
  } catch {
    throw new Error(`No build found at ${BUILD_DIR}. Run: npm run build:chrome`);
  }
}

// Reuse the cached Chrome for Testing download when present; install it
// on first run so a fresh clone needs no manual browser setup.
async function resolveChrome(browsers, channel) {
  const cacheDir = join(process.env.HOME, ".cache", "puppeteer");
  const platform = browsers.detectBrowserPlatform();

  if (!platform) {
    throw new Error("Unsupported platform for Chrome for Testing downloads.");
  }

  const buildId = await browsers.resolveBuildId(browsers.Browser.CHROME, platform, channel);

  const installed = await browsers.install({
    browser: browsers.Browser.CHROME,
    buildId,
    cacheDir,
    platform,
  });

  return installed.executablePath;
}

async function launch(puppeteer, executablePath) {
  return puppeteer.launch({
    executablePath,
    headless: false,
    userDataDir: PROFILE_DIR,
    env: { ...process.env, BITWARDEN_IPC_SOCKET_DIR: IPC_SOCKET_DIR },
    // Let Chrome own its own lifecycle; closing the browser ends the script.
    handleSIGINT: false,
    defaultViewport: null,
    args: [
      `--load-extension=${BUILD_DIR}`,
      `--disable-extensions-except=${BUILD_DIR}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
}

// The extension id is only knowable once its service worker registers.
async function waitForWorker(browser) {
  const target = await browser.waitForTarget(
    (t) => t.type() === SERVICE_WORKER && t.url().startsWith(EXTENSION_SCHEME),
    { timeout: 30_000 },
  );

  const url = new URL(target.url());

  return { target, id: url.hostname };
}

async function openPopup(browser, extensionId) {
  const manifest = JSON.parse(await readFile(join(BUILD_DIR, "manifest.json"), "utf8"));
  const popup = manifest.action?.default_popup;

  if (!popup) {
    return;
  }

  const page = await browser.newPage();
  await page.goto(`${EXTENSION_SCHEME}${extensionId}/${popup}`);
}

// chrome.runtime.reload() from inside the worker picks up rebuilt assets
// without restarting the browser, so the dev profile stays logged in.
async function reload(target) {
  const worker = await target.worker();

  if (!worker) {
    return;
  }

  await worker.evaluate(() => chrome.runtime.reload());
}

function watchBuild(onChange) {
  let timer;

  const watcher = watch(BUILD_DIR, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, REBUILD_SETTLE_MS);
  });

  return watcher;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { puppeteer, browsers } = loadDeps();

  await assertBuilt();

  const executablePath = await resolveChrome(browsers, args.channel);
  console.log(`Chrome: ${executablePath}`);

  const browser = await launch(puppeteer, executablePath);
  const { target, id } = await waitForWorker(browser);

  console.log(`Extension: ${id}`);
  console.log(`Profile:   ${PROFILE_DIR}`);
  console.log(`DevTools:  http://localhost:${DEBUG_PORT}`);

  if (args.popup) {
    await openPopup(browser, id);
  }

  if (args.watch) {
    console.log(`Watching ${BUILD_DIR} — rebuild to reload.`);

    const watcher = watchBuild(async () => {
      try {
        // The worker target is replaced on each reload, so re-resolve it.
        const current = await waitForWorker(browser);
        await reload(current.target);
        console.log("Reloaded.");
      } catch (e) {
        console.error(`Reload failed: ${e.message}`);
      }
    });

    browser.on("disconnected", () => watcher.close());
  }

  // Hold the process open until the browser window is closed.
  await new Promise((res) => browser.on("disconnected", res));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
