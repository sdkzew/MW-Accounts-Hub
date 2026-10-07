// Development-only stand-in for the Tauri backend, used when the UI is opened
// in a plain browser (`npm run dev`). Never bundled into release builds.
import { api, events, keyId, parseAccountLine, type AccountView, type Key, type NewAccount, type NewOtherAccount, type NewSteamAccount, type OtherAccountView, type RefreshDone, type RiotGame, type SteamAccountView } from "./api";

const lol = (tier: string, division: string, lp: string, finished = "Gold II", reached = finished) => ({
  tier,
  division,
  lp,
  reachedLastSeason: reached,
  finishedLastSeason: finished,
});
const tft = (tier: string, division: string, lp: string, lastSet = "Unranked") => ({ tier, division, lp, lastSet });
const profileIcons = [6794, 4568, 5430, 6504, 29, 23, 6, 10];
const gameSets: RiotGame[][] = [
  ["lol", "tft", "valorant"], ["lol"], ["lol", "tft"], ["tft"],
  ["lol", "valorant"], ["lol", "tft"], ["valorant"], ["lol"],
];

const sample: AccountView[] = [
  ["mainacc01", "Hextech Fox#EUW", "EUW", "412", "main", lol("Diamond", "II", "57", "Emerald I", "Diamond IV 12LP"), tft("Master", "", "142", "Diamond I")],
  ["smurfy_tr", "Kebab Enjoyer#TR1", "TR", "187", "smurf", lol("Emerald", "IV", "23", "Platinum I"), tft("Gold", "III", "64", "Gold IV")],
  ["duoqueen", "Piltover Queen#NA1", "NA", "301", "", lol("Challenger", "", "1124", "Grandmaster 640LP", "Challenger 1302LP"), tft("Unranked", "", "")],
  ["aramonly", "Snowball King#EUW", "EUW", "95", "ARAM", lol("Unranked", "", "", "Unranked"), tft("Platinum", "I", "88", "Silver I")],
  ["ironwill", "Iron Will#EUNE", "EUNE", "38", "", lol("Silver", "I", "12", "Bronze II"), tft("Iron", "II", "40")],
  ["goldenboy", "Golden Boy#KR1", "KR", "256", "Lee Sin OTP", lol("Gold", "III", "76", "Gold I", "Platinum IV"), tft("Emerald", "II", "5", "Platinum II")],
  ["gm_lux", "Lux Main#EUW", "EUW", "520", "", lol("Grandmaster", "", "512", "Master 210LP"), tft("Diamond", "IV", "0", "Emerald I")],
  ["bronzie", "Bronze Spirit#TR1", "TR", "61", "", lol("Bronze", "I", "99", "Iron I"), tft("Bronze", "IV", "17")],
].map(([accountId, name, regionDisplay, level, description, lolRank, tftRank], index) => ({
  accountId: accountId as string,
  name: name as string,
  games: gameSets[index],
  riotIdNotFound: false,
  region: (regionDisplay as string).toLowerCase(),
  regionDisplay: regionDisplay as string,
  level: level as string,
  profileIconUrl: `https://opgg-static.akamaized.net/meta/images/profile_icons/profileIcon${profileIcons[index]}.jpg`,
  description: description as string,
  hasPassword: true,
  lol: lolRank as AccountView["lol"],
  tft: tftRank as AccountView["tft"],
}));

const steamSample: SteamAccountView[] = [
  { username: "morph.main", displayName: "MORPH", steamId: "76561198123456789", description: "Primary library", hasPassword: true },
  { username: "night.queue", displayName: "Night Queue", steamId: "76561198987654321", description: "Competitive", hasPassword: true },
  { username: "vault.alt", displayName: "Vault Alt", steamId: "", description: "Secondary", hasPassword: true },
];

const otherSample: OtherAccountView[] = [
  { platform: "epic", username: "morph@example.com", displayName: "MORPH Epic", description: "Primary library", hasPassword: true },
  { platform: "ea", username: "vault@example.com", displayName: "Vault EA", description: "EA Play", hasPassword: true },
];

type Handler<T> = (payload: T) => void;
const listeners = {
  step: [] as Handler<string>[],
  pending: [] as Handler<Key[]>[],
  update: [] as Handler<AccountView>[],
  done: [] as Handler<RefreshDone>[],
};
const unlisten = () => () => {};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const settings = {
  autoRefresh: true,
  intervalMinutes: 30,
  startMinimized: false,
  launchAtStartup: false,
  loginMethod: "riot" as const,
  launchGame: true,
  riotClientFound: true,
  tftInstalled: true,
  valorantInstalled: true,
};

