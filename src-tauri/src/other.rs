use crate::views::{fail, fail_with, AppError, CommandResult};
use leagueaccounts::credentials;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::State;

const OTHER_SERVICE: &str = "MorphWrldVault.Other";
const PLATFORMS: [&str; 2] = ["epic", "ea"];

fn normalized_platform(value: &str) -> CommandResult<String> {
    let platform = value.trim().to_ascii_lowercase();
    PLATFORMS
        .contains(&platform.as_str())
        .then_some(platform)
        .ok_or_else(|| fail("unsupported_platform"))
}

fn credential_key(platform: &str, username: &str) -> String {
    format!("{}:{}", platform, username)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtherAccount {
    pub platform: String,
    pub username: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(skip_serializing, default)]
    pub password: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtherAccountView {
    platform: String,
    username: String,
    display_name: String,
    description: String,
    has_password: bool,
}

impl From<&OtherAccount> for OtherAccountView {
    fn from(account: &OtherAccount) -> Self {
        Self {
            platform: account.platform.clone(),
            username: account.username.clone(),
            display_name: account.display_name.clone(),
            description: account.description.clone(),
            has_password: !account.password.is_empty(),
        }
    }
}

pub struct OtherShared {
    accounts: Mutex<Vec<OtherAccount>>,
    path: PathBuf,
}

pub type OtherState<'a> = State<'a, Arc<OtherShared>>;

impl OtherShared {
    pub fn load(path: PathBuf) -> Result<Self, AppError> {
        let mut accounts: Vec<OtherAccount> = if path.exists() {
            let json = std::fs::read_to_string(&path).map_err(|error| fail_with("other_load_failed", error))?;
            serde_json::from_str(&json).map_err(|error| fail_with("other_load_failed", error))?
        } else {
            Vec::new()
        };
        for account in &mut accounts {
            account.platform = normalized_platform(&account.platform).unwrap_or_else(|_| "epic".to_owned());
            account.password = credentials::get_password(
                OTHER_SERVICE,
                &credential_key(&account.platform, &account.username),
            )
            .ok()
            .flatten()
            .unwrap_or_default();
        }
        accounts.sort_by_key(|account| (account.platform.clone(), account.display_name.to_ascii_lowercase()));
        Ok(Self { accounts: Mutex::new(accounts), path })
    }

    pub fn empty(path: PathBuf) -> Self {
        Self { accounts: Mutex::new(Vec::new()), path }
    }

    fn accounts(&self) -> CommandResult<MutexGuard<'_, Vec<OtherAccount>>> {
        self.accounts.lock().map_err(|_| fail("storage_locked"))
    }

    fn save(&self, accounts: &[OtherAccount]) -> CommandResult<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| fail_with("other_save_failed", error))?;
        }
        let json = serde_json::to_string_pretty(accounts).map_err(|error| fail_with("other_save_failed", error))?;
        std::fs::write(&self.path, json).map_err(|error| fail_with("other_save_failed", error))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewOtherAccount {
    platform: String,
    username: String,
    display_name: String,
    password: String,
    description: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOtherAccount {
    platform: String,
    username: String,
    display_name: String,
    description: String,
}

pub fn views(state: &OtherShared) -> CommandResult<Vec<OtherAccountView>> {
    Ok(state.accounts()?.iter().map(OtherAccountView::from).collect())
}

#[tauri::command]
pub fn list_other_accounts(state: OtherState<'_>) -> CommandResult<Vec<OtherAccountView>> {
    views(&state)
}

#[tauri::command]
pub fn add_other_account(state: OtherState<'_>, input: NewOtherAccount) -> CommandResult<OtherAccountView> {
    let platform = normalized_platform(&input.platform)?;
    let username = input.username.trim().to_owned();
    let password = input.password.trim().to_owned();
    if username.is_empty() || password.is_empty() {
        return Err(fail("required_fields"));
    }
    let mut accounts = state.accounts()?;
    if accounts.iter().any(|account| {
        account.platform == platform && account.username.eq_ignore_ascii_case(&username)
    }) {
        return Err(fail("duplicate"));
    }
    credentials::set_password(OTHER_SERVICE, &credential_key(&platform, &username), &password)
        .map_err(|error| fail_with("password_save", error))?;
    let account = OtherAccount {
        platform,
        username,
        display_name: input.display_name.trim().to_owned(),
        password,
        description: input.description.trim().to_owned(),
    };
    accounts.push(account.clone());
    accounts.sort_by_key(|item| (item.platform.clone(), item.display_name.to_ascii_lowercase()));
    state.save(&accounts)?;
    Ok(OtherAccountView::from(&account))
}

#[tauri::command]
pub fn update_other_account(state: OtherState<'_>, input: UpdateOtherAccount) -> CommandResult<OtherAccountView> {
    let platform = normalized_platform(&input.platform)?;
    let mut accounts = state.accounts()?;
    let account = accounts
        .iter_mut()
        .find(|account| account.platform == platform && account.username.eq_ignore_ascii_case(input.username.trim()))
        .ok_or_else(|| fail("not_found"))?;
    account.display_name = input.display_name.trim().to_owned();
    account.description = input.description.trim().to_owned();
    let updated = account.clone();
    state.save(&accounts)?;
    Ok(OtherAccountView::from(&updated))
}

#[tauri::command]
pub fn delete_other_account(state: OtherState<'_>, platform: String, username: String) -> CommandResult<()> {
    let platform = normalized_platform(&platform)?;
    let mut accounts = state.accounts()?;
    let before = accounts.len();
    accounts.retain(|account| {
        !(account.platform == platform && account.username.eq_ignore_ascii_case(username.trim()))
    });
    if accounts.len() == before {
        return Err(fail("not_found"));
    }
    credentials::delete_password(OTHER_SERVICE, &credential_key(&platform, username.trim()))
        .map_err(|error| fail_with("delete_failed", error))?;
    state.save(&accounts)
}

pub fn password_for(state: &OtherShared, platform: &str, username: &str) -> CommandResult<String> {
    let platform = normalized_platform(platform)?;
    let accounts = state.accounts()?;
    let account = accounts
        .iter()
        .find(|account| account.platform == platform && account.username.eq_ignore_ascii_case(username))
        .ok_or_else(|| fail("not_found"))?;
    if !account.password.is_empty() {
        return Ok(account.password.clone());
    }
    credentials::get_password(OTHER_SERVICE, &credential_key(&platform, &account.username))
        .map_err(|error| fail_with("credential_read", error))?
        .filter(|password| !password.is_empty())
        .ok_or_else(|| fail("no_password"))
}

fn program_dirs() -> impl Iterator<Item = PathBuf> {
    ["PROGRAMFILES", "PROGRAMFILES(X86)"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
}

pub fn client_path(platform: &str) -> Option<PathBuf> {
    let platform = normalized_platform(platform).ok()?;
    let candidates: Vec<PathBuf> = match platform.as_str() {
        "epic" => program_dirs()
            .map(|base| base.join("Epic Games").join("Launcher").join("Portal").join("Binaries").join("Win64").join("EpicGamesLauncher.exe"))
            .collect(),
        "ea" => program_dirs()
            .flat_map(|base| [
                base.join("Electronic Arts").join("EA Desktop").join("EA Desktop").join("EADesktop.exe"),
                base.join("Origin").join("Origin.exe"),
            ])
            .collect(),
        _ => Vec::new(),
    };
    candidates.into_iter().find(|path| path.is_file())
}

#[tauri::command]
pub fn launch_other_client(platform: String) -> CommandResult<()> {
    let platform = normalized_platform(&platform)?;
    let client = client_path(&platform).ok_or_else(|| fail("other_client_missing"))?;
    Command::new(client)
        .spawn()
        .map(|_| ())
        .map_err(|error| fail_with("other_launch_failed", error))
}

pub fn accounts_path(base: &Path) -> PathBuf {
    base.join("other_accounts.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_other_accounts_never_include_passwords() {
        let account = OtherAccount {
            platform: "epic".to_owned(),
            username: "vault@example.com".to_owned(),
            display_name: "Vault".to_owned(),
            description: String::new(),
            password: "do-not-persist".to_owned(),
        };
        let json = serde_json::to_string(&account).unwrap();
        assert!(!json.contains("do-not-persist"));
        assert!(!json.contains("password"));
    }
}
