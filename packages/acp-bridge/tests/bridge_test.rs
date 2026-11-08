use std::{env, fs, path::PathBuf, process::{Command, Output}, time::{SystemTime, UNIX_EPOCH}};

fn invoke(mock_permission: bool, stop_reason: Option<&str>) -> Output {
    let name = format!(
        "system-acp-bridge-test-{}-{}.txt",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    );
    let prompt = env::temp_dir().join(name);
    fs::write(&prompt, "Test ACP without a real model").unwrap();
    let agent = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/mock_agent.mjs");
    let mut command = Command::new(env!("CARGO_BIN_EXE_system-acp-bridge"));
    command.args([
        "--agent", "node",
        "--args-json", &serde_json::to_string(&vec![agent.to_string_lossy()]).unwrap(),
        "--prompt-file", prompt.to_str().unwrap(),
    ]);
    if mock_permission {
        command.env("MOCK_PERMISSION", "1");
    }
    if let Some(reason) = stop_reason {
        command.env("MOCK_STOP_REASON", reason);
    }
    let output = command.output().expect("bridge process ran");
    let _ = fs::remove_file(prompt);
    output
}

#[test]
fn official_sdk_connects_and_completes_v1_prompt() {
    let output = invoke(false, None);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"type\":\"acp.initialized\""), "{stdout}");
    assert!(stdout.contains("\"type\":\"acp.session_ready\""), "{stdout}");
    assert!(stdout.contains("\"stopReason\":\"EndTurn\""), "{stdout}");
}

#[test]
fn denied_permission_never_becomes_success() {
    let output = invoke(true, None);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("acp.permission_denied"));
}

#[test]
fn abnormal_stop_reason_is_not_success() {
    let output = invoke(false, Some("cancelled"));
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("Cancelled"));
}
