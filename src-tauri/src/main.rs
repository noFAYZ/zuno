// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
fn set_windows_app_identity() {
    use windows::{core::w, Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID};

    if let Err(error) =
        unsafe { SetCurrentProcessExplicitAppUserModelID(w!("com.zuno.desktop")) }
    {
        eprintln!("[internal][tauri][warn] unable to set Windows AppUserModelID: {error}");
    }
}

fn main() {
    #[cfg(target_os = "windows")]
    set_windows_app_identity();

    // Some dev setups enable WebView2 "Visual Diagnostics" via environment variables,
    // which shows an annoying size/diagnostics label overlay in the top-left.
    // Ensure the app never inherits that overlay.
    std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
    zuno_lib::run()
}
