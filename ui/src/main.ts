import "@fontsource-variable/inter";
import "./styles.css";
import "./features.css";
import "./login.css";

import { ApiError, accountLabel, api, events, keyId, keyOf, parseAccountLine, type AccountView, type Key, type OtherAccountView, type OtherPlatform, type Release, type RiotGame, type Schedule, type Settings, type SteamAccountView } from "./api";
import { openLoginOverlay, type LoginOverlay } from "./login";
import { LANGUAGES, applyStatic, errorText, lang, localizeRank, setLang, t, tierName, type Lang, type MessageKey } from "./i18n";
import { $, closeMenu, contextMenu, esc, fragment, leave, modal, reducedMotion, toast } from "./dom";
import { hydrateIcons, icon } from "./icons";
import {
  APEX,
  TIER_ORDER,
  canPlayWith,
  compareRanks,
  emblem,
  installEmblemDefs,
  isRanked,
  lpProgress,
  normalizeTier,
  palette,
  rankLabel,
  rankOf,
  type Mode,
} from "./ranks";

const launchStartedAt = performance.now();
const minimumLaunchMs = 1500;

async function finishLaunch(): Promise<void> {
  if (!IN_TAURI && import.meta.env.DEV && new URLSearchParams(location.search).get("scene") === "launch") return;
  const remaining = Math.max(0, minimumLaunchMs - (performance.now() - launchStartedAt));
  if (remaining) await new Promise((resolve) => setTimeout(resolve, remaining));
  const splash = document.getElementById("launch-splash");
  document.body.classList.add("ready");
  splash?.classList.add("is-leaving");
  await new Promise((resolve) => setTimeout(resolve, 520));
  splash?.remove();
}

type View = "grid" | "list";
type Sort = "rank" | "name" | "level" | "region";
type Vault = "riot" | "steam" | "others";

const state = {
  accounts: [] as AccountView[],
  steamAccounts: [] as SteamAccountView[],
  steamClientFound: false,
  otherAccounts: [] as OtherAccountView[],
  vault: "riot" as Vault,
  riotGame: "lol" as RiotGame,
  otherPlatform: "epic" as OtherPlatform,
  regions: [] as string[],
  mode: "lol" as Mode,
  view: "grid" as View,
  sort: "rank" as Sort,
  search: "",
  regionFilter: "all",
  friendTier: "all",
  friendDivision: "I",
  tierFilter: null as string | null,
  selected: null as string | null,
  pending: new Set<string>(),
  refreshing: false,
  refreshTotal: 0,
  refreshDone: 0,
  copyStage: { id: "", count: 0 },
  settings: null as Settings | null,
  schedule: null as Schedule | null,
};

// ---------------------------------------------------------------- preferences

const PREFS_KEY = "morphwrld.riftvault.prefs";

function loadPrefs(): void {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    if (prefs.mode === "lol" || prefs.mode === "tft") state.mode = prefs.mode;
    if (prefs.vault === "riot" || prefs.vault === "steam" || prefs.vault === "others") state.vault = prefs.vault;
    if (prefs.riotGame === "lol" || prefs.riotGame === "tft" || prefs.riotGame === "valorant") state.riotGame = prefs.riotGame;
    else state.riotGame = state.mode;
    if (state.riotGame !== "valorant") state.mode = state.riotGame;
    if (prefs.otherPlatform === "epic" || prefs.otherPlatform === "ea") state.otherPlatform = prefs.otherPlatform;
    if (prefs.view === "grid" || prefs.view === "list") state.view = prefs.view;
    if (["rank", "name", "level", "region"].includes(prefs.sort)) state.sort = prefs.sort;
  } catch {
    // Storage unavailable: keep defaults.
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: state.mode, vault: state.vault, riotGame: state.riotGame, otherPlatform: state.otherPlatform, view: state.view, sort: state.sort }));
  } catch {
    // Non-essential.
  }
}

// ---------------------------------------------------------------- helpers

const byId = (id: string) => state.accounts.find((account) => keyId(keyOf(account)) === id);
const steamKey = (account: SteamAccountView) => `steam:${account.username.toLowerCase()}`;
const bySteamId = (id: string) => state.steamAccounts.find((account) => steamKey(account) === id);
const otherKey = (account: OtherAccountView) => `other:${account.platform}:${account.username.toLowerCase()}`;
const byOtherId = (id: string) => state.otherAccounts.find((account) => otherKey(account) === id);

function splitRiotId(name: string): [string, string] {
  const index = name.lastIndexOf("#");
  return index < 0 ? [name.trim(), ""] : [name.slice(0, index).trim(), name.slice(index + 1).trim()];
}

function riotAccountsFor(game: RiotGame = state.riotGame): AccountView[] {
  return state.accounts.filter((account) => (account.games?.length ? account.games : ["lol"]).includes(game));
}

function visibleAccounts(): AccountView[] {
  const query = state.search.trim().toLowerCase();
  const list = riotAccountsFor().filter((account) => {
    const rank = rankOf(account, state.mode);
    if (query && !`${account.name} ${account.accountId} ${account.description}`.toLowerCase().includes(query)) {
      return false;
    }
    if (state.regionFilter !== "all" && account.regionDisplay !== state.regionFilter) return false;
    if (state.riotGame !== "valorant" && state.tierFilter && normalizeTier(rank.tier) !== state.tierFilter) return false;
    if (state.riotGame === "lol" && state.friendTier !== "all") {
      return canPlayWith(rank, state.friendTier, state.friendDivision);
    }
    return true;
  });
  const byName = (a: AccountView, b: AccountView) => accountLabel(a).localeCompare(accountLabel(b), "tr");
  const sorters: Record<Sort, (a: AccountView, b: AccountView) => number> = {
    rank: (a, b) => state.riotGame === "valorant" ? byName(a, b) : compareRanks(rankOf(a, state.mode), rankOf(b, state.mode)) || byName(a, b),
    name: byName,
    level: (a, b) => (Number(b.level) || 0) - (Number(a.level) || 0) || byName(a, b),
    region: (a, b) => a.regionDisplay.localeCompare(b.regionDisplay) || byName(a, b),
  };
  return list.sort(sorters[state.sort]);
}

// ---------------------------------------------------------------- card rendering

function historyLine(account: AccountView): string {
  if (state.mode === "tft") {
    return `<span>${t("card.lastSet")}</span><b>${esc(localizeRank(account.tft.lastSet))}</b>`;
  }
  const reached = account.lol.reachedLastSeason || "N/A";
  return `<span>${t("card.lastSeason")}</span><b>${esc(localizeRank(reached))}</b>`;
}

function cardSignature(account: AccountView, pending: boolean): string {
  return JSON.stringify([account, state.mode, state.riotGame, pending, lang()]);
}

function profileAvatar(account: AccountView): string {
  const [gameName] = splitRiotId(accountLabel(account));
  const fallback = gameName.trim().charAt(0).toUpperCase() || "?";
  const image = account.profileIconUrl
    ? `<img class="profile-avatar-image" src="${esc(account.profileIconUrl)}" alt="" />`
    : "";
  return `<span class="profile-avatar" aria-hidden="true"><span class="profile-avatar-fallback">${esc(fallback)}</span>${image}</span>`;
}

