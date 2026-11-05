//! KCD Hukuk desktop shell (based on the kcdAI shell 2.0.5).
//!
//! A light window that opens the kcdAI build (a Claude artifact), hides Claude's own
//! bars, and adds what a desktop app needs: downloads, notifications, links in the
//! default browser, and updates that install themselves. Every kcdAI feature lives
//! in the build, so publishing the build updates the web, Mac and Windows apps at once.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{
    webview::{DownloadEvent, NewWindowResponse},
    AppHandle, Manager, RunEvent, Runtime, State, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

/// The kcdAI build. The build itself can move this (see `kcd_set_config`).
const DEFAULT_URL: &str = "https://claude.ai/artifact/TGniJ3KNVgcHiBJMH5Hkmw";
const HOST_JS: &str = include_str!("host.js");
const MAIN: &str = "main";
const UPDATE_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// Hosts that open inside the app window. Everything else opens in the default browser.
const INSIDE_HOSTS: &[&str] = &[
    "claude.ai",
    "claude.com",
    "anthropic.com",
    "claudeusercontent.com",
    "claudemcpcontent.com",
    "accounts.google.com",
    "appleid.apple.com",
    "login.microsoftonline.com",
];

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    css: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dialog_selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    frame_hint: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateState {
    /// idle | checking | downloading | ready | installed | current | error
    status: String,
    version: Option<String>,
    error: Option<String>,
}

impl Default for UpdateState {
    fn default() -> Self {
        Self { status: "idle".into(), version: None, error: None }
    }
}

#[derive(Default)]
struct AppState {
    config: Mutex<ShellConfig>,
    update: Mutex<UpdateState>,
    /// Windows: an update downloaded and waiting to install when the app closes.
    staged: Mutex<Option<(Update, Vec<u8>)>>,
    /// Download destinations by URL, to name the finished file.
    downloads: Mutex<HashMap<String, PathBuf>>,
    busy: Mutex<bool>,
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    }
}

fn host_allowed(host: &str) -> bool {
    INSIDE_HOSTS.iter().any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

fn stays_inside(url: &url::Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "data" | "blob" | "javascript" => true,
        // On macOS WebKit asks about every frame, not only the page: Cloudflare's browser
        // check, payment and help widgets all load in frames from other hosts. Blocking them
        // breaks Claude's sign-in ("Couldn't verify your browser"), so web addresses stay
        // inside; links meant for the browser arrive as new windows and go out from there.
        #[cfg(target_os = "macos")]
        "http" | "https" => true,
        // Windows (WebView2) asks only about the page itself.
        #[cfg(not(target_os = "macos"))]
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default();
            host == "tauri.localhost" || host == "localhost" || host_allowed(host)
        }
        _ => false,
    }
}

/// Popups that belong inside the app: sign-in windows and Claude's own windows.
/// Everything else (decision sources, help pages…) opens in the default browser.
fn popup_inside(url: &url::Url) -> bool {
    url.scheme() == "about" || url.host_str().map(host_allowed).unwrap_or(false)
}

/// Safari's user agent with the Safari version installed on this Mac. Google sign-in refuses
/// web views whose user agent lacks the Safari token, and a version that matches the real
/// WebKit keeps browser checks consistent.
#[cfg(target_os = "macos")]
fn safari_ua() -> String {
    let version = std::process::Command::new("/usr/bin/defaults")
        .args(["read", "/Applications/Safari.app/Contents/Info", "CFBundleShortVersionString"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit() || c == '.'))
        .unwrap_or_else(|| "18.5".to_string());
    format!("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{version} Safari/605.1.15")
}

/// WebKit on macOS ignores window.close() in popups; this script turns it into a title the
/// app watches, so sign-in popups close themselves when they are done.
#[cfg(target_os = "macos")]
const POPUP_CLOSE_JS: &str = "(function(){try{var c=window.close.bind(window);window.close=function(){try{document.title='__kcd_close__';}catch(e){}try{c();}catch(e){}};}catch(e){}})();";

