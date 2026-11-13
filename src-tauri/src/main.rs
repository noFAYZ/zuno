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

    #[cfg(target_os = "linux")]
    {
        // Niri requires explicit sync to be suppressed on NVIDIA to prevent missing-acquire-point
        // buffer stalls and hover-only partial damage repaints.
        let is_niri = std::env::var_os("NIRI_SOCKET").is_some()
            || std::env::var("XDG_CURRENT_DESKTOP").is_ok_and(|v| v.eq_ignore_ascii_case("niri"));
        let disable_dmabuf = std::env::args().any(|arg| arg == "--disable-dmabuf-renderer");
        let disable_nv_sync = std::env::args().any(|arg| arg == "--disable-nv-explicit-sync")
            || (is_niri
                && webkit2gtk_nvidia_quirk::is_primary_gpu_nvidia()
                && std::env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_none());

        let options = webkit2gtk_nvidia_quirk::ApplyWorkaroundOptions::default()
            .force_disable_dmabuf(disable_dmabuf)
            .force_disable_nv_explicit_sync(disable_nv_sync);
        webkit2gtk_nvidia_quirk::apply_workaround_with_options(options);
    }

    zuno_lib::run()
}