function cardInner(account: AccountView, pending: boolean): string {
  const rank = rankOf(account, state.mode);
  const tier = normalizeTier(rank.tier);
  const valorant = state.riotGame === "valorant";
  const [gameName, tag] = splitRiotId(accountLabel(account));
  const lp = isRanked(rank) && rank.lp ? `<span class="lp">${esc(rank.lp)} LP</span>` : "";
  return `
    <div class="card-sheen"></div>
    <div class="card-top account-cell">
      <div class="emblem-wrap">${profileAvatar(account)}</div>
      <div class="identity">
        <div class="name" title="${esc(accountLabel(account))}">
          <span class="game-name">${esc(gameName)}</span>${tag ? `<span class="tag">#${esc(tag)}</span>` : ""}
        </div>
        <div class="meta">
          ${account.level ? `<span class="chip">Lv ${esc(account.level)}</span>` : ""}
          ${account.description ? `<span class="row-description">${esc(account.description)}</span>` : ""}
        </div>
      </div>
    </div>
    <div class="region-cell"><span class="chip chip-region">${esc(account.regionDisplay)}</span></div>
    <div class="account-id-cell" title="${esc(t("card.accountId"))}">${esc(account.accountId)}</div>
    <div class="rank-block${pending ? " is-pending" : ""}">
      ${valorant ? `<span class="valorant-mini">V</span><div class="rank-copy"><span class="rank-name valorant-rank">VALORANT</span><div class="valorant-sub">Riot account</div></div>` : !account.name || account.riotIdNotFound ? `
      <div class="rank-copy"><div class="rank-notice${account.riotIdNotFound ? " rank-not-found" : ""}">${esc(t(account.name ? "card.riotIdNotFound" : "card.noRiotId"))}</div>
      <button class="rank-edit" data-act="edit">${esc(t(account.name ? "card.updateRiotId" : "card.addRiotId"))}</button></div>` : `
      <span class="rank-mini-emblem">${emblem(tier, 28)}</span>
      <div class="rank-copy">
        <span class="rank-name">${esc(rankLabel(rank))}</span>
        <div class="lp-bar${APEX.has(tier) ? " apex" : ""}"><span style="--p:${lpProgress(rank)}"></span></div>
        <div class="history">${historyLine(account)}</div>
      </div>
      `}
    </div>
    <div class="lp-cell">${valorant ? '<span class="valorant-ready"><span class="local-dot"></span> Ready</span>' : lp || "—"}</div>
    <div class="card-actions">
      <button class="btn btn-play" data-act="login" title="${esc(t("card.loginTitle"))}">${esc(t("card.login"))}</button>
      <button class="icon-btn card-more" data-act="menu" title="${esc(t("card.more"))}">${icon("more")}</button>
    </div>`;
}

function updateCard(element: HTMLElement, account: AccountView): void {
  const id = keyId(keyOf(account));
  const pending = state.pending.has(id);
  const signature = cardSignature(account, pending);
  const colors = state.riotGame === "valorant"
    ? { base: "#ff4655", light: "#ff8993", dark: "#641d27" }
    : palette(rankOf(account, state.mode).tier);
  element.style.setProperty("--tier", colors.base);
  element.style.setProperty("--tier-light", colors.light);
  element.style.setProperty("--tier-dark", colors.dark);
  element.classList.toggle("selected", state.selected === id);
  element.classList.toggle("apex", state.riotGame !== "valorant" && APEX.has(normalizeTier(rankOf(account, state.mode).tier)));
  element.classList.toggle("valorant-card", state.riotGame === "valorant");
  if (element.dataset.signature === signature) return;
  const wasPending = element.dataset.pending === "1";
  element.dataset.signature = signature;
  element.dataset.pending = pending ? "1" : "0";
  element.innerHTML = cardInner(account, pending);
  element.querySelectorAll<HTMLImageElement>(".profile-avatar-image").forEach((image) => {
    image.addEventListener("error", () => image.remove(), { once: true });
  });
  if (wasPending && !pending && !reducedMotion()) {
    element.classList.remove("rank-arrived");
    void element.offsetWidth;
    element.classList.add("rank-arrived");
  }
}

let firstRender = true;

function visibleSteamAccounts(): SteamAccountView[] {
  const query = state.search.trim().toLowerCase();
  return state.steamAccounts
    .filter((account) => !query || `${account.displayName} ${account.username} ${account.steamId} ${account.description}`.toLowerCase().includes(query))
    .sort((a, b) => (a.displayName || a.username).localeCompare(b.displayName || b.username));
}

function steamCardInner(account: SteamAccountView): string {
  const label = account.displayName || account.username;
  const initial = label.trim().charAt(0).toUpperCase() || "S";
  return `
    <div class="card-top account-cell">
      <div class="steam-avatar" aria-hidden="true">${esc(initial)}</div>
      <div class="identity">
        <div class="name" title="${esc(label)}"><span class="game-name">${esc(label)}</span></div>
        <div class="meta">${account.description ? `<span class="row-description">${esc(account.description)}</span>` : ""}</div>
      </div>
    </div>
    <div class="region-cell"><span class="steam-platform">${icon("gamepad", 15)} Steam</span></div>
    <div class="account-id-cell" title="Steam login name">${esc(account.username)}</div>
    <div class="steam-id-cell">${account.steamId ? esc(account.steamId) : "—"}</div>
    <div class="steam-security"><span class="local-dot"></span>${account.hasPassword ? "Secured" : "Missing"}</div>
    <div class="card-actions">
      <button class="btn btn-play" data-act="steam-login">Log in</button>
      <button class="icon-btn card-more" data-act="steam-menu" title="More">${icon("more")}</button>
    </div>`;
}

function renderSteamAccounts(): void {
  const container = $("#accounts");
  const list = visibleSteamAccounts();
  $("#vault-visible").textContent = String(list.length);
  $("#vault-total").textContent = String(state.steamAccounts.length);
  $("#vault-mode").textContent = "STEAM";
  container.innerHTML = list
    .map((account, index) => `<article class="card steam-card enter-stagger" data-key="${esc(steamKey(account))}" tabindex="0" style="--i:${Math.min(index, 14)}">${steamCardInner(account)}</article>`)
    .join("");
  const empty = $("#empty");
  empty.hidden = list.length > 0;
  if (!list.length) {
    const noAccounts = state.steamAccounts.length === 0;
    empty.innerHTML = `
      <div class="empty-art steam-empty">${icon("gamepad", 42)}</div>
      <h2>${noAccounts ? "No Steam accounts yet" : "No matching Steam accounts"}</h2>
      <p>${noAccounts ? "Add an account to keep it in your encrypted local vault." : "Try another search."}</p>
      <button class="btn btn-primary" data-empty="${noAccounts ? "add" : "clear"}">${icon(noAccounts ? "plus" : "x")} ${noAccounts ? "Add Steam account" : "Clear search"}</button>`;
  }
}

const otherPlatformName = (platform: OtherPlatform): string => platform === "epic" ? "Epic Games" : "EA app / Origin";
const otherPlatformMark = (platform: OtherPlatform): string => platform === "epic" ? "E" : "EA";

function visibleOtherAccounts(): OtherAccountView[] {
  const query = state.search.trim().toLowerCase();
  return state.otherAccounts
    .filter((account) => account.platform === state.otherPlatform)
    .filter((account) => !query || `${account.displayName} ${account.username} ${account.description}`.toLowerCase().includes(query))
    .sort((a, b) => (a.displayName || a.username).localeCompare(b.displayName || b.username));
}

function otherCardInner(account: OtherAccountView): string {
  const label = account.displayName || account.username;
  const platform = otherPlatformName(account.platform);
  return `
    <div class="card-top account-cell">
      <div class="steam-avatar other-avatar ${account.platform}" aria-hidden="true">${otherPlatformMark(account.platform)}</div>
      <div class="identity">
        <div class="name" title="${esc(label)}"><span class="game-name">${esc(label)}</span></div>
        <div class="meta">${account.description ? `<span class="row-description">${esc(account.description)}</span>` : ""}</div>
      </div>
    </div>
    <div class="region-cell"><span class="steam-platform other-platform-chip">${esc(platform)}</span></div>
    <div class="account-id-cell" title="${esc(platform)} login">${esc(account.username)}</div>
    <div class="steam-id-cell">${esc(platform)}</div>
    <div class="steam-security"><span class="local-dot"></span>${account.hasPassword ? "Secured" : "Missing"}</div>
    <div class="card-actions">
      <button class="btn btn-play" data-act="other-launch">Open client</button>
      <button class="icon-btn card-more" data-act="other-menu" title="More">${icon("more")}</button>
    </div>`;
}

function renderOtherAccounts(): void {
  const container = $("#accounts");
  const list = visibleOtherAccounts();
  const total = state.otherAccounts.filter((account) => account.platform === state.otherPlatform).length;
  $("#vault-visible").textContent = String(list.length);
  $("#vault-total").textContent = String(total);
  $("#vault-mode").textContent = state.otherPlatform === "epic" ? "EPIC" : "EA APP";
  container.innerHTML = list
    .map((account, index) => `<article class="card steam-card other-card enter-stagger" data-key="${esc(otherKey(account))}" tabindex="0" style="--i:${Math.min(index, 14)}">${otherCardInner(account)}</article>`)
    .join("");
  const empty = $("#empty");
  empty.hidden = list.length > 0;
  if (!list.length) {
    const platform = otherPlatformName(state.otherPlatform);
    empty.innerHTML = `
      <div class="empty-art steam-empty other-empty">${icon("gamepad", 42)}</div>
      <h2>${total ? `No matching ${esc(platform)} accounts` : `No ${esc(platform)} accounts yet`}</h2>
      <p>${total ? "Try another search." : "Add an account to keep it in your secure local vault."}</p>
      <button class="btn btn-primary" data-empty="${total ? "clear" : "add"}">${icon(total ? "x" : "plus")} ${total ? "Clear search" : `Add ${esc(platform)} account`}</button>`;
  }
}

function renderAccounts(): void {
  if (state.vault === "steam") {
    renderSteamAccounts();
    return;
  }
  if (state.vault === "others") {
    renderOtherAccounts();
    return;
  }
  const container = $("#accounts");
  const list = visibleAccounts();
  const gameAccounts = riotAccountsFor();
  $("#vault-visible").textContent = String(list.length);
  $("#vault-total").textContent = String(gameAccounts.length);
  $("#vault-mode").textContent = state.riotGame === "lol" ? "LEAGUE" : state.riotGame === "tft" ? "TACTICS" : "VALORANT";
  const existing = new Map<string, HTMLElement>();
  container.querySelectorAll<HTMLElement>(":scope > .card").forEach((element) => {
    existing.set(element.dataset.key ?? "", element);
  });

  // FLIP: remember where every card was before reordering.
  const before = new Map<string, DOMRect>();
  if (!reducedMotion()) existing.forEach((element, id) => before.set(id, element.getBoundingClientRect()));

  const wanted = new Set(list.map((account) => keyId(keyOf(account))));
  existing.forEach((element, id) => {
    if (!wanted.has(id)) element.remove();
  });

  let entering = 0;
  list.forEach((account, index) => {
    const id = keyId(keyOf(account));
    let element = existing.get(id);
    if (!element) {
      element = document.createElement("article");
      element.className = "card";
      element.dataset.key = id;
      element.tabIndex = 0;
      element.style.setProperty("--i", String(Math.min(entering++, 14)));
      element.classList.add(firstRender ? "enter-stagger" : "enter");
      element.addEventListener("animationend", (event) => {
        if (event.target === element) element?.classList.remove("enter", "enter-stagger");
      });
    }
    updateCard(element, account);
    if (container.children[index] !== element) container.insertBefore(element, container.children[index] ?? null);
  });

  if (!reducedMotion()) {
    container.querySelectorAll<HTMLElement>(":scope > .card").forEach((element) => {
      const old = before.get(element.dataset.key ?? "");
      if (!old) return;
      const now = element.getBoundingClientRect();
      const dx = old.left - now.left;
      const dy = old.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      element.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    });
  }
  firstRender = false;

  const empty = $("#empty");
  empty.hidden = list.length > 0;
  if (!list.length) {
    const noAccounts = gameAccounts.length === 0;
    empty.innerHTML = `
      <div class="empty-art">${emblem(noAccounts ? "Unranked" : "Iron", 88)}</div>
      <h2>${t(noAccounts ? "empty.noneTitle" : "empty.noMatchTitle")}</h2>
      <p>${t(noAccounts ? "empty.noneText" : "empty.noMatchText")}</p>
      ${
        noAccounts
          ? `<button class="btn btn-primary" data-empty="add">${icon("plus")} ${t("side.add")}</button>`
          : `<button class="btn btn-ghost" data-empty="clear">${icon("x")} ${t("empty.clear")}</button>`
      }`;
  }
}

// ---------------------------------------------------------------- sidebar

function renderDistribution(): void {
  if (state.vault === "steam" || state.riotGame === "valorant") {
    $("#distribution").innerHTML = "";
    return;
  }
  const counts = new Map<string, number>();
  riotAccountsFor().forEach((account) => {
    const tier = normalizeTier(rankOf(account, state.mode).tier);
    counts.set(tier, (counts.get(tier) ?? 0) + 1);
  });
  const tiers = TIER_ORDER.filter((tier) => counts.get(tier) || (tier !== "Error" && tier !== "Unranked"));
  const max = Math.max(1, ...counts.values());
  const root = $("#distribution");
  root.innerHTML = tiers
    .map((tier) => {
      const count = counts.get(tier) ?? 0;
      const colors = palette(tier);
      const active = state.tierFilter === tier;
      return `<button class="dist-row${active ? " active" : ""}${count ? "" : " zero"}" data-tier="${tier}" style="--tier:${colors.base};--w:${count / max}" ${count ? "" : "disabled"}>
        <span class="dist-emblem">${emblem(tier, 20)}</span>
        <span class="dist-name">${tierName(tier)}</span>
        <span class="dist-bar"><span></span></span>
        <span class="dist-count">${count}</span>
      </button>`;
    })
    .join("");
}

function renderControls(): void {
  document.documentElement.dataset.mode = state.mode;
  document.documentElement.dataset.service = state.vault;
  document.documentElement.dataset.riotGame = state.riotGame;
  document.querySelectorAll<HTMLButtonElement>("[data-platform]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.platform === state.vault));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-riot-game]").forEach((button) => {
    button.setAttribute("aria-current", String(button.dataset.riotGame === state.riotGame));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-other-platform]").forEach((button) => {
    button.setAttribute("aria-current", String(button.dataset.otherPlatform === state.otherPlatform));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view);
  });
  const accounts = $("#accounts");
  accounts.classList.toggle("grid", state.view === "grid");
  accounts.classList.toggle("list", state.view === "list");
  const riot = state.vault === "riot";
  $("#region-wrap").classList.toggle("collapsed", !riot);
  $("#friend-wrap").classList.toggle("collapsed", !riot || state.riotGame !== "lol");
  $("#sort-wrap").classList.toggle("collapsed", !riot || state.riotGame === "valorant");
  $<HTMLSelectElement>("#sort").value = state.sort;
  const steam = state.vault === "steam";
  const others = state.vault === "others";
  const otherName = otherPlatformName(state.otherPlatform);
  $("#vault-title").textContent = steam ? "Steam Vault" : others ? `${otherName} Vault` : "Riot Vault";
  $("#vault-subtitle").textContent = steam
    ? "Secure local Steam accounts"
    : others ? `Secure local ${otherName} accounts`
    : state.riotGame === "lol" ? "League of Legends accounts" : state.riotGame === "tft" ? "Teamfight Tactics accounts" : "VALORANT accounts";
  $("#head-region").textContent = riot ? "Region" : "Platform";
  $("#head-id").textContent = riot ? "Account ID" : "Login name";
  $("#head-rank").textContent = steam ? "Steam ID" : others ? "Client" : state.riotGame === "valorant" ? "Game" : "Rank";
  $("#head-lp").textContent = riot ? (state.riotGame === "valorant" ? "Status" : "LP") : "Security";
  $<HTMLInputElement>("#search").placeholder = steam ? "Search display name, login name or Steam ID…" : others ? `Search ${otherName} accounts…` : t("toolbar.search");
  $("#open-add span:last-child").textContent = steam ? "Add Steam account" : others ? `Add ${otherName} account` : "Add Riot account";
}

function render(): void {
  if (state.vault === "riot") populateRegions();
  renderSchedule();
  renderControls();
  renderAccounts();
  renderDistribution();
}

// ---------------------------------------------------------------- actions

function upsert(account: AccountView): void {
  const id = keyId(keyOf(account));
  const index = state.accounts.findIndex((candidate) => keyId(keyOf(candidate)) === id);
  if (index >= 0) state.accounts[index] = account;
  else state.accounts.push(account);
}

const describe = (error: unknown): string => {
  if (error instanceof ApiError) {
    const steamErrors: Record<string, string> = {
      steam_missing: "Steam is not installed in a detected location.",
      steam_launch_failed: "Steam could not be launched.",
      steam_load_failed: "Steam accounts could not be loaded.",
      steam_save_failed: "Steam accounts could not be saved.",
      other_client_missing: "This launcher was not found in a standard installation location.",
      other_launch_failed: "The selected launcher could not be opened.",
      other_load_failed: "Platform accounts could not be loaded.",
      other_save_failed: "Platform accounts could not be saved.",
      unsupported_platform: "This platform is not supported yet.",
      valorant_missing: "VALORANT is not installed on this PC.",
    };
    return steamErrors[error.code] ?? errorText(error.code, error.detail);
  }
  return errorText("unknown", String(error));
};

async function guard<T>(work: () => Promise<T>, failTitle: MessageKey): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    toast("error", t(failTitle), describe(error), 5000);
    return undefined;
  }
}

async function copyId(account: AccountView): Promise<void> {
  if ((await guard(() => api.copyAccountId(keyOf(account)), "toast.copyFailed")) !== undefined) {
    toast("success", t("toast.idCopied"), account.accountId);
  }
}

async function copyPassword(account: AccountView): Promise<void> {
  const ttl = await guard(() => api.copyPassword(keyOf(account)), "toast.passFailed");
  if (ttl !== undefined) toast("success", t("toast.passCopied"), t("toast.passCopiedText", { seconds: ttl }));
}

let loginBusy = false;
let activeLogin: LoginOverlay | null = null;

/** Ask before closing an open League client/match that belongs to another account. */
async function confirmCloseLeague(account: AccountView, inGame: boolean): Promise<boolean> {
  const valorant = state.riotGame === "valorant";
  const answer = await modal({
    title: valorant ? (inGame ? "VALORANT is running" : "A Riot game is open") : t(inGame ? "login.inGameTitle" : "login.closeTitle"),
    body: `<div class="warning${inGame ? " danger" : ""}">${icon("alert", 18)}<p>${esc(valorant
      ? inGame ? `VALORANT may be in a live match. Closing it can cause penalties. Close it and sign in as ${accountLabel(account)}?` : `The open Riot game must close before switching to ${accountLabel(account)}.`
      : t(inGame ? "login.inGameText" : "login.closeText", { name: accountLabel(account) }),
    )}</p></div>`,
    actions: [
      { label: t("common.cancel"), value: "cancel" },
      { label: t("login.closeConfirm"), value: "close", kind: inGame ? "danger" : "primary" },
    ],
  });
  return answer === "close";
}

async function login(account: AccountView): Promise<void> {
  if (loginBusy) return;
  loginBusy = true;
  try {
    await runLogin(account);
  } finally {
    loginBusy = false;
    activeLogin = null;
  }
}

async function runLogin(account: AccountView, switchAccount = false, closeRunning = false): Promise<void> {
  const viaRiot = state.settings?.loginMethod !== "previous";
  const key = keyOf(account);

  // Never sign another account in under an open League client or match.
  if (viaRiot && !closeRunning) {
    const status = await guard(() => api.gameStatus(key), "toast.loginFailed");
    if (!status) return;
    if ((status.clientOpen || status.inGame) && !status.sameAccount) {
      if (!(await confirmCloseLeague(account, status.inGame))) return;
      return runLogin(account, true, true);
    }
  }

  const launching = Boolean(viaRiot && state.settings?.launchGame);
  const overlay = openLoginOverlay({
    account,
    tier: state.riotGame === "valorant" ? "Unranked" : rankOf(account, state.mode).tier,
    viaRiot,
    closeLeague: closeRunning,
    switchAccount,
    launchGame: launching,
    onCancel: () => void api.cancelLogin(),
  });
  activeLogin = overlay;
  try {
    const result = await api.login(key, state.riotGame, switchAccount, closeRunning);
    if (result === "signedIn") {
      overlay.succeed(t("login.success"), launching ? t("toast.launchingGame") : accountLabel(account));
    } else if (result === "alreadySignedIn") {
      overlay.succeed(t("toast.alreadySignedIn"), launching ? t("toast.launchingGame") : accountLabel(account));
    } else if (result === "typed") {
      if (viaRiot) overlay.finishInClient();
      else overlay.succeed(t("toast.loggedIn"), accountLabel(account));
    } else if (result === "otherAccount") {
      overlay.close();
      const answer = await modal({
        title: t("login.switchTitle"),
        body: `<p class="hint">${esc(t("login.switchText", { name: accountLabel(account) }))}</p>`,
        actions: [
          { label: t("common.cancel"), value: "cancel" },
          { label: t("login.switchConfirm"), value: "switch", kind: "primary" },
        ],
      });
      activeLogin = null;
      if (answer === "switch") await runLogin(account, true, closeRunning);
      return;
    }
  } catch (error) {
    if (error instanceof ApiError && error.code === "login_cancelled") {
      overlay.close();
    } else if (error instanceof ApiError && error.code === "league_running") {
      // The client was opened between the check and the login: ask again.
      overlay.close();
      activeLogin = null;
      return runLogin(account, switchAccount, false);
    } else {
      overlay.fail(describe(error));
    }
  }
}

function select(id: string | null, focus = false): void {
  state.selected = id;
  document.querySelectorAll<HTMLElement>("#accounts > .card").forEach((element) => {
    const selected = element.dataset.key === id;
    element.classList.toggle("selected", selected);
    if (selected && focus) {
      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    }
  });
}

const RIOT_GAME_OPTIONS: { id: RiotGame; mark: string; name: string; detail: string }[] = [
  { id: "lol", mark: "L", name: "League", detail: "League of Legends" },
  { id: "tft", mark: "T", name: "TFT", detail: "Teamfight Tactics" },
  { id: "valorant", mark: "V", name: "VALORANT", detail: "Riot tactical shooter" },
];

function gameAccessSelector(selected: RiotGame[]): string {
  return `<fieldset class="game-access">
    <legend>SHOW THIS ACCOUNT IN</legend>
    <div class="game-access-options">
      ${RIOT_GAME_OPTIONS.map((game) => `<label class="game-access-option game-${game.id}">
        <input type="checkbox" name="games" value="${game.id}"${selected.includes(game.id) ? " checked" : ""} />
        <span class="game-access-card"><b>${game.mark}</b><span><strong>${game.name}</strong><small>${game.detail}</small></span><i>${icon("check", 13)}</i></span>
      </label>`).join("")}
    </div>
    <p>Select one or more games that use this Riot login.</p>
  </fieldset>`;
}

function selectedGames(root: ParentNode): RiotGame[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>('input[name="games"]:checked'))
    .map((input) => input.value as RiotGame);
}

async function editAccount(account: AccountView): Promise<void> {
  await modal({
    title: t("edit.title"),
    body: `
      <label class="field"><span>${t("edit.riotId")} <em>${t("add.optional")}</em></span>
        <input name="name" value="${esc(account.name)}" placeholder="${esc(t("add.riotIdPh"))}" spellcheck="false" /></label>
      <label class="field"><span>${t("edit.description")}</span>
        <input name="description" value="${esc(account.description)}" placeholder="${esc(t("edit.descriptionPh"))}" /></label>
      ${gameAccessSelector(account.games?.length ? account.games : ["lol"])}
      <p class="hint">${t("edit.hint")}</p>`,
    actions: [
      { label: t("common.cancel"), value: "cancel" },
      { label: t("common.save"), value: "save", kind: "primary" },
    ],
    onSubmit: async (value, root) => {
      if (value !== "save") return true;
      const name = $<HTMLInputElement>('[name="name"]', root).value;
      const description = $<HTMLInputElement>('[name="description"]', root).value;
      const games = selectedGames(root);
      if (!games.length) {
        root.querySelector(".game-access")?.classList.add("invalid");
        shake(root);
        return false;
      }
      const updated = await guard(() => api.updateAccount(keyOf(account), name, description, games), "toast.saveFailed");
      if (!updated) return false;
      upsert(updated);
      render();
      toast("success", t("toast.updated"));
      return true;
    },
  });
}

async function deleteAccount(account: AccountView): Promise<void> {
  const answer = await modal({
    title: t("delete.title"),
    body: `
      <div class="confirm-account">
        ${emblem(rankOf(account, state.mode).tier, 44)}
        <div><strong>${esc(accountLabel(account))}</strong><span>${esc(account.accountId)} · ${esc(account.regionDisplay)}</span></div>
      </div>
      <p class="hint">${t("delete.hint")}</p>`,
    actions: [
      { label: t("common.cancel"), value: "cancel" },
      { label: t("delete.confirm"), value: "delete", kind: "danger" },
    ],
  });
  if (answer !== "delete") return;
  const id = keyId(keyOf(account));
  if ((await guard(() => api.deleteAccount(keyOf(account)), "toast.deleteFailed")) === undefined) return;
  const element = document.querySelector<HTMLElement>(`#accounts > .card[data-key="${CSS.escape(id)}"]`);
  if (element) await leave(element, "card-out");
  state.accounts = state.accounts.filter((candidate) => keyId(keyOf(candidate)) !== id);
  if (state.selected === id) state.selected = null;
  render();
  toast("success", t("toast.deleted"), accountLabel(account));
}