fn open_outside<R: Runtime>(app: &AppHandle<R>, url: &str) {
    if let Ok(u) = url::Url::parse(url) {
        if matches!(u.scheme(), "http" | "https" | "mailto" | "tel") {
            let _ = app.opener().open_url(u.as_str(), None::<&str>);
        }
    }
}

/* ------------------------------------------------------------------ config file */

fn config_file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("kcd-shell.json"))
}

fn load_config<R: Runtime>(app: &AppHandle<R>) -> ShellConfig {
    config_file(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config<R: Runtime>(app: &AppHandle<R>, cfg: &ShellConfig) -> Result<(), String> {
    let path = config_file(app).ok_or("Ayar klasörü bulunamadı.")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn app_url(state: &AppState) -> String {
    state.config.lock().unwrap().url.clone().unwrap_or_else(|| DEFAULT_URL.to_string())
}

/// Only another claude.ai address may replace the kcdAI build address.
fn valid_build_url(raw: &str) -> bool {
    url::Url::parse(raw)
        .map(|u| {
            u.scheme() == "https"
                && u.host_str().map(|h| h == "claude.ai" || h.ends_with(".claude.ai")).unwrap_or(false)
        })
        .unwrap_or(false)
}

/* ------------------------------------------------------------------ events to the page */

fn emit_page<R: Runtime>(app: &AppHandle<R>, name: &str, data: serde_json::Value) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let js = format!(
            "window.__kcdShellEmit && window.__kcdShellEmit({}, {});",
            serde_json::to_string(name).unwrap_or_else(|_| "\"\"".into()),
            data
        );
        let _ = w.eval(js);
    }
}

fn set_update<R: Runtime>(app: &AppHandle<R>, status: &str, version: Option<String>, error: Option<String>) {
    let state = app.state::<AppState>();
    let snapshot = {
        let mut u = state.update.lock().unwrap();
        *u = UpdateState { status: status.into(), version, error };
        u.clone()
    };
    emit_page(app, "update", serde_json::to_value(snapshot).unwrap_or_default());
}

/* ------------------------------------------------------------------ updates */

async fn check_and_stage<R: Runtime>(app: AppHandle<R>) {
    {
        let state = app.state::<AppState>();
        let mut busy = state.busy.lock().unwrap();
        if *busy {
            return;
        }
        let status = state.update.lock().unwrap().status.clone();
        if status == "ready" || status == "installed" {
            return;
        }
        *busy = true;
    }
    stage_update(&app).await;
    *app.state::<AppState>().busy.lock().unwrap() = false;
}

async fn stage_update<R: Runtime>(app: &AppHandle<R>) {
    set_update(app, "checking", None, None);
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => return set_update(app, "error", None, Some(e.to_string())),
    };
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return set_update(app, "current", None, None),
        Err(e) => return set_update(app, "error", None, Some(e.to_string())),
    };
    let version = update.version.clone();
    set_update(app, "downloading", Some(version.clone()), None);
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(b) => b,
        Err(e) => return set_update(app, "error", Some(version), Some(e.to_string())),
    };

    if cfg!(target_os = "macos") {
        // Replaces the app bundle in place; the new version runs from the next launch.
        match update.install(&bytes) {
            Ok(()) => set_update(app, "installed", Some(version), None),
            Err(e) => set_update(app, "error", Some(version), Some(e.to_string())),
        }
    } else {
        // Windows: the installer needs the app closed, so it runs when the app closes
        // (or right away if the lawyer chooses "Yeniden başlat").
        *app.state::<AppState>().staged.lock().unwrap() = Some((update, bytes));
        set_update(app, "ready", Some(version), None);
    }
}

fn install_staged_and_exit<R: Runtime>(app: &AppHandle<R>, restart: bool) -> bool {
    let staged = app.state::<AppState>().staged.lock().unwrap().take();
    if let Some((update, bytes)) = staged {
        let update = update.restart_after_install(restart);
        // On Windows this starts the installer and exits the app.
        return update.install(bytes).is_ok();
    }
    false
}

/* ------------------------------------------------------------------ commands */

