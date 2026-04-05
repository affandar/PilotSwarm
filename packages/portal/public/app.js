import { Terminal } from "/xterm/lib/xterm.mjs";
import { FitAddon } from "/xterm-addon-fit/lib/addon-fit.mjs";
import { WebLinksAddon } from "/xterm-addon-web-links/lib/addon-web-links.mjs";
import { DEFAULT_THEME_ID, getTheme, listThemes } from "/ui-core/themes/index.js";

// ── Auth state ──────────────────────────────────────────────────
let authEnabled = false;
let msalInstance = null;
let currentAccount = null;
let accessToken = null;

const topbarUser = document.getElementById("topbar-user");
const topbarSignInBtn = document.getElementById("topbar-signin-btn");
const topbarSignOutBtn = document.getElementById("topbar-signout-btn");
const signedOutScreen = document.getElementById("signed-out-screen");

async function initAuth() {
  const resp = await fetch("/api/auth-config");
  const config = await resp.json();
  if (!config.enabled) {
    // No auth configured — proceed directly
    authEnabled = false;
    updateAuthUI();
    return true;
  }

  authEnabled = true;
  msalInstance = new msal.PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: config.authority,
      redirectUri: config.redirectUri,
    },
    cache: {
      cacheLocation: "sessionStorage",
      storeAuthStateInCookie: true,
    },
  });

  await msalInstance.initialize();

  // Handle redirect callback (if returning from redirect flow)
  const redirectResp = await msalInstance.handleRedirectPromise();
  if (redirectResp) {
    currentAccount = redirectResp.account;
  } else {
    const accounts = msalInstance.getAllAccounts();
    if (accounts.length > 0) currentAccount = accounts[0];
  }

  if (currentAccount) {
    await acquireToken();
  }

  updateAuthUI();
  return !!currentAccount;
}

async function acquireToken() {
  if (!msalInstance || !currentAccount) return null;
  try {
    const resp = await msalInstance.acquireTokenSilent({
      scopes: [`${msalInstance.getConfiguration().auth.clientId}/.default`],
      account: currentAccount,
    });
    accessToken = resp.accessToken || resp.idToken;
    return accessToken;
  } catch {
    try {
      const resp = await msalInstance.acquireTokenPopup({
        scopes: [`${msalInstance.getConfiguration().auth.clientId}/.default`],
        account: currentAccount,
      });
      accessToken = resp.accessToken || resp.idToken;
      return accessToken;
    } catch (err) {
      console.error("[auth] Token acquisition failed:", err);
      return null;
    }
  }
}

async function signIn() {
  if (!msalInstance) return;
  try {
    // Mobile browsers block popups — use redirect flow instead
    if (/Mobi|Android/i.test(navigator.userAgent)) {
      await msalInstance.loginRedirect({ scopes: ["User.Read"] });
      return; // page will redirect
    }
    const resp = await msalInstance.loginPopup({
      scopes: ["User.Read"],
    });
    currentAccount = resp.account;
    await acquireToken();
    updateAuthUI();
    connectWebSocket();
  } catch (err) {
    console.error("[auth] Sign-in failed:", err);
  }
}

function signOut() {
  if (!msalInstance) return;
  msalInstance.logoutPopup({ account: currentAccount });
  currentAccount = null;
  accessToken = null;
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  ws = null;
  updateAuthUI();
}

function updateAuthUI() {
  if (!authEnabled) {
    // Auth not configured — hide all auth UI, show terminal
    topbarSignInBtn.classList.add("hidden");
    topbarSignOutBtn.classList.add("hidden");
    topbarUser.textContent = "";
    signedOutScreen.classList.add("hidden");
    return;
  }

  const signedIn = !!currentAccount;
  topbarSignInBtn.classList.toggle("hidden", signedIn);
  topbarSignOutBtn.classList.toggle("hidden", !signedIn);
  if (signedIn) {
    const name = currentAccount.name || currentAccount.username || "";
    const email = currentAccount.username || currentAccount.idTokenClaims?.preferred_username || "";
    topbarUser.textContent = email && email !== name ? `${name} (${email})` : name;
  } else {
    topbarUser.textContent = "";
  }
  signedOutScreen.classList.toggle("hidden", signedIn);

  // Hide overlay + terminal when signed out, show signed-out screen
  if (!signedIn) {
    overlayEl.classList.add("hidden");
    container.style.visibility = "hidden";
  } else {
    container.style.visibility = "visible";
  }
}