function openMenu(account: AccountView, x: number, y: number): void {
  select(keyId(keyOf(account)));
  contextMenu(x, y, [
    ...(account.name && state.riotGame !== "valorant" ? [{
      label: t(state.mode === "lol" ? "menu.opgg" : "menu.opggTft"),
      icon: "external-link",
      run: () => void guard(() => api.openProfile(keyOf(account), state.mode === "tft"), "toast.openFailed"),
    }] : []),
    { label: t("menu.edit"), icon: "pencil", run: () => void editAccount(account) },
    "sep",
    { label: t("menu.delete"), icon: "trash", danger: true, hint: "Del", run: () => void deleteAccount(account) },
  ], "account");
}

async function refreshAll(): Promise<void> {
  if (state.refreshing || state.schedule?.running) return;
  state.refreshing = true;
  state.refreshTotal = 0;
  state.refreshDone = 0;
  renderSchedule();
  const count = await guard(() => api.refreshRanks(), "toast.refreshFailed");
  if (count === undefined) {
    state.refreshing = false;
    renderSchedule();
    return;
  }
  state.refreshTotal = count;
  renderSchedule();
}

// ---------------------------------------------------------------- updates

const DISMISSED_UPDATE = "morphwrld.riftvault.dismissedUpdate";

function showUpdate(release: Release, force = false): void {
  try {
    if (!force && localStorage.getItem(DISMISSED_UPDATE) === release.version) return;
  } catch {
    // Storage unavailable: show it.
  }
  document.querySelector(".update-banner")?.remove();
  const banner = fragment(`
    <div class="update-banner" role="status">
      <div class="update-body">
        <strong>${esc(t("update.available"))}</strong>
        <span>${esc(t("update.text", { version: release.version }))}</span>
      </div>
      <button class="btn btn-primary" data-update="open">${icon("download", 15)}${esc(t("update.download"))}</button>
      <button class="icon-btn" data-update="later" title="${esc(t("update.later"))}">${icon("x")}</button>
    </div>`);
  $("#toasts").before(banner);
  banner.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-update]")?.dataset.update;
    if (action === "open") void guard(() => api.openRelease(release.url), "toast.openFailed");
    if (action === "later") {
      try {
        localStorage.setItem(DISMISSED_UPDATE, release.version);
      } catch {
        // Non-essential.
      }
      void leave(banner, "toast-out");
    }
  });
}