#[tauri::command]
fn kcd_config<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>) -> serde_json::Value {
    let cfg = state.config.lock().unwrap().clone();
    let update = state.update.lock().unwrap().clone();
    json!({
        "version": app.package_info().version.to_string(),
        "platform": platform(),
        "url": cfg.url.clone().unwrap_or_else(|| DEFAULT_URL.to_string()),
        "css": cfg.css,
        "dialogSelector": cfg.dialog_selector,
        "frameHint": cfg.frame_hint,
        "update": update,
    })
}

#[tauri::command]
fn kcd_set_config<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, cfg: ShellConfig) -> Result<(), String> {
    let mut current = state.config.lock().unwrap().clone();
    if let Some(url) = cfg.url.filter(|s| !s.trim().is_empty()) {
        if !valid_build_url(&url) {
            return Err("KCD Hukuk yalnızca claude.ai üzerindeki bir adresten açılabilir.".into());
        }
        current.url = Some(url);
    }
    if let Some(css) = cfg.css.filter(|s| !s.trim().is_empty()) {
        current.css = Some(css);
    }
    if let Some(sel) = cfg.dialog_selector.filter(|s| !s.trim().is_empty()) {
        current.dialog_selector = Some(sel);
    }
    if let Some(hint) = cfg.frame_hint.filter(|s| !s.trim().is_empty()) {
        current.frame_hint = Some(hint);
    }
    save_config(&app, &current)?;
    *state.config.lock().unwrap() = current;
    Ok(())
}

#[tauri::command]
fn kcd_notify<R: Runtime>(app: AppHandle<R>, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title.chars().take(120).collect::<String>())
        .body(body.chars().take(400).collect::<String>())
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn kcd_open_external<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    let u = url::Url::parse(&url).map_err(|_| "Geçersiz bağlantı.".to_string())?;
    if !matches!(u.scheme(), "http" | "https" | "mailto" | "tel") {
        return Err("Bu bağlantı türü açılamaz.".into());
    }
    app.opener().open_url(u.as_str(), None::<&str>).map_err(|e| e.to_string())
}

/// Is claude.ai reachable? Checked natively (DNS, then a TCP connection on port 443),
/// because a request made from the start page can fail inside the macOS web view even
/// when the internet works. Returns `{ ok, reason }`; reason is "dns" or "connect" on failure.
#[tauri::command]
async fn kcd_online() -> serde_json::Value {
    let result = tauri::async_runtime::spawn_blocking(|| {
        use std::net::{TcpStream, ToSocketAddrs};
        let addrs: Vec<_> = match ("claude.ai", 443).to_socket_addrs() {
            Ok(a) => a.collect(),
            Err(e) => return (false, format!("dns: {e}")),
        };
        if addrs.is_empty() {
            return (false, "dns: no address".to_string());
        }
        let mut last = String::new();
        for addr in addrs.iter().take(4) {
            match TcpStream::connect_timeout(addr, Duration::from_secs(5)) {
                Ok(_) => return (true, String::new()),
                Err(e) => last = format!("connect: {e}"),
            }
        }
        (false, last)
    })
    .await
    .unwrap_or_else(|e| (false, e.to_string()));
    json!({ "ok": result.0, "reason": result.1 })
}

fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let mut out: String = trimmed.chars().take(160).collect();
    if out.is_empty() {
        out = "KCD-Hukuk-dosya".into();
    }
    out
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| name.to_string());
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for i in 1..1000 {
        let c = dir.join(format!("{stem} ({i}){ext}"));
        if !c.exists() {
            return c;
        }
    }
    dir.join(format!("{stem}-{}{ext}", std::process::id()))
}

fn downloads_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| std::env::temp_dir())
}

#[tauri::command]
fn kcd_save_file<R: Runtime>(app: AppHandle<R>, name: String, data: String) -> Result<String, String> {
    let raw = data.split_once(',').map(|(head, rest)| if head.contains("base64") { rest } else { data.as_str() }).unwrap_or(&data);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|_| "Dosya içeriği okunamadı.".to_string())?;
    let dir = downloads_dir(&app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = unique_path(&dir, &safe_file_name(&name));
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn kcd_show_file<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let dir = downloads_dir(&app);
    if !p.starts_with(&dir) {
        return Err("Yalnızca İndirilenler klasöründeki dosyalar gösterilebilir.".into());
    }
    app.opener().reveal_item_in_dir(p).map_err(|e| e.to_string())
}

