fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "kcd_config",
            "kcd_set_config",
            "kcd_notify",
            "kcd_open_external",
            "kcd_save_file",
            "kcd_show_file",
            "kcd_check_update",
            "kcd_restart",
            "kcd_badge",
            "kcd_online",
            "kcd_logout",
            "kcd_close_popups",
        ]),
    ))
    .expect("failed to run tauri-build");
}