export function installMock(): void {
  let accounts = structuredClone(sample);
  let steamAccounts = structuredClone(steamSample);
  let otherAccounts = structuredClone(otherSample);
  const find = (key: Key) => accounts.find((account) => keyId(account) === keyId(key));
  const fakeFetch = (targets: AccountView[], exclusive = false) => {
    listeners.pending.forEach((handler) => handler(targets.map((account) => ({ accountId: account.accountId, region: account.region }))));
    targets.forEach((account, index) => {
      setTimeout(() => {
        const stored = find(account);
        if (stored?.name === account.name) {
          Object.assign(stored, account);
          listeners.update.forEach((handler) => handler(stored));
        }
        if (index === targets.length - 1) listeners.done.forEach((handler) => handler({ error: null, exclusive, auto: false }));
      }, 500 + index * 260);
    });
  };

  Object.assign(api, {
    bootstrap: async () => ({
      accounts,
      steamAccounts,
      steamClientFound: true,
      otherAccounts,
      regions: ["EUW", "EUNE", "NA", "KR", "TR", "BR"],
      version: "1.0.0",
      loggingAvailable: true,
      loadError: null,
      settings,
      schedule: { enabled: true, intervalMinutes: 30, nextAt: Date.now() + 23 * 60_000, lastAt: Date.now() - 7 * 60_000, running: false },
    }),
    getSettings: async () => settings,
    updateSettings: async (input: object) => Object.assign(settings, input),
    login: async () => {
      const steps = ["openClient", "waitAuth", "findWindow", "focus", "type", "confirm", "launchGame", "done"];
      for (const step of steps) {
        listeners.step.forEach((handler) => handler(step));
        await wait(step === "waitAuth" || step === "confirm" ? 1400 : 700);
      }
      return "signedIn";
    },
    cancelLogin: async () => {},
    gameStatus: async () => ({ clientOpen: false, inGame: false, sameAccount: false }),
    checkUpdate: async () => ({
      current: "1.0.0",
      newer: true,
      latest: { version: "1.1.0", name: "v1.1.0", url: "https://github.com/", notes: "", publishedAt: "" },
    }),
    openRelease: async () => {},
    listAccounts: async () => accounts,
    addAccount: async (input: NewAccount) => {
      const account: AccountView = {
        accountId: input.accountId,
        name: input.name.trim(),
        games: input.games,
        riotIdNotFound: false,
        region: input.region.toLowerCase(),
        regionDisplay: input.region,
        description: input.description,
        level: "",
        profileIconUrl: "",
        hasPassword: true,
        lol: lol("Unranked", "", "", "N/A"),
        tft: tft("Unranked", "", "", "N/A"),
      };
      accounts.push(account);
      if (account.name) setTimeout(() => fakeFetch([{ ...account, level: "30", lol: lol("Silver", "II", "45", "Bronze I") }]), 50);
      return account;
    },
    multiAdd: async (text: string, region: string, games: RiotGame[]) => {
      let added = 0;
      let skipped = 0;
      for (const line of text.split("\n").filter((line) => line.trim())) {
        const input = parseAccountLine(line);
        if (!input || accounts.some((account) => account.accountId.toLowerCase() === input.accountId.toLowerCase() && account.region === region.toLowerCase())) {
          skipped++;
          continue;
        }
        await api.addAccount({ ...input, games, region, description: "" });
        added++;
      }
      return { added, skipped };
    },
    updateAccount: async (key: Key, name: string, description: string, games: RiotGame[]) => {
      const account = find(key)!;
      name = name.trim();
      const renamed = account.name !== name;
      Object.assign(account, { name, description, games });
      if (renamed) {
        Object.assign(account, { riotIdNotFound: false, level: "", profileIconUrl: "", lol: lol("Unranked", "", "", "N/A"), tft: tft("Unranked", "", "", "N/A") });
        const updated = name ? { ...account, level: "30", lol: lol("Silver", "II", "45", "Bronze I") } : { ...account };
        setTimeout(() => fakeFetch([updated]), 50);
      }
      return account;
    },
    deleteAccount: async (key: Key) => {
      accounts = accounts.filter((account) => keyId(account) !== keyId(key));
    },
    refreshRanks: async () => {
      setTimeout(() => fakeFetch(accounts, true), 50);
      return accounts.length;
    },
    copyAccountId: async () => {},
    copyPassword: async () => 30,
    exportData: async () => "C:\\Users\\demo\\credentials.json",
    importData: async () => null,
    openProfile: async () => {},
    openLogsFolder: async () => {},
    listSteamAccounts: async () => steamAccounts,
    addSteamAccount: async (input: NewSteamAccount) => {
      const account: SteamAccountView = {
        username: input.username.trim(),
        displayName: input.displayName.trim(),
        steamId: input.steamId.trim(),
        description: input.description.trim(),
        hasPassword: true,
      };
      steamAccounts.push(account);
      return account;
    },
    updateSteamAccount: async (input: Omit<NewSteamAccount, "password">) => {
      const account = steamAccounts.find((candidate) => candidate.username === input.username)!;
      Object.assign(account, input);
      return account;
    },
    deleteSteamAccount: async (username: string) => {
      steamAccounts = steamAccounts.filter((account) => account.username !== username);
    },
    copySteamUsername: async () => {},
    copySteamPassword: async () => 30,
    steamLogin: async () => { await wait(900); },
    listOtherAccounts: async () => otherAccounts,
    addOtherAccount: async (input: NewOtherAccount) => {
      const account: OtherAccountView = {
        platform: input.platform,
        username: input.username.trim(),
        displayName: input.displayName.trim(),
        description: input.description.trim(),
        hasPassword: true,
      };
      otherAccounts.push(account);
      return account;
    },
    updateOtherAccount: async (input: Omit<NewOtherAccount, "password">) => {
      const account = otherAccounts.find((candidate) => candidate.platform === input.platform && candidate.username === input.username)!;
      Object.assign(account, input);
      return account;
    },
    deleteOtherAccount: async (platform: string, username: string) => {
      otherAccounts = otherAccounts.filter((account) => account.platform !== platform || account.username !== username);
    },
    copyOtherUsername: async () => {},
    copyOtherPassword: async () => 30,
    launchOtherClient: async () => { await wait(500); },
  });
  Object.assign(events, {
    onLoginStep: async (handler: Handler<string>) => (listeners.step.push(handler), unlisten()),
    onUpdateAvailable: async () => unlisten(),
    onRefreshStarted: async () => unlisten(),
    onSchedule: async () => unlisten(),
    onRankPending: async (handler: Handler<Key[]>) => (listeners.pending.push(handler), unlisten()),
    onRankUpdate: async (handler: Handler<AccountView>) => (listeners.update.push(handler), unlisten()),
    onRefreshDone: async (handler: Handler<RefreshDone>) => (listeners.done.push(handler), unlisten()),
  });
}