// ---------------------------------------------------------------- schedule & settings

function renderSchedule(): void {
  const root = $<HTMLButtonElement>("#schedule");
  const schedule = state.schedule;
  const running = Boolean(schedule?.running || state.refreshing);
  let text: string;
  let progress = 0;
  if (running) {
    text = state.refreshTotal
      ? t("refresh.busy", { done: state.refreshDone, total: state.refreshTotal })
      : t("schedule.running");
    progress = state.refreshTotal ? state.refreshDone / state.refreshTotal : 1;
  } else if (!schedule || !schedule.enabled) {
    text = t("schedule.off");
  } else if (schedule.nextAt) {
    const remaining = schedule.nextAt - Date.now();
    const total = schedule.intervalMinutes * 60_000;
    progress = Math.min(1, Math.max(0, 1 - remaining / total));
    if (remaining <= 30_000) {
      text = t("schedule.soon");
    } else {
      const minutes = Math.round(remaining / 60_000);
      const relative = new Intl.RelativeTimeFormat(lang(), { numeric: "auto" });
      text = t("schedule.next", {
        time: minutes >= 60 ? relative.format(Math.round(minutes / 60), "hour") : `${Math.max(1, minutes)} ${t("settings.minutes")}`,
      });
    }
  } else {
    text = t("schedule.soon");
  }
  root.classList.toggle("off", !schedule?.enabled && !running);
  root.classList.toggle("running", running);
  root.disabled = running;
  root.setAttribute("aria-busy", String(running));
  root.style.setProperty("--p", String(progress));
  $(".schedule-text", root).textContent = text;
}

async function openSettings(): Promise<void> {
  if (document.querySelector(".drawer-overlay")) return;
  const current = await guard(() => api.getSettings(), "toast.settingsFailed");
  if (!current) return;
  const languageOptions = LANGUAGES.map(
    (language) => `<option value="${language.code}"${language.code === lang() ? " selected" : ""}>${esc(language.name)}</option>`,
  ).join("");
  const toggle = (name: string, checked: boolean, label: string, hint = "", disabled = false) => `
    <label class="toggle-row${disabled ? " disabled" : ""}">
      <span class="toggle-text"><strong>${esc(label)}</strong>${hint ? `<span>${esc(hint)}</span>` : ""}</span>
      <input type="checkbox" name="${name}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}/>
      <span class="switch"></span>
    </label>`;
  const overlay = fragment(`
    <div class="drawer-overlay settings-overlay">
      <aside class="drawer settings-drawer" role="dialog" aria-modal="true" aria-label="${esc(t("settings.title"))}">
        <header class="settings-head">
          <div><h2>${esc(t("settings.title"))}</h2><p>Rift Vault preferences</p></div>
          <button class="icon-btn" data-settings-close aria-label="${esc(t("common.close"))}">${icon("x")}</button>
        </header>
        <nav class="settings-tabs" role="tablist">
          <button type="button" role="tab" data-settings-tab="general" aria-selected="true">${esc(t("settings.general"))}</button>
          <button type="button" role="tab" data-settings-tab="login" aria-selected="false">${esc(t("settings.login"))}</button>
          <button type="button" role="tab" data-settings-tab="refresh" aria-selected="false">${esc(t("settings.refresh"))}</button>
          <button type="button" role="tab" data-settings-tab="appearance" aria-selected="false">Appearance</button>
        </nav>
        <form class="settings-form" novalidate>
          <section class="settings-panel" data-settings-panel="general">
            <span class="settings-eyebrow">System</span>
            <label class="setting-select"><span>${esc(t("settings.language"))}</span><select name="language">${languageOptions}</select></label>
            ${toggle("launchAtStartup", current.launchAtStartup, t("settings.startup"), t("settings.startupHint"))}
            ${toggle("startMinimized", current.startMinimized, t("settings.minimized"), t("settings.minimizedHint"))}
          </section>
          <section class="settings-panel" data-settings-panel="login" hidden>
            <span class="settings-eyebrow">Login method</span>
            <label class="radio-row"><input type="radio" name="loginMethod" value="riot" ${current.loginMethod === "riot" ? "checked" : ""}/>
              <span class="toggle-text"><strong>${esc(t("settings.methodRiot"))}</strong><span>${esc(current.riotClientFound ? t("settings.methodRiotHint") : t("settings.clientMissing"))}</span></span></label>
            <label class="radio-row"><input type="radio" name="loginMethod" value="previous" ${current.loginMethod === "previous" ? "checked" : ""}/>
              <span class="toggle-text"><strong>${esc(t("settings.methodPrevious"))}</strong><span>${esc(t("settings.methodPreviousHint"))}</span></span></label>
            ${toggle("launchGame", current.launchGame, t("settings.launchGame"), t("settings.launchGameHint"))}
            <div class="setting-select"><span>VALORANT</span><strong class="client-state ${current.valorantInstalled ? "found" : "missing"}">${current.valorantInstalled ? "Detected" : "Not installed"}</strong></div>
            <span class="settings-eyebrow steam-settings-label">Steam integration</span>
            <div class="setting-select"><span>Steam client</span><strong class="client-state ${state.steamClientFound ? "found" : "missing"}">${state.steamClientFound ? "Detected" : "Not found"}</strong></div>
            <p class="hint">Steam credentials use Windows Credential Manager. Automatic login is intended only for your trusted personal PC and may require Steam Guard.</p>
          </section>
          <section class="settings-panel" data-settings-panel="refresh" hidden>
            <span class="settings-eyebrow">Rank data</span>
            ${toggle("autoRefresh", current.autoRefresh, t("settings.autoRefresh"))}
            <div class="setting-select interval-setting"><span>${esc(t("settings.interval"))}</span>
              <label class="interval-input"><input name="intervalMinutes" type="number" min="5" max="1440" step="5" value="${current.intervalMinutes}"/><span>${esc(t("settings.minutes"))}</span></label>
            </div>
            <p class="hint">${esc(t("settings.intervalHint", { min: 5, max: 1440 }))}</p>
          </section>
          <section class="settings-panel" data-settings-panel="appearance" hidden>
            <span class="settings-eyebrow">Theme</span>
            <label class="setting-select"><span>Interface theme</span><select><option>Obsidian</option></select></label>
            <div class="theme-preview"><span></span><div><strong>Obsidian</strong><small>Near-black surfaces · violet accent</small></div></div>
          </section>
        </form>
        <footer class="settings-foot">
          <button class="btn btn-primary" type="button" data-settings-save>${esc(t("common.save"))}</button>
          <p>${icon("info", 14)} Credentials stay in Windows Credential Manager.</p>
        </footer>
      </aside>
    </div>`);
  $("#drawer-root").append(overlay);
  const drawer = $(".settings-drawer", overlay);
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    void leave(overlay, "drawer-out");
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  const showPanel = (name: string) => {
    drawer.querySelectorAll<HTMLElement>("[data-settings-tab]").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.settingsTab === name)));
    drawer.querySelectorAll<HTMLElement>("[data-settings-panel]").forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== name; });
  };
  const interval = $<HTMLInputElement>('[name="intervalMinutes"]', drawer);
  const autoRefresh = $<HTMLInputElement>('[name="autoRefresh"]', drawer);
  const launchGame = $<HTMLInputElement>('[name="launchGame"]', drawer);
  const sync = () => {
    drawer.querySelector(".interval-setting")?.classList.toggle("disabled", !autoRefresh.checked);
    const riot = $<HTMLInputElement>('[name="loginMethod"][value="riot"]', drawer).checked;
    launchGame.disabled = !riot;
    launchGame.closest(".toggle-row")?.classList.toggle("disabled", !riot);
  };
  drawer.querySelectorAll<HTMLButtonElement>("[data-settings-tab]").forEach((tab) => tab.addEventListener("click", () => showPanel(tab.dataset.settingsTab ?? "general")));
  drawer.querySelector("[data-settings-close]")?.addEventListener("click", close);
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(); });
  drawer.addEventListener("change", sync);
  drawer.querySelector("[data-settings-save]")?.addEventListener("click", async () => {
    const checked = (name: string) => $<HTMLInputElement>(`[name="${name}"]`, drawer).checked;
    const minutes = Math.round(Number(interval.value) || 30);
    const saved = await guard(() => api.updateSettings({
      autoRefresh: checked("autoRefresh"), intervalMinutes: Math.min(1440, Math.max(5, minutes)),
      startMinimized: checked("startMinimized"), launchAtStartup: checked("launchAtStartup"),
      loginMethod: $<HTMLInputElement>('[name="loginMethod"]:checked', drawer).value as Settings["loginMethod"],
      launchGame: checked("launchGame"), checkUpdates: false,
    }), "toast.settingsFailed");
    if (!saved) return;
    state.settings = saved;
    const language = $<HTMLSelectElement>('[name="language"]', drawer).value as Lang;
    if (language !== lang()) changeLanguage(language);
    toast("success", t("settings.saved"));
    close();
  });
  document.addEventListener("keydown", onKey, true);
  sync();
}

async function copySteamUsername(account: SteamAccountView): Promise<void> {
  if ((await guard(() => api.copySteamUsername(account.username), "toast.copyFailed")) !== undefined) {
    toast("success", "Login name copied", account.username);
  }
}

async function copySteamPassword(account: SteamAccountView): Promise<void> {
  const ttl = await guard(() => api.copySteamPassword(account.username), "toast.passFailed");
  if (ttl !== undefined) toast("success", "Password copied", `Clipboard clears in ${ttl} seconds.`);
}

async function loginSteam(account: SteamAccountView): Promise<void> {
  if (!state.steamClientFound) {
    toast("error", "Steam not found", "Install Steam in its standard location or open it once so Rift Vault can detect it.");
    return;
  }
  const label = account.displayName || account.username;
  const answer = await modal({
    title: "Log in to Steam",
    body: `<div class="confirm-account steam-confirm"><div class="steam-avatar">${esc(label.charAt(0).toUpperCase() || "S")}</div><div><strong>${esc(label)}</strong><span>${esc(account.username)}</span></div></div>
      <p class="hint">Steam will close its current session and restart with this account. Steam Guard may still request approval.</p>`,
    actions: [
      { label: t("common.cancel"), value: "cancel" },
      { label: "Continue", value: "login", kind: "primary" },
    ],
  });
  if (answer !== "login") return;
  const result = await guard(() => api.steamLogin(account.username), "toast.loginFailed");
  if (result !== undefined) toast("success", "Steam launched", `Signing in as ${label}.`);
}

