//! One-shot, fail-closed ACP v1 client; System's Work controller stays in TS.
//! stdout is bounded structural NDJSON, never raw ACP frames or prompt text.
//! Based on the official SDK's yolo_one_shot_client, except permissions are denied.
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::v1::ConnectionTo;
use agent_client_protocol::v1::schema::{
    ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SessionNotification, StopReason, TextContent,
};
use agent_client_protocol::{AcpAgent, Agent, Client};
use serde_json::json;
use std::{env, fs, io, path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}}};

#[derive(Debug, PartialEq, Eq)]
struct Cli {
    agent: String,
    args: Vec<String>,
    prompt_file: PathBuf,
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Cli, String> {
    let mut it = args.into_iter();
    let (mut agent, mut args_json, mut prompt_file) = (None, None, None);
    while let Some(flag) = it.next() {
        let value = it.next().ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--agent" if agent.is_none() => agent = Some(value),
            "--args-json" if args_json.is_none() => args_json = Some(value),
            "--prompt-file" if prompt_file.is_none() => prompt_file = Some(PathBuf::from(value)),
            _ => return Err(format!("unexpected or duplicate flag: {flag}")),
        }
    }
    let agent = agent.filter(|s: &String| !s.trim().is_empty())
        .ok_or("missing --agent")?;
    let args: Vec<String> = serde_json::from_str(&args_json.unwrap_or_else(|| "[]".into()))
        .map_err(|_| "--args-json must be a JSON array of strings")?;
    let prompt_file = prompt_file.ok_or("missing --prompt-file")?;
    Ok(Cli { agent, args, prompt_file })
}

fn success(reason: &StopReason) -> bool {
    matches!(reason, StopReason::EndTurn)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if env::args().nth(1).as_deref() == Some("--version") {
        println!("system-acp-bridge {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let cli = parse_args(env::args().skip(1)).map_err(io::Error::other)?;
    let prompt = fs::read_to_string(&cli.prompt_file)?;
    let cwd = env::current_dir()?;
    // Preserve argv boundaries rather than re-parsing a shell command.
    let mut command = vec![cli.agent];
    command.extend(cli.args);
    let agent = AcpAgent::from_args(&command)?;
    let permission_denied = Arc::new(AtomicBool::new(false));
    let denied_in_handler = Arc::clone(&permission_denied);

    let reason = Client
        .v1()
        .on_receive_notification(
            async |_notification: SessionNotification, _connection| {
                // Session updates are advisory; output capture happens in System.
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |_request: RequestPermissionRequest, responder, _connection| {
                denied_in_handler.store(true, Ordering::SeqCst);
                // No System policy token or human is present at this boundary:
                // reject every permission prompt, never auto-select "allow once".
                println!("{}", json!({"type":"acp.permission_denied"}));
                responder.respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
            connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            println!("{}", json!({"type":"acp.initialized"}));
            let session = connection
                .send_request(NewSessionRequest::new(cwd))
                .block_task()
                .await?;
            println!("{}", json!({"type":"acp.session_ready"}));
            let response = connection
                .send_request(PromptRequest::new(
                    session.session_id,
                    vec![ContentBlock::Text(TextContent::new(prompt))],
                ))
                .block_task()
                .await?;
            Ok(response.stop_reason)
        })
        .await?;

    let ok = success(&reason) && !permission_denied.load(Ordering::SeqCst);
    println!("{}", json!({
        "type":"acp.result",
        "ok":ok,
        "stopReason":format!("{reason:?}")
    }));
    if !ok {
        return Err(io::Error::other("ACP turn did not end normally").into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_explicit_binary_and_prompt_file() {
        assert!(parse_args(Vec::new()).is_err());
        assert!(parse_args(vec!["--agent".into(), "worker".into()]).is_err());
        assert!(parse_args(vec![
            "--agent".into(), "worker".into(), "--prompt-file".into(), "/tmp/prompt".into(),
            "--unknown".into(), "ignored".into()
        ]).is_err());
    }

    #[test]
    fn preserves_agent_arguments_without_shell_parsing() {
        let args = parse_args(vec![
            "--agent".into(), "/path with spaces/agent".into(),
            "--args-json".into(), r#"["--flag","one two"]"#.into(),
            "--prompt-file".into(), "/tmp/prompt".into()
        ]).unwrap();
        assert_eq!(args.agent, "/path with spaces/agent");
        assert_eq!(args.args, vec!["--flag", "one two"]);
    }

    #[test]
    fn only_end_turn_is_a_normal_completion() {
        assert!(success(&StopReason::EndTurn));
        assert!(!success(&StopReason::Cancelled));
        assert!(!success(&StopReason::Refusal));
    }
}
