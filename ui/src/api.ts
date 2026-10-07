import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface Key {
  accountId: string;
  region: string;
}

export interface LolRank {
  tier: string;
  division: string;
  lp: string;
  reachedLastSeason: string;
  finishedLastSeason: string;
}

export interface TftRank {
  tier: string;
  division: string;
  lp: string;
  lastSet: string;
}

export type LoginMethod = "riot" | "previous";

export interface Settings {
  autoRefresh: boolean;
  intervalMinutes: number;
  startMinimized: boolean;
  launchAtStartup: boolean;
  loginMethod: LoginMethod;
  launchGame: boolean;
  checkUpdates: boolean;
  riotClientFound: boolean;
  tftInstalled: boolean;
  valorantInstalled: boolean;
}

export type SettingsInput = Omit<Settings, "riotClientFound" | "tftInstalled" | "valorantInstalled">;

export interface Schedule {
  enabled: boolean;
  intervalMinutes: number;
  nextAt: number | null;
  lastAt: number | null;
  running: boolean;
}

export type LoginStep =
  | "closeLeague"
  | "openClient"
  | "waitAuth"
  | "signOut"
  | "findWindow"
  | "focus"
  | "type"
  | "confirm"
  | "launchGame"
  | "done";

export interface GameStatus {
  clientOpen: boolean;
  inGame: boolean;
  sameAccount: boolean;
}

export interface Release {
  version: string;
  name: string;
  url: string;
  notes: string;
  publishedAt: string;
}

export interface UpdateStatus {
  current: string;
  latest: Release | null;
  newer: boolean;
}

export type LoginResult = "signedIn" | "typed" | "alreadySignedIn" | "otherAccount";

export interface AccountView {
  accountId: string;
  name: string;
  games: RiotGame[];
  riotIdNotFound: boolean;
  region: string;
  regionDisplay: string;
  description: string;
  level: string;
  profileIconUrl: string;
  hasPassword: boolean;
  lol: LolRank;
  tft: TftRank;
}

export interface SteamAccountView {
  username: string;
  displayName: string;
  steamId: string;
  description: string;
  hasPassword: boolean;
}

export interface NewSteamAccount {
  username: string;
  displayName: string;
  steamId: string;
  password: string;
  description: string;
}

export type OtherPlatform = "epic" | "ea";

export interface OtherAccountView {
  platform: OtherPlatform;
  username: string;
  displayName: string;
  description: string;
  hasPassword: boolean;
}

export interface NewOtherAccount {
  platform: OtherPlatform;
  username: string;
  displayName: string;
  password: string;
  description: string;
}

export const accountLabel = (account: AccountView): string => account.name || account.accountId;

/** Backend failure: a stable code the UI translates, plus optional detail. */
export interface ErrorPayload {
  code: string;
  detail: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string | null = null,
  ) {
    super(code);
  }
}

export interface RefreshDone {
  error: ErrorPayload | null;
  /** True for a full refresh, false for a single-account refresh. */
  exclusive: boolean;
  auto: boolean;
}

export interface RefreshStarted {
  total: number;
  auto: boolean;
}

export interface Bootstrap {
  accounts: AccountView[];
  steamAccounts: SteamAccountView[];
  steamClientFound: boolean;
  otherAccounts: OtherAccountView[];
  regions: string[];
  version: string;
  loggingAvailable: boolean;
  loadError: ErrorPayload | null;
  settings: Settings;
  schedule: Schedule;
}

export interface BatchResult {
  added: number;
  skipped: number;
}

export interface NewAccount {
  accountId: string;
  name: string;
  games: RiotGame[];
  region: string;
  password: string;
  description: string;
}

export type RiotGame = "lol" | "tft" | "valorant";

export function parseAccountLine(line: string): Pick<NewAccount, "accountId" | "name" | "password"> | undefined {
  for (const separator of ["---", "--"]) {
    const parts = line.split(separator).map((part) => part.trim());
    if (parts.length === 3 && parts[0] && parts[2]) {
      return { accountId: parts[0], name: parts[1], password: parts[2] };
    }
  }
}

export const keyOf = (account: AccountView): Key => ({
  accountId: account.accountId,
  region: account.region,
});

export const keyId = (key: Key): string => `${key.region}:${key.accountId}`;