async function editSteamAccount(account: SteamAccountView): Promise<void> {
  await modal({
    title: "Edit Steam account",
    body: `
      <label class="field"><span>Display name</span><input name="displayName" value="${esc(account.displayName)}" placeholder="Optional label" /></label>
      <label class="field"><span>Steam ID <em>optional</em></span><input name="steamId" value="${esc(account.steamId)}" placeholder="76561198…" spellcheck="false" /></label>
      <label class="field"><span>Description <em>optional</em></span><input name="description" value="${esc(account.description)}" placeholder="Main, competitive, alt…" /></label>`,
    actions: [
      { label: t("common.cancel"), value: "cancel" },
      { label: t("common.save"), value: "save", kind: "primary" },
    ],
    onSubmit: async (value, root) => {
      if (value !== "save") return true;
      const updated = await guard(() => api.updateSteamAccount({
        username: account.username,
        displayName: $<HTMLInputElement>('[name="displayName"]', root).value,
        steamId: $<HTMLInputElement>('[name="steamId"]', root).value,
        description: $<HTMLInputElement>('[name="description"]', root).value,
      }), "toast.saveFailed");
      if (!updated) return false;
      const index = state.steamAccounts.findIndex((candidate) => candidate.username === account.username);
      if (index >= 0) state.steamAccounts[index] = updated;
      render();
      toast("success", "Steam account updated");
      return true;
    },
  });
}

async function deleteSteamAccount(account: SteamAccountView): Promise<void> {
  const label = account.displayName || account.username;
  const answer = await modal({
    title: "Remove Steam account",
    body: `<p class="hint">Remove <strong>${esc(label)}</strong> from this device? Its saved credential will also be deleted from Windows Credential Manager.</p>`,
    actions: [
      { label: t("common.cancel"), value: "cancel" },
      { label: "Remove", value: "delete", kind: "danger" },
    ],
  });
  if (answer !== "delete") return;
  if ((await guard(() => api.deleteSteamAccount(account.username), "toast.deleteFailed")) === undefined) return;
  state.steamAccounts = state.steamAccounts.filter((candidate) => candidate.username !== account.username);
  state.selected = null;
  render();
  toast("success", "Steam account removed", label);
}

function openSteamMenu(account: SteamAccountView, x: number, y: number): void {
  select(steamKey(account));
  contextMenu(x, y, [
    { label: "Copy login name", icon: "copy", run: () => void copySteamUsername(account) },
    { label: "Copy password", icon: "key", run: () => void copySteamPassword(account) },
    { label: "Edit", icon: "pencil", run: () => void editSteamAccount(account) },
    "sep",
    { label: "Remove", icon: "trash", danger: true, hint: "Del", run: () => void deleteSteamAccount(account) },
  ], "account");
}

async function copyOtherUsername(account: OtherAccountView): Promise<void> {
  if ((await guard(() => api.copyOtherUsername(account.username), "toast.copyFailed")) !== undefined) {
    toast("success", "Login copied", account.username);
  }
}

async function copyOtherPassword(account: OtherAccountView): Promise<void> {
  const ttl = await guard(() => api.copyOtherPassword(account.platform, account.username), "toast.passFailed");
  if (ttl !== undefined) toast("success", "Password copied", `Clipboard clears in ${ttl} seconds.`);
}

async function launchOther(account: OtherAccountView): Promise<void> {
  const copied = await guard(() => api.copyOtherUsername(account.username), "toast.copyFailed");
  if (copied === undefined) return;
  const opened = await guard(() => api.launchOtherClient(account.platform), "toast.loginFailed");
  if (opened !== undefined) {
    toast("success", `${otherPlatformName(account.platform)} opened`, "Login name copied. Use the account menu to copy the password.");
  }
}

async function editOtherAccount(account: OtherAccountView): Promise<void> {
  await modal({
    title: `Edit ${otherPlatformName(account.platform)} account`,
    body: `
      <label class="field"><span>Display name</span><input name="displayName" value="${esc(account.displayName)}" placeholder="Optional label" /></label>
      <label class="field"><span>Description <em>optional</em></span><input name="description" value="${esc(account.description)}" placeholder="Main, competitive, alt…" /></label>`,
    actions: [
      { label: t("common.cancel"), value: "cancel" },
      { label: t("common.save"), value: "save", kind: "primary" },
    ],
    onSubmit: async (value, root) => {
      if (value !== "save") return true;
      const updated = await guard(() => api.updateOtherAccount({
        platform: account.platform,
        username: account.username,
        displayName: $<HTMLInputElement>('[name="displayName"]', root).value,
        description: $<HTMLInputElement>('[name="description"]', root).value,
      }), "toast.saveFailed");
      if (!updated) return false;
      const index = state.otherAccounts.findIndex((candidate) => otherKey(candidate) === otherKey(account));
      if (index >= 0) state.otherAccounts[index] = updated;
      render();
      toast("success", "Account updated");
      return true;
    },
  });
}

async function deleteOtherAccount(account: OtherAccountView): Promise<void> {
  const label = account.displayName || account.username;
  const answer = await modal({
    title: `Remove ${otherPlatformName(account.platform)} account`,
    body: `<p class="hint">Remove <strong>${esc(label)}</strong> from this device? Its saved credential will also be deleted from Windows Credential Manager.</p>`,
    actions: [
      { label: t("common.cancel"), value: "cancel" },
      { label: "Remove", value: "delete", kind: "danger" },
    ],
  });
  if (answer !== "delete") return;
  if ((await guard(() => api.deleteOtherAccount(account.platform, account.username), "toast.deleteFailed")) === undefined) return;
  state.otherAccounts = state.otherAccounts.filter((candidate) => otherKey(candidate) !== otherKey(account));
  state.selected = null;
  render();
  toast("success", "Account removed", label);
}

function openOtherMenu(account: OtherAccountView, x: number, y: number): void {
  select(otherKey(account));
  contextMenu(x, y, [
    { label: "Copy login", icon: "copy", run: () => void copyOtherUsername(account) },
    { label: "Copy password", icon: "key", run: () => void copyOtherPassword(account) },
    { label: "Edit", icon: "pencil", run: () => void editOtherAccount(account) },
    "sep",
    { label: "Remove", icon: "trash", danger: true, hint: "Del", run: () => void deleteOtherAccount(account) },
  ], "account");
}

// ---------------------------------------------------------------- add drawer

function openOtherAddDrawer(): void {
  if (document.querySelector(".drawer-overlay")) return;
  const overlay = fragment(`
    <div class="drawer-overlay steam-drawer-overlay">
      <aside class="drawer steam-drawer" role="dialog" aria-modal="true" aria-label="Add platform account">
        <header class="drawer-head">
          <div><h2>Add platform account</h2><p>Credentials stay in Windows Credential Manager.</p></div>
          <button class="icon-btn" data-close aria-label="Close">${icon("x")}</button>
        </header>
        <form class="steam-account-form" novalidate>
          <div class="steam-drawer-brand">${icon("gamepad", 22)}<span><strong>Other platforms</strong><small>Epic Games and EA app / Origin</small></span></div>
          <label class="field"><span>Platform</span><select name="platform">
            <option value="epic" ${state.otherPlatform === "epic" ? "selected" : ""}>Epic Games</option>
            <option value="ea" ${state.otherPlatform === "ea" ? "selected" : ""}>EA app / Origin</option>
          </select></label>
          <label class="field"><span>Email or login name</span><input name="username" autocomplete="off" spellcheck="false" placeholder="name@example.com" /></label>
          <label class="field"><span>Display name <em>optional</em></span><input name="displayName" autocomplete="off" placeholder="How it appears in your vault" /></label>
          <label class="field"><span>Password</span><div class="password"><input name="password" type="password" autocomplete="new-password" /><button type="button" class="icon-btn" data-reveal title="Show password">${icon("eye", 15)}</button></div></label>
          <label class="field"><span>Description <em>optional</em></span><input name="description" autocomplete="off" placeholder="Main, competitive, alt…" /></label>
          <div class="steam-security-note">${icon("info", 15)} The launcher may still request two-factor authentication or a captcha.</div>
          <button class="btn btn-primary btn-block" type="submit">${icon("plus")} Add account</button>
        </form>
      </aside>
    </div>`);
  $("#drawer-root").append(overlay);
  const drawer = $(".steam-drawer", overlay);
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    void leave(overlay, "drawer-out");
  };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(); });
  $("[data-close]", overlay).addEventListener("click", close);
  const reveal = $("[data-reveal]", overlay);
  reveal.addEventListener("click", () => {
    const input = $<HTMLInputElement>('[name="password"]', overlay);
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    reveal.innerHTML = icon(hidden ? "eye-off" : "eye", 15);
  });
  const form = $<HTMLFormElement>("form", drawer);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const value = (name: string) => String(data.get(name) ?? "");
    const missing = ["username", "password"].filter((name) => !value(name).trim());
    form.querySelectorAll("input").forEach((input) => input.classList.toggle("invalid", missing.includes(input.name)));
    if (missing.length) { shake(drawer); return; }
    const submit = $<HTMLButtonElement>('button[type="submit"]', form);
    submit.disabled = true;
    const platform = value("platform") as OtherPlatform;
    const added = await guard(() => api.addOtherAccount({
      platform,
      username: value("username"),
      displayName: value("displayName"),
      password: value("password"),
      description: value("description"),
    }), "toast.addFailed");
    submit.disabled = false;
    if (!added) return;
    state.otherAccounts.push(added);
    state.otherPlatform = platform;
    state.selected = otherKey(added);
    render();
    toast("success", `${otherPlatformName(platform)} account added`, added.displayName || added.username);
    close();
  });
  $<HTMLInputElement>('[name="username"]', form).focus();
}

function openSteamAddDrawer(): void {
  if (document.querySelector(".drawer-overlay")) return;
  const overlay = fragment(`
    <div class="drawer-overlay steam-drawer-overlay">
      <aside class="drawer steam-drawer" role="dialog" aria-modal="true" aria-label="Add Steam account">
        <header class="drawer-head">
          <div><h2>Add Steam account</h2><p>Credentials stay in Windows Credential Manager.</p></div>
          <button class="icon-btn" data-close aria-label="Close">${icon("x")}</button>
        </header>
        <form class="steam-account-form" novalidate>
          <div class="steam-drawer-brand">${icon("gamepad", 22)}<span><strong>Steam Vault</strong><small>Trusted personal devices only</small></span></div>
          <label class="field"><span>Steam login name</span><input name="username" autocomplete="off" spellcheck="false" placeholder="account_name" /></label>
          <label class="field"><span>Display name <em>optional</em></span><input name="displayName" autocomplete="off" placeholder="How it appears in your vault" /></label>
          <label class="field"><span>Steam ID <em>optional</em></span><input name="steamId" autocomplete="off" spellcheck="false" placeholder="76561198…" /></label>
          <label class="field"><span>Password</span><div class="password"><input name="password" type="password" autocomplete="new-password" /><button type="button" class="icon-btn" data-reveal title="Show password">${icon("eye", 15)}</button></div></label>
          <label class="field"><span>Description <em>optional</em></span><input name="description" autocomplete="off" placeholder="Main, competitive, alt…" /></label>
          <div class="steam-security-note">${icon("info", 15)} Steam Guard approval may still be required during login.</div>
          <button class="btn btn-primary btn-block" type="submit">${icon("plus")} Add Steam account</button>
        </form>
      </aside>
    </div>`);
  $("#drawer-root").append(overlay);
  const drawer = $(".steam-drawer", overlay);
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    void leave(overlay, "drawer-out");
  };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(); });
  $("[data-close]", overlay).addEventListener("click", close);
  const reveal = $("[data-reveal]", overlay);
  reveal.addEventListener("click", () => {
    const input = $<HTMLInputElement>('[name="password"]', overlay);
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    reveal.innerHTML = icon(hidden ? "eye-off" : "eye", 15);
  });
  const form = $<HTMLFormElement>("form", drawer);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const value = (name: string) => String(data.get(name) ?? "");
    const missing = ["username", "password"].filter((name) => !value(name).trim());
    form.querySelectorAll("input").forEach((input) => input.classList.toggle("invalid", missing.includes(input.name)));
    if (missing.length) { shake(drawer); return; }
    const submit = $<HTMLButtonElement>('button[type="submit"]', form);
    submit.disabled = true;
    const added = await guard(() => api.addSteamAccount({
      username: value("username"),
      displayName: value("displayName"),
      steamId: value("steamId"),
      password: value("password"),
      description: value("description"),
    }), "toast.addFailed");
    submit.disabled = false;
    if (!added) return;
    state.steamAccounts.push(added);
    state.selected = steamKey(added);
    render();
    toast("success", "Steam account added", added.displayName || added.username);
    close();
  });
  $<HTMLInputElement>('[name="username"]', form).focus();
}