// Expose for onclick handlers in HTML
window.__portalSignIn = signIn;
window.__portalSignOut = signOut;

const THEME_STORAGE_KEY = "pilotswarm.portal.theme";
const FONT_FAMILY = "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace";
const THEMES = listThemes();

function readStoredThemeId() {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredThemeId(themeId) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, themeId);
  } catch {}
}

function resolveInitialTheme() {
  const storedThemeId = readStoredThemeId();
  return getTheme(storedThemeId) || getTheme(DEFAULT_THEME_ID) || THEMES[0];
}

function setThemeCssVariable(name, value) {
  document.documentElement.style.setProperty(name, value);
}

function applyDocumentTheme(theme) {
  const page = theme.page;
  setThemeCssVariable("--app-background", page.background);
  setThemeCssVariable("--app-foreground", page.foreground);
  setThemeCssVariable("--overlay-background", page.overlayBackground);
  setThemeCssVariable("--overlay-foreground", page.overlayForeground);
  setThemeCssVariable("--hint-color", page.hintColor);
  setThemeCssVariable("--modal-backdrop", page.modalBackdrop);
  setThemeCssVariable("--modal-background", page.modalBackground);
  setThemeCssVariable("--modal-border", page.modalBorder);
  setThemeCssVariable("--modal-foreground", page.modalForeground);
  setThemeCssVariable("--modal-muted", page.modalMuted);
  setThemeCssVariable("--modal-selected-background", page.modalSelectedBackground);
  setThemeCssVariable("--modal-selected-border", page.modalSelectedBorder);
  setThemeCssVariable("--modal-selected-foreground", page.modalSelectedForeground);
}

const overlayEl = document.getElementById("overlay");
const dotsEl = document.getElementById("dots");
const modalBackdropEl = document.getElementById("theme-modal-backdrop");
const modalOptionsEl = document.getElementById("theme-options");
const modalTitleEl = document.getElementById("theme-modal-title");

let currentTheme = resolveInitialTheme();
let themeModalOpen = false;
let modalSelectedThemeId = currentTheme.id;

applyDocumentTheme(currentTheme);