/** Tauri rejects with the command's `Err(AppError)`; normalize to ApiError. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const payload = error as ErrorPayload;
      throw new ApiError(payload.code, payload.detail);
    }
    throw new ApiError("unknown", String(error));
  }
}

export const api = {
  bootstrap: () => call<Bootstrap>("bootstrap"),
  listAccounts: () => call<AccountView[]>("list_accounts"),
  addAccount: (input: NewAccount) => call<AccountView>("add_account", { input }),
  multiAdd: (text: string, region: string, games: RiotGame[]) => call<BatchResult>("multi_add", { text, region, games }),
  updateAccount: (key: Key, name: string, description: string, games: RiotGame[]) =>
    call<AccountView>("update_account", { key, name, description, games }),
  deleteAccount: (key: Key) => call<void>("delete_account", { key }),
  refreshRanks: () => call<number>("refresh_ranks"),
  copyAccountId: (key: Key) => call<void>("copy_account_id", { key }),
  copyPassword: (key: Key) => call<number>("copy_password", { key }),
  login: (key: Key, game: "lol" | "tft" | "valorant", switchAccount: boolean, closeRunning: boolean) =>
    call<LoginResult>("login", { key, game, switchAccount, closeRunning }),
  cancelLogin: () => call<void>("cancel_login"),
  gameStatus: (key: Key) => call<GameStatus>("game_status", { key }),
  checkUpdate: () => call<UpdateStatus>("check_update"),
  openRelease: (url: string) => call<void>("open_release", { url }),
  getSettings: () => call<Settings>("get_settings"),
  updateSettings: (input: SettingsInput) => call<Settings>("update_settings", { input }),
  exportData: (title: string) => call<string | null>("export_data", { title }),
  importData: (title: string) => call<BatchResult | null>("import_data", { title }),
  openProfile: (key: Key, tft: boolean) => call<void>("open_profile", { key, tft }),
  openLogsFolder: () => call<void>("open_logs_folder"),
  listSteamAccounts: () => call<SteamAccountView[]>("list_steam_accounts"),
  addSteamAccount: (input: NewSteamAccount) => call<SteamAccountView>("add_steam_account", { input }),
  updateSteamAccount: (input: Omit<NewSteamAccount, "password">) => call<SteamAccountView>("update_steam_account", { input }),
  deleteSteamAccount: (username: string) => call<void>("delete_steam_account", { username }),
  copySteamUsername: (username: string) => call<void>("copy_steam_username", { username }),
  copySteamPassword: (username: string) => call<number>("copy_steam_password", { username }),
  steamLogin: (username: string) => call<void>("steam_login", { username }),
  listOtherAccounts: () => call<OtherAccountView[]>("list_other_accounts"),
  addOtherAccount: (input: NewOtherAccount) => call<OtherAccountView>("add_other_account", { input }),
  updateOtherAccount: (input: Omit<NewOtherAccount, "password">) => call<OtherAccountView>("update_other_account", { input }),
  deleteOtherAccount: (platform: OtherPlatform, username: string) => call<void>("delete_other_account", { platform, username }),
  copyOtherUsername: (username: string) => call<void>("copy_other_username", { username }),
  copyOtherPassword: (platform: OtherPlatform, username: string) => call<number>("copy_other_password", { platform, username }),
  launchOtherClient: (platform: OtherPlatform) => call<void>("launch_other_client", { platform }),
};

export const events = {
  onLoginStep: (handler: (step: LoginStep) => void): Promise<UnlistenFn> =>
    listen<LoginStep>("login-step", (event) => handler(event.payload)),
  onUpdateAvailable: (handler: (release: Release) => void): Promise<UnlistenFn> =>
    listen<Release>("update-available", (event) => handler(event.payload)),
  onRefreshStarted: (handler: (started: RefreshStarted) => void): Promise<UnlistenFn> =>
    listen<RefreshStarted>("refresh-started", (event) => handler(event.payload)),
  onSchedule: (handler: (schedule: Schedule) => void): Promise<UnlistenFn> =>
    listen<Schedule>("schedule", (event) => handler(event.payload)),
  onRankPending: (handler: (keys: Key[]) => void): Promise<UnlistenFn> =>
    listen<Key[]>("rank-pending", (event) => handler(event.payload)),
  onRankUpdate: (handler: (account: AccountView) => void): Promise<UnlistenFn> =>
    listen<AccountView>("rank-update", (event) => handler(event.payload)),
  onRefreshDone: (handler: (done: RefreshDone) => void): Promise<UnlistenFn> =>
    listen<RefreshDone>("refresh-done", (event) => handler(event.payload)),
};