function openAddDrawer(tab: "single" | "multi" = "single"): void {
  if (state.vault === "steam") {
    openSteamAddDrawer();
    return;
  }
  if (state.vault === "others") {
    openOtherAddDrawer();
    return;
  }
  if (document.querySelector(".drawer-overlay")) return;
  const regionOptions = state.regions
    .map((region) => `<option${region === lastRegion() ? " selected" : ""}>${esc(region)}</option>`)
    .join("");
  const overlay = fragment(`
    <div class="drawer-overlay">
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(t("add.title"))}">
        <header class="drawer-head">
          <div>
            <h2>${t("add.title")}</h2>
            <p>${t("add.subtitle")}</p>
          </div>
          <button class="icon-btn" data-close aria-label="${esc(t("common.close"))}">${icon("x")}</button>
        </header>
        <div class="tabs" role="tablist">
          <span class="tab-pill"></span>
          <button role="tab" data-tab="single">${t("add.tabSingle")}</button>
          <button role="tab" data-tab="multi">${t("add.tabMulti")}</button>
        </div>
        <div class="tab-panels">
          <form class="tab-panel" data-panel="single" novalidate>
            ${gameAccessSelector([state.riotGame])}
            <label class="field"><span>${t("add.accountId")}</span>
              <input name="accountId" autocomplete="off" spellcheck="false" placeholder="${esc(t("add.accountIdPh"))}" /></label>
            <label class="field"><span>${t("edit.riotId")} <em>${t("add.optional")}</em></span>
              <input name="name" autocomplete="off" spellcheck="false" placeholder="${esc(t("add.riotIdPh"))}" /></label>
            <div class="field-row">
              <label class="field"><span>${t("add.region")}</span><div class="select-wrap full"><select name="region">${regionOptions}</select></div></label>
            </div>
            <label class="field"><span>${t("add.password")}</span>
              <div class="password">
                <input name="password" type="password" autocomplete="new-password" />
                <button type="button" class="icon-btn" data-reveal title="${esc(t("add.show"))}">${icon("eye", 15)}</button>
              </div></label>
            <label class="field"><span>${t("edit.description")} <em>${t("add.optional")}</em></span>
              <input name="description" autocomplete="off" placeholder="${esc(t("edit.descriptionPh"))}" /></label>
            <button class="btn btn-primary btn-block" type="submit">${icon("plus")} ${t("add.submit")}</button>
          </form>
          <form class="tab-panel" data-panel="multi" novalidate>
            ${gameAccessSelector([state.riotGame])}
            <label class="field"><span>${t("add.multiLabel")}</span>
              <textarea name="text" rows="9" spellcheck="false" placeholder="${esc(t("add.multiPh"))}"></textarea></label>
            <p class="hint">${t("add.multiHint", { format: "<code>AccountID--Name#TAG--password</code>", alt: "<code>---</code>" })} <span class="multi-count"></span></p>
            <label class="field"><span>${t("add.multiRegion")}</span><div class="select-wrap full"><select name="region">${regionOptions}</select></div></label>
            <button class="btn btn-primary btn-block" type="submit">${icon("users")} ${t("add.multiSubmit")}</button>
          </form>
        </div>
      </aside>
    </div>`);
  $("#drawer-root").append(overlay);
  const drawer = $(".drawer", overlay);

  const setTab = (name: string) => {
    drawer.dataset.tab = name;
    drawer.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.tab === name));
    });
    drawer.querySelector<HTMLInputElement>(`[data-panel="${name}"] input, [data-panel="${name}"] textarea`)?.focus();
  };
  setTab(tab);
  drawer.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => setTab(button.dataset.tab ?? "single"));
  });

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    void leave(overlay, "drawer-out");
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close();
  });
  $("[data-close]", overlay).addEventListener("click", close);

  const reveal = $("[data-reveal]", overlay);
  reveal.addEventListener("click", () => {
    const input = $<HTMLInputElement>('[name="password"]', overlay);
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    reveal.innerHTML = icon(hidden ? "eye-off" : "eye", 15);
  });

  const textarea = $<HTMLTextAreaElement>("textarea", overlay);
  const counter = $(".multi-count", overlay);
  textarea.addEventListener("input", () => {
    const lines = textarea.value.split("\n").filter((line) => line.trim());
    const valid = lines.filter((line) => parseAccountLine(line));
    counter.textContent = lines.length ? t("add.multiCount", { valid: valid.length, total: lines.length }) : "";
  });

  const single = $<HTMLFormElement>('[data-panel="single"]', overlay);
  single.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(single);
    const value = (name: string) => String(data.get(name) ?? "");
    const games = selectedGames(single);
    const missing = ["accountId", "password"].filter((name) => !value(name).trim());
    single.querySelectorAll("input").forEach((input) => input.classList.toggle("invalid", missing.includes(input.name)));
    single.querySelector(".game-access")?.classList.toggle("invalid", games.length === 0);
    if (missing.length || !games.length) {
      shake(drawer);
      return;
    }
    const button = $<HTMLButtonElement>('button[type="submit"]', single);
    button.disabled = true;
    rememberRegion(value("region"));
    const added = await guard(
      () =>
        api.addAccount({
          accountId: value("accountId"),
          name: value("name"),
          games,
          region: value("region"),
          password: value("password"),
          description: value("description"),
        }),
      "toast.addFailed",
    );
    button.disabled = false;
    if (!added) return;
    upsert(added);
    state.selected = keyId(keyOf(added));
    render();
    single.reset();
    $<HTMLSelectElement>('[name="region"]', single).value = lastRegion();
    $<HTMLInputElement>('[name="accountId"]', single).focus();
    toast("success", t("toast.added"), added.name ? t("toast.addedText", { name: added.name }) : added.accountId);
  });

  const multi = $<HTMLFormElement>('[data-panel="multi"]', overlay);
  multi.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(multi);
    const text = String(data.get("text") ?? "");
    const region = String(data.get("region") ?? "");
    const games = selectedGames(multi);
    multi.querySelector(".game-access")?.classList.toggle("invalid", games.length === 0);
    if (!text.trim() || !games.length) {
      shake(drawer);
      return;
    }
    rememberRegion(region);
    const result = await guard(() => api.multiAdd(text, region, games), "toast.multiFailed");
    if (!result) return;
    state.accounts = await api.listAccounts();
    render();
    textarea.value = "";
    counter.textContent = "";
    toast(
      result.added ? "success" : "info",
      t("toast.multiAdded", { count: result.added }),
      result.skipped ? t("toast.multiSkipped", { count: result.skipped }) : "",
    );
    if (result.added) close();
  });
}

function shake(element: HTMLElement): void {
  element.classList.remove("shake");
  void element.offsetWidth;
  element.classList.add("shake");
}

function lastRegion(): string {
  try {
    return localStorage.getItem("morphwrld.riftvault.region") ?? "EUW";
  } catch {
    return "EUW";
  }
}

function rememberRegion(region: string): void {
  try {
    localStorage.setItem("morphwrld.riftvault.region", region);
  } catch {
    // Non-essential.
  }
}

// ---------------------------------------------------------------- side actions

async function exportData(): Promise<void> {
  const answer = await modal({
    title: t("export.title"),
    body: `<div class="warning">${icon("alert", 18)}<p>${t("export.warning")}</p></div>`,
    actions: [
      { label: t("common.cancel"), value: "cancel" },
      { label: t("export.confirm"), value: "export", kind: "primary" },
    ],
  });
  if (answer !== "export") return;
  const path = await guard(() => api.exportData(t("export.dialog")), "toast.exportFailed");
  if (path) toast("success", t("toast.exported"), path, 4500);
}

async function importData(): Promise<void> {
  const result = await guard(() => api.importData(t("import.dialog")), "toast.importFailed");
  if (!result) return;
  state.accounts = await api.listAccounts();
  render();
  toast(
    "success",
    t("toast.imported", { count: result.added }),
    result.skipped ? t("toast.importSkipped", { count: result.skipped }) : "",
  );
}

function showShortcuts(): void {
  const rows: [string, string][] = [
    ["Ctrl + Shift + V", t("sc.login")],
    ["Ctrl + C", t("sc.copy")],
    ["Delete", t("sc.delete")],
    ["↑ ↓ / ← →", t("sc.nav")],
    ["Ctrl + F", t("sc.search")],
    ["Ctrl + N", t("sc.add")],
    ["Ctrl + R / F5", t("sc.refresh")],
    ["Ctrl + 1…6", "League / TFT / VALORANT / Steam / Epic / EA"],
    ["Ctrl + ,", t("sc.settings")],
    [t("sc.dblclick"), t("sc.dblclickText")],
    [t("sc.rightclick"), t("card.more")],
  ];
  void modal({
    title: t("shortcuts.title"),
    body: `<div class="shortcuts">${rows.map(([keys, label]) => `<kbd>${esc(keys)}</kbd><span>${esc(label)}</span>`).join("")}</div>`,
    actions: [{ label: t("common.ok"), value: "ok", kind: "primary" }],
  });
}

