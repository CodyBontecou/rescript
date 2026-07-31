const COMMANDS: &[&str] = &[
    "start_prepare",
    "start_export",
    "snapshot",
    "cancel",
    "prepare_result",
    "export_result",
    "export_entitlement_status",
    "is_export_entitled",
    "purchase_unlimited_exports",
    "restore_export_purchases",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