#[tauri::command]
async fn kcd_check_update<R: Runtime>(app: AppHandle<R>) -> Result<UpdateState, String> {
    check_and_stage(app.clone()).await;
    let state = app.state::<AppState>();
    let snapshot = state.update.lock().unwrap().clone();
    Ok(snapshot)
}

#[tauri::command]
fn kcd_restart<R: Runtime>(app: AppHandle<R>) {
    if cfg!(windows) && install_staged_and_exit(&app, true) {
        return;
    }
    app.restart();
}

#[tauri::command]
fn kcd_badge<R: Runtime>(app: AppHandle<R>, count: i64) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.set_badge_count(if count > 0 { Some(count) } else { None });
    }
}

/* ------------------------------------------------------------------ window */

fn host_script(app_url: &str) -> String {
    HOST_JS
        .replace("__KCD_APP_URL__", &app_url.replace('\\', "").replace('\'', ""))
        .replace("__KCD_VERSION__", env!("CARGO_PKG_VERSION"))
        .replace("__KCD_PLATFORM__", platform())
}

fn build_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let nav_app = app.clone();
    let popup_app = app.clone();
    #[cfg(target_os = "macos")]
    let popup_ua = safari_ua();
    let dl_app = app.clone();

    let start_url = app_url(&app.state::<AppState>());
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()));
    // Present the Mac window as Safari: Google sign-in refuses web views whose user agent
    // lacks the Safari token ("This browser or app may not be secure").
    #[cfg(target_os = "macos")]
    let ua = safari_ua();
    #[cfg(target_os = "macos")]
    let builder = builder.user_agent(&ua);
    builder
        .title("KCD Hukuk")
        .inner_size(1320.0, 860.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .initialization_script_for_all_frames(host_script(&start_url))
        .zoom_hotkeys_enabled(true)
        .on_navigation(move |url| {
            if stays_inside(url) {
                true
            } else {
                open_outside(&nav_app, url.as_str());
                false
            }
        })
        .on_new_window(move |url, features| {
            if !popup_inside(&url) {
                open_outside(&popup_app, url.as_str());
                return NewWindowResponse::Deny;
            }
            // macOS: build a real app window for the popup, so it carries the Safari user
            // agent and closes itself when the sign-in calls window.close().
            #[cfg(target_os = "macos")]
            {
                use std::sync::atomic::{AtomicUsize, Ordering};
                static POPUPS: AtomicUsize = AtomicUsize::new(0);
                let label = format!("popup-{}", POPUPS.fetch_add(1, Ordering::Relaxed));
                let built = WebviewWindowBuilder::new(&popup_app, label, WebviewUrl::External("about:blank".parse().unwrap()))
                    .window_features(features)
                    .title("KCD Hukuk")
                    .user_agent(&popup_ua)
                    .initialization_script_for_all_frames(POPUP_CLOSE_JS)
                    .on_document_title_changed(|w, title| {
                        if title == "__kcd_close__" {
                            let _ = w.close();
                        } else if !title.is_empty() {
                            let _ = w.set_title(&title);
                        }
                    })
                    .build();
                match built {
                    Ok(window) => NewWindowResponse::Create { window },
                    Err(_) => NewWindowResponse::Allow,
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = features;
                NewWindowResponse::Allow
            }
        })
        .on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let suggested = destination
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| {
                            url.path_segments()
                                .and_then(|mut s| s.next_back().map(|x| x.to_string()))
                                .filter(|s| !s.is_empty())
                                .unwrap_or_else(|| "KCD-Hukuk-dosya".into())
                        });
                    let dir = downloads_dir(&dl_app);
                    let _ = fs::create_dir_all(&dir);
                    let target = unique_path(&dir, &safe_file_name(&suggested));
                    *destination = target.clone();
                    dl_app.state::<AppState>().downloads.lock().unwrap().insert(url.to_string(), target);
                }
                DownloadEvent::Finished { url, path, success } => {
                    let saved = dl_app.state::<AppState>().downloads.lock().unwrap().remove(url.as_str()).or(path);
                    let name = saved
                        .as_ref()
                        .and_then(|p| p.file_name())
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| "Dosya".into());
                    if success {
                        let _ = dl_app.notification().builder().title("KCD Hukuk").body(format!("İndirildi: {name}")).show();
                    }
                    emit_page(
                        &dl_app,
                        "download",
                        json!({ "ok": success, "name": name, "path": saved.map(|p| p.to_string_lossy().to_string()) }),
                    );
                }
                _ => {}
            }
            true
        })
        .build()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let check = MenuItemBuilder::with_id("check_update", "Güncellemeleri denetle…").build(app)?;
    let reload = MenuItemBuilder::with_id("reload", "Yenile").accelerator("CmdOrCtrl+R").build(app)?;
    let logout = MenuItemBuilder::with_id("logout", "Çıkış yap (Claude hesabını değiştir)").build(app)?;
    let home = MenuItemBuilder::with_id("home", "KCD Hukuk'a dön").accelerator("CmdOrCtrl+Shift+H").build(app)?;
    let report = MenuItemBuilder::with_id("report", "Tanılama raporu oluştur").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "KCD Hukuk")
        .about(None)
        .separator()
        .item(&check)
        .separator()
        .item(&logout)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Düzen")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "Görünüm")
        .item(&reload)
        .item(&home)
        .separator()
        .item(&report)
        .separator()
        .fullscreen()
        .build()?;
    let window = SubmenuBuilder::new(app, "Pencere").minimize().maximize().separator().close_window().build()?;
    let menu = MenuBuilder::new(app).items(&[&app_menu, &edit, &view, &window]).build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| match event.id().as_ref() {
        "report" => {
            if let Some(w) = app.get_webview_window(MAIN) {
                let _ = w.eval("window.__kcdShellReport && window.__kcdShellReport()");
            }
        }
        "home" => {
            if let Some(w) = app.get_webview_window(MAIN) {
                let target = app_url(&app.state::<AppState>());
                if let Ok(u) = url::Url::parse(&target) {
                    let _ = w.navigate(u);
                }
            }
        }
        "reload" => {
            if let Some(w) = app.get_webview_window(MAIN) {
                let _ = w.eval("location.reload()");
            }
        }
        "logout" => sign_out(app),
        "check_update" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move { check_and_stage(handle).await });
        }
        _ => {}
    });
    Ok(())
}

