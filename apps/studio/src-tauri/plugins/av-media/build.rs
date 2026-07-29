const COMMANDS: &[&str] = &[
    "start_prepare",
    "start_export",
    "snapshot",
    "cancel",
    "prepare_result",
    "export_result",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
