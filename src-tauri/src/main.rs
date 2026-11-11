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

    // ponytail: NVIDIA only, since that is every report so far; widen the check if other GPUs show up.
    // WebKitGTK's DMA-BUF renderer kills the app on NVIDIA under Wayland ("Error 71", #140, #125).
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::path::Path::new("/proc/driver/nvidia/version").exists()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    zuno_lib::run()
}
