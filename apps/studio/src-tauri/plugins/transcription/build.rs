const COMMANDS: &[&str] = &[
    "start",
    "snapshot",
    "cancel",
    "result",
    "list_models",
    "remove_model",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