const term = new Terminal({
  cursorBlink: true,
  cursorStyle: "block",
  fontFamily: FONT_FAMILY,
  fontSize: 14,
  lineHeight: 1.1,
  macOptionIsMeta: true,
  allowProposedApi: true,
  theme: { ...currentTheme.terminal },
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon());

const container = document.getElementById("terminal");
term.open(container);

// ── WebSocket (created after auth) ──────────────────────────────
let ws = null;

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws`;

  // Pass token via sub-protocol if auth is enabled
  if (authEnabled && accessToken) {
    ws = new WebSocket(url, ["access_token", accessToken]);
  } else {
    ws = new WebSocket(url);
  }

  ws.onopen = () => {
    overlayEl.classList.add("hidden");
    // Re-fit now that layout is fully resolved, then send accurate dimensions
    fitAddon.fit();
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "output") {
        term.write(message.data);
      } else if (message.type === "exit") {
        term.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
      }
    } catch {}
  };

  ws.onclose = (ev) => {
    if (ev.code === 4401) {
      // Auth rejected — show signed-out state
      currentAccount = null;
      accessToken = null;
      updateAuthUI();
      return;
    }
    term.write("\r\n\x1b[90m[Disconnected - reload to reconnect]\x1b[0m\r\n");
  };
}

term.onData((data) => {
  if (themeModalOpen) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "input", data }));
  }
});

term.onBinary((data) => {
  if (themeModalOpen) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "input", data }));
  }
});

window.addEventListener("resize", () => {
  fitAddon.fit();
});

term.onResize(({ cols, rows }) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }
});

let dotCount = 0;
const dotInterval = window.setInterval(() => {
  dotCount = (dotCount + 1) % 4;
  dotsEl.textContent = ".".repeat(dotCount || 1);
  if (ws && ws.readyState === WebSocket.OPEN) {
    window.clearInterval(dotInterval);
  }
}, 400);

// ── Boot: auth then connect ─────────────────────────────────────
(async () => {
  const signedIn = await initAuth();
  if (!authEnabled || signedIn) {
    // Wait for layout to settle before fitting + connecting
    requestAnimationFrame(() => {
      fitAddon.fit();
      term.focus();
      connectWebSocket();
    });
  }
})();

function renderThemeOptions() {
  modalOptionsEl.replaceChildren();

  for (const theme of THEMES) {
    const optionEl = document.createElement("button");
    optionEl.type = "button";
    optionEl.className = "theme-option";
    if (theme.id === modalSelectedThemeId) optionEl.classList.add("is-selected");

    const titleRowEl = document.createElement("div");
    titleRowEl.className = "theme-option-title-row";

    const titleEl = document.createElement("span");
    titleEl.className = "theme-option-title";
    titleEl.textContent = theme.label;
    titleRowEl.appendChild(titleEl);

    if (theme.id === currentTheme.id) {
      const currentEl = document.createElement("span");
      currentEl.className = "theme-option-current";
      currentEl.textContent = "Current";
      titleRowEl.appendChild(currentEl);
    }

    const descriptionEl = document.createElement("div");
    descriptionEl.className = "theme-option-description";
    descriptionEl.textContent = theme.description;

    const swatchesEl = document.createElement("div");
    swatchesEl.className = "theme-option-swatches";
    for (const color of [
      theme.terminal.background,
      theme.terminal.blue,
      theme.terminal.green,
      theme.terminal.magenta,
      theme.terminal.yellow,
    ]) {
      const swatchEl = document.createElement("span");
      swatchEl.className = "theme-swatch";
      swatchEl.style.backgroundColor = color;
      swatchesEl.appendChild(swatchEl);
    }

    optionEl.append(titleRowEl, descriptionEl, swatchesEl);
    optionEl.addEventListener("click", () => {
      modalSelectedThemeId = theme.id;
      renderThemeOptions();
      applySelectedTheme();
    });
    modalOptionsEl.appendChild(optionEl);
  }
}

function moveThemeSelection(delta) {
  const currentIndex = THEMES.findIndex((theme) => theme.id === modalSelectedThemeId);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeIndex + delta + THEMES.length) % THEMES.length;
  modalSelectedThemeId = THEMES[nextIndex].id;
  renderThemeOptions();
  // Scroll selected option into view
  const selected = modalOptionsEl.querySelector(".is-selected");
  if (selected) selected.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function applyTheme(themeId, { persist = true } = {}) {
  const nextTheme = getTheme(themeId);
  if (!nextTheme) return;
  currentTheme = nextTheme;
  modalSelectedThemeId = nextTheme.id;
  applyDocumentTheme(nextTheme);
  term.options.theme = { ...nextTheme.terminal };
  if (typeof term.clearTextureAtlas === "function") term.clearTextureAtlas();
  term.refresh(0, term.rows - 1);
  if (persist) writeStoredThemeId(nextTheme.id);
  renderThemeOptions();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "theme", themeId: nextTheme.id }));
  }
}

function openThemeModal() {
  themeModalOpen = true;
  modalSelectedThemeId = currentTheme.id;
  modalTitleEl.textContent = "Theme Picker";
  renderThemeOptions();
  modalBackdropEl.classList.remove("hidden");
  modalBackdropEl.setAttribute("aria-hidden", "false");
}

function closeThemeModal() {
  themeModalOpen = false;
  modalBackdropEl.classList.add("hidden");
  modalBackdropEl.setAttribute("aria-hidden", "true");
  term.focus();
}

function applySelectedTheme() {
  applyTheme(modalSelectedThemeId);
  closeThemeModal();
}

modalBackdropEl.addEventListener("click", (event) => {
  if (event.target === modalBackdropEl) {
    closeThemeModal();
  }
});

window.addEventListener("keydown", (event) => {
  const toggleThemeModal = event.shiftKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey
    && event.code === "KeyT";

  if (toggleThemeModal) {
    event.preventDefault();
    event.stopPropagation();
    if (themeModalOpen) {
      closeThemeModal();
    } else {
      openThemeModal();
    }
    return;
  }

  if (!themeModalOpen) return;

  event.preventDefault();
  event.stopPropagation();

  if (event.key === "Escape") {
    closeThemeModal();
    return;
  }
  if (event.key === "Enter") {
    applySelectedTheme();
    return;
  }
  if (event.key === "ArrowUp" || event.key === "k" || event.key === "K") {
    moveThemeSelection(-1);
    return;
  }
  if (event.key === "ArrowDown" || event.key === "j" || event.key === "J") {
    moveThemeSelection(1);
    return;
  }
  if (event.key === "Home" || event.key === "g") {
    modalSelectedThemeId = THEMES[0].id;
    renderThemeOptions();
    return;
  }
  if (event.key === "End" || event.key === "G") {
    modalSelectedThemeId = THEMES[THEMES.length - 1].id;
    renderThemeOptions();
  }
}, true);