/// Sign out: forget this window's Claude sign-in (cookies, storage) and show Claude's login
/// page; after signing in, the guard opens KCD Hukuk again.
fn sign_out<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.clear_all_browsing_data();
        if let Ok(u) = url::Url::parse("https://claude.ai/login") {
            let _ = w.navigate(u);
        }
    }
}

#[tauri::command]
fn kcd_logout<R: Runtime>(app: AppHandle<R>) {
    sign_out(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window(MAIN) {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            kcd_config,
            kcd_set_config,
            kcd_notify,
            kcd_open_external,
            kcd_save_file,
            kcd_show_file,
            kcd_check_update,
            kcd_restart,
            kcd_logout,
            kcd_badge,
            kcd_online
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            *app.state::<AppState>().config.lock().unwrap() = load_config(&handle);
            #[cfg(target_os = "macos")]
            build_menu(&handle)?;
            build_main_window(&handle)?;

            // Look for a new app version shortly after start, then every six hours.
            let updater_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(12)).await;
                loop {
                    check_and_stage(updater_handle.clone()).await;
                    tokio::time::sleep(UPDATE_EVERY).await;
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("KCD Hukuk başlatılamadı");

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            // Windows: finish a downloaded update quietly as the app closes.
            if cfg!(windows) {
                install_staged_and_exit(handle, false);
            }
        }
    });
}