function openInfo(): void {
  if (document.querySelector(".drawer-overlay")) return;
  const faq: [string, string][] = [
    ["Where are my credentials stored?", "Passwords are stored locally in Windows Credential Manager. Rift Vault does not provide cloud storage or sync."],
    ["How are profile pictures and ranks updated?", "Rift Vault reads public profile data from OP.GG. Updates can be delayed when the source profile has not refreshed yet."],
    ["Why does Steam Guard still appear?", "Steam Guard remains controlled by Steam and may request a code or mobile confirmation when you sign in."],
    ["How do I move my accounts to another PC?", "Use Export on the old PC and Import on the new PC. Keep exported files private because they may contain sensitive account data."],
    ["Is this an official Riot or Valve app?", "No. MORPH WRLD Rift Vault is an independent personal-use account manager and is not affiliated with Riot Games or Valve."],
  ];
  const overlay = fragment(`
    <div class="drawer-overlay info-overlay">
      <aside class="drawer info-drawer" role="dialog" aria-modal="true" aria-label="Information and frequently asked questions">
        <header class="info-head">
          <div><span class="info-kicker">MORPH WRLD</span><h2>Info & FAQ</h2><p>Everything you need to know about Rift Vault.</p></div>
          <button class="icon-btn" data-info-close aria-label="${esc(t("common.close"))}">${icon("x")}</button>
        </header>
        <div class="info-body">
          <section class="info-intro">
            <div class="info-mark"><img src="/icon.png" alt="" /></div>
            <div><strong>Rift Vault</strong><span>Private, local account management for Riot and Steam.</span></div>
          </section>
          <section class="info-security">
            ${icon("key", 19)}
            <div><strong>Local-first security</strong><p>Your saved credentials stay in Windows Credential Manager on this device.</p></div>
          </section>
          <section class="info-faq">
            <span class="settings-eyebrow">Frequently asked questions</span>
            ${faq.map(([question, answer], index) => `<details${index === 0 ? " open" : ""}><summary><span>${esc(question)}</span>${icon("chevron-down", 15)}</summary><p>${esc(answer)}</p></details>`).join("")}
          </section>
        </div>
        <footer class="info-foot">
          <button class="btn info-shortcuts" type="button" data-info-shortcuts>${icon("keyboard", 16)} Keyboard shortcuts</button>
          <span>Version 1.0.0</span>
        </footer>
      </aside>
    </div>`);
  $("#drawer-root").append(overlay);
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    void leave(overlay, "drawer-out");
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  overlay.querySelector("[data-info-close]")?.addEventListener("click", close);
  overlay.querySelector("[data-info-shortcuts]")?.addEventListener("click", () => {
    close();
    window.setTimeout(showShortcuts, 180);
  });
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(); });
  document.addEventListener("keydown", onKey, true);
}

// ---------------------------------------------------------------- language

/** Translate static markup and the option lists built in code. */
function applyLanguage(): void {
  applyStatic();
  const friendTier = $<HTMLSelectElement>("#friend-tier");
  const selectedTier = friendTier.value || state.friendTier;
  friendTier.innerHTML =
    `<option value="all">${esc(t("toolbar.all"))}</option>` +
    ["Master", "Diamond", "Emerald", "Platinum", "Gold", "Silver", "Bronze", "Iron"]
      .map((tier) => `<option value="${tier}">${esc(tierName(tier))}</option>`)
      .join("");
  friendTier.value = selectedTier;
}

function openLangMenu(): void {
  const rect = $("#lang").getBoundingClientRect();
  contextMenu(
    rect.left,
    rect.bottom + 6,
    LANGUAGES.map((language) => ({
      label: language.name,
      icon: language.code === lang() ? "check" : "languages",
      run: () => changeLanguage(language.code),
    })),
    "language",
  );
}

function changeLanguage(next: Lang): void {
  if (next === lang()) return;
  setLang(next);
  applyLanguage();
  render();
}

// ---------------------------------------------------------------- wiring

