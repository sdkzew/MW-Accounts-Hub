use crate::views::{fail, fail_with, AppError, CommandResult};
use leagueaccounts::credentials;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};
use tauri::State;

const STEAM_SERVICE: &str = "MorphWrldRiftVault.Steam";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamAccount {
    pub username: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub steam_id: String,
    #[serde(default)]
    pub description: String,
    #[serde(skip_serializing, default)]
    pub password: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamAccountView {
    username: String,
    display_name: String,
    steam_id: String,
    description: String,
    has_password: bool,
}

impl From<&SteamAccount> for SteamAccountView {
    fn from(account: &SteamAccount) -> Self {
        Self {
            username: account.username.clone(),
            display_name: account.display_name.clone(),
            steam_id: account.steam_id.clone(),
            description: account.description.clone(),
            has_password: !account.password.is_empty(),
        }
    }
}

pub struct SteamShared {
    accounts: Mutex<Vec<SteamAccount>>,
    path: PathBuf,
}

pub type SteamState<'a> = State<'a, Arc<SteamShared>>;

impl SteamShared {
    pub fn load(path: PathBuf) -> Result<Self, AppError> {
        let mut accounts: Vec<SteamAccount> = if path.exists() {
            let json = std::fs::read_to_string(&path).map_err(|error| fail_with("steam_load_failed", error))?;
            serde_json::from_str(&json).map_err(|error| fail_with("steam_load_failed", error))?
        } else {
            Vec::new()
        };
        for account in &mut accounts {
            account.password = credentials::get_password(STEAM_SERVICE, &account.username)
                .ok()
                .flatten()
                .unwrap_or_default();
        }
        accounts.sort_by_key(|account| account.display_name.to_ascii_lowercase());
        Ok(Self { accounts: Mutex::new(accounts), path })
    }

    pub fn empty(path: PathBuf) -> Self {
        Self { accounts: Mutex::new(Vec::new()), path }
    }

    fn accounts(&self) -> CommandResult<MutexGuard<'_, Vec<SteamAccount>>> {
        self.accounts.lock().map_err(|_| fail("storage_locked"))
    }

    fn save(&self, accounts: &[SteamAccount]) -> CommandResult<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| fail_with("steam_save_failed", error))?;
        }
        let json = serde_json::to_string_pretty(accounts).map_err(|error| fail_with("steam_save_failed", error))?;
        std::fs::write(&self.path, json).map_err(|error| fail_with("steam_save_failed", error))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSteamAccount {
    username: String,
    display_name: String,
    steam_id: String,
    password: String,
    description: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSteamAccount {
    username: String,
    display_name: String,
    steam_id: String,
    description: String,
}

pub fn views(state: &SteamShared) -> CommandResult<Vec<SteamAccountView>> {
    Ok(state.accounts()?.iter().map(SteamAccountView::from).collect())
}

#[tauri::command]
pub fn list_steam_accounts(state: SteamState<'_>) -> CommandResult<Vec<SteamAccountView>> {
    views(&state)
}

#[tauri::command]
pub fn add_steam_account(state: SteamState<'_>, input: NewSteamAccount) -> CommandResult<SteamAccountView> {
    let username = input.username.trim().to_owned();
    let password = input.password.trim().to_owned();
    if username.is_empty() || password.is_empty() {
        return Err(fail("required_fields"));
    }
    let mut accounts = state.accounts()?;
    if accounts.iter().any(|account| account.username.eq_ignore_ascii_case(&username)) {
        return Err(fail("duplicate"));
    }
    credentials::set_password(STEAM_SERVICE, &username, &password)
        .map_err(|error| fail_with("password_save", error))?;
    let account = SteamAccount {
        username,
        display_name: input.display_name.trim().to_owned(),
        steam_id: input.steam_id.trim().to_owned(),
        password,
        description: input.description.trim().to_owned(),
    };
    accounts.push(account.clone());
    accounts.sort_by_key(|account| account.display_name.to_ascii_lowercase());
    state.save(&accounts)?;
    Ok(SteamAccountView::from(&account))
}

#[tauri::command]
pub fn update_steam_account(state: SteamState<'_>, input: UpdateSteamAccount) -> CommandResult<SteamAccountView> {
    let mut accounts = state.accounts()?;
    let account = accounts
        .iter_mut()
        .find(|account| account.username.eq_ignore_ascii_case(input.username.trim()))
        .ok_or_else(|| fail("not_found"))?;
    account.display_name = input.display_name.trim().to_owned();
    account.steam_id = input.steam_id.trim().to_owned();
    account.description = input.description.trim().to_owned();
    let updated = account.clone();
    state.save(&accounts)?;
    Ok(SteamAccountView::from(&updated))
}

#[tauri::command]
pub fn delete_steam_account(state: SteamState<'_>, username: String) -> CommandResult<()> {
    let mut accounts = state.accounts()?;
    let before = accounts.len();
    accounts.retain(|account| !account.username.eq_ignore_ascii_case(username.trim()));
    if accounts.len() == before {
        return Err(fail("not_found"));
    }
    credentials::delete_password(STEAM_SERVICE, username.trim())
        .map_err(|error| fail_with("delete_failed", error))?;
    state.save(&accounts)
}

pub fn password_for(state: &SteamShared, username: &str) -> CommandResult<String> {
    let accounts = state.accounts()?;
    let account = accounts
        .iter()
        .find(|account| account.username.eq_ignore_ascii_case(username))
        .ok_or_else(|| fail("not_found"))?;
    if !account.password.is_empty() {
        return Ok(account.password.clone());
    }
    credentials::get_password(STEAM_SERVICE, &account.username)
        .map_err(|error| fail_with("credential_read", error))?
        .filter(|password| !password.is_empty())
        .ok_or_else(|| fail("no_password"))
}

fn registry_steam_path() -> Option<PathBuf> {
    let output = Command::new("reg.exe")
        .args(["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamExe"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().find_map(|line| {
        line.split_once("REG_SZ")
            .map(|(_, value)| PathBuf::from(value.trim().replace('/', "\\")))
            .filter(|path| path.is_file())
    })
}

pub fn client_path() -> Option<PathBuf> {
    registry_steam_path().or_else(|| {
        ["PROGRAMFILES(X86)", "PROGRAMFILES"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .map(|base| base.join("Steam").join("steam.exe"))
            .find(|path| path.is_file())
    })
}

fn client_running() -> bool {
    Command::new("tasklist.exe")
        .args(["/FI", "IMAGENAME eq steam.exe", "/NH"])
        .output()
        .ok()
        .is_some_and(|output| String::from_utf8_lossy(&output.stdout).to_ascii_lowercase().contains("steam.exe"))
}

fn wait_for_exit(timeout: Duration) {
    let started = Instant::now();
    while client_running() && started.elapsed() < timeout {
        thread::sleep(Duration::from_millis(350));
    }
}

pub fn login(username: &str, password: &str) -> CommandResult<()> {
    let client = client_path().ok_or_else(|| fail("steam_missing"))?;
    if client_running() {
        let _ = Command::new(&client).arg("-shutdown").spawn();
        wait_for_exit(Duration::from_secs(12));
    }
    Command::new(&client)
        .args(["-login", username, password])
        .spawn()
        .map(|_| ())
        .map_err(|error| fail_with("steam_launch_failed", error))
}

pub fn accounts_path(base: &Path) -> PathBuf {
    base.join("steam_accounts.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_steam_accounts_never_include_passwords() {
        let account = SteamAccount {
            username: "vault.user".to_owned(),
            display_name: "Vault".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            description: String::new(),
            password: "do-not-persist".to_owned(),
        };
        let json = serde_json::to_string(&account).unwrap();
        assert!(!json.contains("do-not-persist"));
        assert!(!json.contains("password"));
    }
}