function wire(): void {
  const platformButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-platform]")];
  const platformMenus = [...document.querySelectorAll<HTMLElement>("[data-menu]")];
  const closePlatformMenus = () => {
    platformMenus.forEach((menu) => { menu.hidden = true; });
    platformButtons.forEach((button) => button.setAttribute("aria-expanded", "false"));
  };
  platformButtons.forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const platform = button.dataset.platform;
      const menu = platformMenus.find((candidate) => candidate.dataset.menu === platform);
      const opening = Boolean(menu?.hidden);
      closePlatformMenus();
      if (menu && opening) {
        menu.hidden = false;
        button.setAttribute("aria-expanded", "true");
      }
    });
  });
  const riotMenu = $("#riot-game-menu");
  riotMenu.querySelectorAll<HTMLButtonElement>("[data-riot-game]").forEach((button) => {
    button.addEventListener("click", () => {
      selectRiotGame(button.dataset.riotGame as RiotGame);
      closePlatformMenus();
    });
  });
  $<HTMLButtonElement>("[data-steam-platform]").addEventListener("click", () => {
    setVault("steam");
    closePlatformMenus();
  });
  $("#others-platform-menu").querySelectorAll<HTMLButtonElement>("[data-other-platform]").forEach((button) => {
    button.addEventListener("click", () => {
      selectOtherPlatform(button.dataset.otherPlatform as OtherPlatform);
      closePlatformMenus();
    });
  });
  document.addEventListener("click", (event) => {
    if (!(event.target as HTMLElement).closest(".mode-switch")) closePlatformMenus();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view as View;
      savePrefs();
      firstRender = true;
      $("#accounts").innerHTML = "";
      render();
    });
  });

  const search = $<HTMLInputElement>("#search");
  search.addEventListener("input", () => {
    state.search = search.value;
    renderAccounts();
  });

  const regionFilter = $<HTMLSelectElement>("#region-filter");
  regionFilter.addEventListener("change", () => {
    state.regionFilter = regionFilter.value;
    render();
  });
  const friendTier = $<HTMLSelectElement>("#friend-tier");
  const friendDivision = $<HTMLSelectElement>("#friend-division");
  friendDivision.innerHTML = ["I", "II", "III", "IV"].map((division) => `<option>${division}</option>`).join("");
  const onFriend = () => {
    state.friendTier = friendTier.value;
    state.friendDivision = friendDivision.value;
    friendDivision.disabled = state.friendTier === "all" || state.friendTier === "Master";
    render();
  };
  friendTier.addEventListener("change", onFriend);
  friendDivision.addEventListener("change", onFriend);
  friendDivision.disabled = true;

  const sort = $<HTMLSelectElement>("#sort");
  sort.addEventListener("change", () => {
    state.sort = sort.value as Sort;
    savePrefs();
    renderAccounts();
  });

  $("#schedule").addEventListener("click", () => void refreshAll());
  $("#open-add").addEventListener("click", () => openAddDrawer());
  $("#lang").addEventListener("click", openLangMenu);
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      if (action === "add") openAddDrawer();
      if (action === "import") void importData();
      if (action === "export") void exportData();
      if (action === "logs") void guard(() => api.openLogsFolder(), "toast.logsFailed");
      if (action === "info") openInfo();
      if (action === "shortcuts") showShortcuts();
      if (action === "settings") void openSettings();
    });
  });

  $("#distribution").addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-tier]");
    if (!row) return;
    state.tierFilter = state.tierFilter === row.dataset.tier ? null : (row.dataset.tier ?? null);
    render();
  });

  $("#empty").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-empty]");
    if (button?.dataset.empty === "add") openAddDrawer();
    if (button?.dataset.empty === "clear") clearFilters();
  });

  const accounts = $("#accounts");
  accounts.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>(".card");
    if (!card) return;
    if (state.vault === "steam") {
      const steamAccount = bySteamId(card.dataset.key ?? "");
      if (!steamAccount) return;
      select(card.dataset.key ?? null);
      const action = (event.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (action === "steam-login") void loginSteam(steamAccount);
      if (action === "steam-menu") {
        const rect = (event.target as HTMLElement).closest("button")!.getBoundingClientRect();
        openSteamMenu(steamAccount, rect.left, rect.bottom + 6);
      }
      return;
    }
    if (state.vault === "others") {
      const otherAccount = byOtherId(card.dataset.key ?? "");
      if (!otherAccount) return;
      select(card.dataset.key ?? null);
      const action = (event.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (action === "other-launch") void launchOther(otherAccount);
      if (action === "other-menu") {
        const rect = (event.target as HTMLElement).closest("button")!.getBoundingClientRect();
        openOtherMenu(otherAccount, rect.left, rect.bottom + 6);
      }
      return;
    }
    const account = byId(card.dataset.key ?? "");
    if (!account) return;
    select(card.dataset.key ?? null);
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (action === "login") void login(account);
    if (action === "copy-id") void copyId(account);
    if (action === "copy-pass") void copyPassword(account);
    if (action === "menu") {
      const rect = (event.target as HTMLElement).closest("button")!.getBoundingClientRect();
      openMenu(account, rect.left, rect.bottom + 6);
    }
    if (action === "edit") void editAccount(account);
  });
  accounts.addEventListener("dblclick", (event) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const card = (event.target as HTMLElement).closest<HTMLElement>(".card");
    if (state.vault === "steam") {
      const steamAccount = card && bySteamId(card.dataset.key ?? "");
      if (steamAccount) void editSteamAccount(steamAccount);
      return;
    }
    if (state.vault === "others") {
      const otherAccount = card && byOtherId(card.dataset.key ?? "");
      if (otherAccount) void editOtherAccount(otherAccount);
      return;
    }
    const account = card && byId(card.dataset.key ?? "");
    if (account) void editAccount(account);
  });
  accounts.addEventListener("contextmenu", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>(".card");
    if (state.vault === "steam") {
      const steamAccount = card && bySteamId(card.dataset.key ?? "");
      if (!steamAccount) return;
      event.preventDefault();
      openSteamMenu(steamAccount, event.clientX, event.clientY);
      return;
    }
    if (state.vault === "others") {
      const otherAccount = card && byOtherId(card.dataset.key ?? "");
      if (!otherAccount) return;
      event.preventDefault();
      openOtherMenu(otherAccount, event.clientX, event.clientY);
      return;
    }
    const account = card && byId(card.dataset.key ?? "");
    if (!account) return;
    event.preventDefault();
    openMenu(account, event.clientX, event.clientY);
  });
  // Pointer-tracked highlight on cards.
  accounts.addEventListener("pointermove", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>(".card");
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${event.clientX - rect.left}px`);
    card.style.setProperty("--my", `${event.clientY - rect.top}px`);
  });

  document.addEventListener("contextmenu", (event) => {
    if (!(event.target as HTMLElement).closest("input, textarea")) event.preventDefault();
  });
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("scroll", closeMenu, true);
}

function clearFilters(): void {
  state.search = "";
  state.regionFilter = "all";
  state.friendTier = "all";
  state.tierFilter = null;
  $<HTMLInputElement>("#search").value = "";
  $<HTMLSelectElement>("#region-filter").value = "all";
  $<HTMLSelectElement>("#friend-tier").value = "all";
  $<HTMLSelectElement>("#friend-division").disabled = true;
  render();
}

function setMode(mode: Mode): void {
  selectRiotGame(mode);
}

let vaultTransitionSequence = 0;

function showVaultTransition(vault: Vault): void {
  const sequence = ++vaultTransitionSequence;
  document.querySelector(".steam-transition")?.remove();
  const overlay = document.createElement("div");
  const riot = vault === "riot";
  const label = riot ? "Riot" : vault === "steam" ? "Steam" : otherPlatformName(state.otherPlatform);
  overlay.className = `steam-transition${riot ? " riot-transition" : vault === "others" ? " other-transition" : ""}`;
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");
  overlay.setAttribute("aria-label", `Switching to ${label} Vault`);
  overlay.innerHTML = `
    <div class="steam-transition-glow" aria-hidden="true"></div>
    <div class="steam-transition-lockup">
      <div class="steam-transition-emblem" aria-hidden="true">
        <span class="steam-transition-orbit"></span>
        <img src="/icon.png" alt="" />
      </div>
      <span class="steam-transition-brand">MORPH WRLD</span>
      <strong>Switching to ${label} Vault</strong>
      <p>Preparing your local ${label} accounts</p>
      <div class="steam-transition-progress" aria-hidden="true"><span></span></div>
    </div>`;
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add("is-visible"));
  const hold = reducedMotion() ? 420 : 1050;
  window.setTimeout(() => {
    if (sequence !== vaultTransitionSequence || !overlay.isConnected) return;
    overlay.classList.add("is-leaving");
    window.setTimeout(() => overlay.remove(), reducedMotion() ? 80 : 360);
  }, hold);
}

function setVault(vault: Vault): void {
  if (state.vault === vault) return;
  showVaultTransition(vault);
  state.vault = vault;
  updateVaultView();
}

function selectRiotGame(game: RiotGame): void {
  const changed = state.vault !== "riot" || state.riotGame !== game;
  if (state.vault !== "riot") showVaultTransition("riot");
  state.vault = "riot";
  state.riotGame = game;
  if (game !== "valorant") state.mode = game;
  if (changed) updateVaultView();
}

function selectOtherPlatform(platform: OtherPlatform): void {
  const changed = state.vault !== "others" || state.otherPlatform !== platform;
  state.otherPlatform = platform;
  if (state.vault !== "others") showVaultTransition("others");
  state.vault = "others";
  if (changed) updateVaultView();
}

function updateVaultView(): void {
  savePrefs();
  if (state.tierFilter) state.tierFilter = null;
  state.selected = null;
  const container = $("#accounts");
  container.innerHTML = "";
  container.classList.remove("mode-swap");
  void container.offsetWidth;
  container.classList.add("mode-swap");
  render();
}

function populateRegions(): void {
  const regions = [...new Set(state.accounts.map((account) => account.regionDisplay))];
  const all = state.regions.filter((region) => regions.includes(region));
  const select = $<HTMLSelectElement>("#region-filter");
  select.innerHTML = `<option value="all">${esc(t("toolbar.allRegions"))}</option>` + all.map((region) => `<option>${esc(region)}</option>`).join("");
  if (!all.includes(state.regionFilter)) state.regionFilter = "all";
  select.value = state.regionFilter;
}

function moveSelection(step: number, columns: boolean): void {
  const cards = [...document.querySelectorAll<HTMLElement>("#accounts > .card")];
  if (!cards.length) return;
  let index = cards.findIndex((card) => card.dataset.key === state.selected);
  let delta = step;
  if (columns && state.view === "grid" && cards.length > 1) {
    const top = cards[0].getBoundingClientRect().top;
    const perRow = cards.filter((card) => Math.abs(card.getBoundingClientRect().top - top) < 4).length;
    delta = step * perRow;
  }
  index = index < 0 ? 0 : Math.max(0, Math.min(cards.length - 1, index + delta));
  select(cards[index].dataset.key ?? null, true);
}

function onKeyDown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  const typing = target.matches("input, textarea, select");
  const overlayOpen = Boolean(document.querySelector(".overlay, .drawer-overlay, .login-overlay"));
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  if ((ctrl && key === "r") || event.key === "F5") {
    event.preventDefault();
    if (!overlayOpen && state.vault === "steam") {
      void api.listSteamAccounts().then((accounts) => { state.steamAccounts = accounts; render(); });
    } else if (!overlayOpen && state.vault === "others") {
      void api.listOtherAccounts().then((accounts) => { state.otherAccounts = accounts; render(); });
    } else if (!overlayOpen) void refreshAll();
    return;
  }
  if (overlayOpen) return;
  if (ctrl && key === "f") {
    event.preventDefault();
    $<HTMLInputElement>("#search").select();
    return;
  }
  if (ctrl && key === ",") {
    event.preventDefault();
    void openSettings();
    return;
  }
  if (ctrl && key === "n") {
    event.preventDefault();
    openAddDrawer();
    return;
  }
  if (ctrl && ["1", "2", "3", "4", "5", "6"].includes(key)) {
    event.preventDefault();
    if (key === "4") setVault("steam");
    else if (key === "5") selectOtherPlatform("epic");
    else if (key === "6") selectOtherPlatform("ea");
    else selectRiotGame(key === "1" ? "lol" : key === "2" ? "tft" : "valorant");
    return;
  }
  const selected = state.selected ? byId(state.selected) : undefined;
  const selectedSteam = state.selected ? bySteamId(state.selected) : undefined;
  const selectedOther = state.selected ? byOtherId(state.selected) : undefined;
  if (ctrl && event.shiftKey && key === "v" && (selected || selectedSteam || selectedOther)) {
    event.preventDefault();
    if (selectedSteam) void loginSteam(selectedSteam);
    else if (selectedOther) void launchOther(selectedOther);
    else if (selected) void login(selected);
    return;
  }
  if (typing) {
    if (event.key === "Escape" && target.id === "search") {
      target.blur();
    }
    return;
  }
  if (ctrl && key === "c" && (selected || selectedSteam || selectedOther) && !window.getSelection()?.toString()) {
    event.preventDefault();
    const id = state.selected ?? "";
    if (state.copyStage.id !== id) state.copyStage = { id, count: 0 };
    if (selectedSteam) void (state.copyStage.count % 2 === 0 ? copySteamUsername(selectedSteam) : copySteamPassword(selectedSteam));
    else if (selectedOther) void (state.copyStage.count % 2 === 0 ? copyOtherUsername(selectedOther) : copyOtherPassword(selectedOther));
    else if (selected) void (state.copyStage.count % 2 === 0 ? copyId(selected) : copyPassword(selected));
    state.copyStage.count++;
    return;
  }
  if (event.key === "Delete" && (selected || selectedSteam || selectedOther)) {
    event.preventDefault();
    if (selectedSteam) void deleteSteamAccount(selectedSteam);
    else if (selectedOther) void deleteOtherAccount(selectedOther);
    else if (selected) void deleteAccount(selected);
    return;
  }
  if (event.key === "Escape") {
    select(null);
    return;
  }
  const arrows: Record<string, [number, boolean]> = {
    ArrowDown: [1, true],
    ArrowUp: [-1, true],
    ArrowRight: [1, false],
    ArrowLeft: [-1, false],
  };
  if (event.key in arrows) {
    event.preventDefault();
    const [step, columns] = arrows[event.key];
    moveSelection(step, columns && state.view === "grid");
  }
}

async function wireWindow(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();
  const buttons: Record<string, [string, () => Promise<void>]> = {
    minimize: ["minus", () => appWindow.minimize()],
    maximize: ["square", () => appWindow.toggleMaximize()],
    close: ["x", () => appWindow.close()],
  };
  document.querySelectorAll<HTMLButtonElement>("[data-win]").forEach((button) => {
    const [name, run] = buttons[button.dataset.win ?? ""];
    button.innerHTML = icon(name, name === "square" ? 12 : 15);
    button.addEventListener("click", () => void run());
  });
}

async function wireEvents(): Promise<void> {
  await events.onLoginStep((step) => activeLogin?.step(step));
  await events.onUpdateAvailable((release) => showUpdate(release));
  await events.onRefreshStarted(({ total }) => {
    state.refreshing = true;
    state.refreshTotal = total;
    state.refreshDone = 0;
    renderSchedule();
  });
  await events.onSchedule((schedule) => {
    state.schedule = schedule;
    renderSchedule();
  });
  await events.onRankPending((keys: Key[]) => {
    keys.forEach((key) => state.pending.add(keyId(key)));
    renderAccounts();
  });
  await events.onRankUpdate((account) => {
    state.pending.delete(keyId(keyOf(account)));
    upsert(account);
    if (state.refreshing) state.refreshDone = Math.min(state.refreshTotal, state.refreshDone + 1);
    renderAccounts();
    renderDistribution();
    renderSchedule();
  });
  await events.onRefreshDone(({ error, exclusive, auto }) => {
    if (error) toast("error", t("toast.ranksSaveFailed"), describe(new ApiError(error.code, error.detail)), 5000);
    // Only a full refresh ends the progress state; single-account refreshes
    // (after adding or renaming) may finish while it is still running.
    if (exclusive && state.refreshing) {
      state.refreshing = false;
      state.pending.clear();
      if (!error && auto) toast("info", t("toast.autoRefreshed"), t("toast.ranksUpdatedText", { count: state.refreshTotal }), 2600);
      else if (!error) toast("success", t("toast.ranksUpdated"), t("toast.ranksUpdatedText", { count: state.refreshTotal }));
    }
    render();
  });
}

const IN_TAURI = "__TAURI_INTERNALS__" in window;

/** Dev-only: `?scene=` opens a screen with demo data (used for README screenshots). */
function runDemoScene(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-win]").forEach((button) => {
    const names: Record<string, string> = { minimize: "minus", maximize: "square", close: "x" };
    button.innerHTML = icon(names[button.dataset.win ?? ""], button.dataset.win === "maximize" ? 12 : 15);
  });
  const scene = new URLSearchParams(location.search).get("scene");
  const byName = (part: string) => state.accounts.find((account) => account.name.includes(part))!;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  void (async () => {
    await wait(300);
    if (scene === "tft") setMode("tft");
    if (scene === "valorant") selectRiotGame("valorant");
    if (scene === "riot-menu") $<HTMLButtonElement>('[data-platform="riot"]').click();
    if (scene === "steam-loading") {
      await wait(2100);
      setVault("steam");
    }
    if (scene === "riot-loading") {
      setVault("steam");
      await wait(2100);
      setVault("riot");
    }
    if (scene === "steam") setVault("steam");
    if (scene === "steam-add") {
      setVault("steam");
      openSteamAddDrawer();
    }
    if (scene === "others-menu") $<HTMLButtonElement>('[data-platform="others"]').click();
    if (scene === "epic") selectOtherPlatform("epic");
    if (scene === "ea") selectOtherPlatform("ea");
    if (scene === "list") {
      state.view = "list";
      $("#accounts").innerHTML = "";
      render();
    }
    if (scene === "settings") void openSettings();
    if (scene === "info") openInfo();
    if (scene === "add") openAddDrawer();
    if (scene === "login") void login(byName("Hextech"));
    if (scene === "update") showUpdate({ version: "1.1.0", name: "v1.1.0", url: "", notes: "", publishedAt: "" }, true);
    if (scene === "menu") {
      const card = document.querySelector<HTMLElement>("#accounts > .card:nth-child(2)")!;
      const rect = card.getBoundingClientRect();
      openMenu(byName("Lux"), rect.left + 180, rect.top + 60);
    }
  })();
}

async function start(): Promise<void> {
  if (!IN_TAURI && import.meta.env.DEV) (await import("./mock")).installMock();
  loadPrefs();
  setLang(lang());
  applyLanguage();
  installEmblemDefs(document.getElementById("emblem-defs") as unknown as SVGDefsElement);
  hydrateIcons();
  wire();
  const boot = await api.bootstrap();
  state.accounts = boot.accounts;
  state.steamAccounts = boot.steamAccounts;
  state.steamClientFound = boot.steamClientFound;
  state.otherAccounts = boot.otherAccounts;
  state.regions = boot.regions;
  state.settings = boot.settings;
  state.schedule = boot.schedule;
  $("#version").textContent = `v${boot.version}`;
  render();
  if (boot.loadError) toast("error", t("toast.loadFailed"), errorText(boot.loadError.code, boot.loadError.detail), 8000);
  if (!boot.loggingAvailable) toast("info", t("toast.noLogging"), t("toast.noLoggingText"));
  await Promise.all([wireEvents(), IN_TAURI ? wireWindow() : Promise.resolve()]);
  renderSchedule();
  setInterval(renderSchedule, 20_000);
  if (!IN_TAURI && import.meta.env.DEV) runDemoScene();
  await finishLaunch();
}

start().catch(async (error) => {
  await finishLaunch();
  toast("error", t("toast.startFailed"), String(error), 10000);
});
