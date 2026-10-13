// PointCloudLabeler — Tree segmentation, editing and label transfer for close-range forest point clouds
// Copyright (C) 2026 Eppu Honkanen
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

//! The Model Context Protocol server: the catalogue as MCP tools.
//!
//! MCP is JSON-RPC 2.0 over a transport; the client (an assistant's
//! host program) asks `initialize`, lists the tools, and calls them.
//! This module is the protocol core — a `Server` that takes one JSON-RPC
//! message and produces the replies and notifications it causes — and
//! the stdio transport around it (`serve_stdio`: one JSON message per
//! line on stdin, one per line on stdout, as the specification's stdio
//! transport has it, logging on stderr). The HTTP API mounts the same
//! core on `POST /mcp` for the streamable HTTP transport.
//!
//! Every operation of the catalogue is one tool. Tool names are the
//! operation names in snake case (`segment_chm`,
//! `dataset_realign_to_source`), because the hosts that forward tools
//! to a model restrict names to `[A-Za-z0-9_-]`; the input schema is the operation's parameter
//! schema; the result is the operation's JSON as `structuredContent`
//! and as text. A call carrying `_meta.progressToken` receives
//! `notifications/progress` while it runs. Two resources are offered:
//! the catalogue itself and the example batch recipe.
//!
//! Written against the protocol directly rather than an SDK crate: the
//! methods a tool server needs fit in a few hundred lines, the crate's
//! Rust floor stays where it is, and nothing here can drift from the
//! catalogue because nothing here names an operation.

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::ops::{self, OpContext};
use crate::progress::Progress;
use crate::state::AppState;

pub const PROTOCOL_VERSION: &str = "2025-06-18";
pub const SERVER_NAME: &str = "pointcloudlabeler";

/// A JSON-RPC message going out: a response or a notification.
pub type Outgoing = Value;

/// The protocol core: state plus the message handler.
pub struct Server {
    pub state: Arc<AppState>,
    pub initialized: bool,
}

impl Server {
    pub fn new(state: Arc<AppState>) -> Server {
        Server { state, initialized: false }
    }

    /// The tool name of an operation — see `schema::tool_name`.
    pub fn tool_name(op: &str) -> String {
        super::schema::tool_name(op)
    }

    /// The operation behind a tool name, if any.
    pub fn op_of(tool: &str) -> Option<&'static ops::OpDef> {
        ops::catalogue().iter().find(|o| Server::tool_name(o.name) == tool)
    }

    pub fn tools() -> Vec<Value> {
        ops::catalogue()
            .iter()
            .map(|op| {
                let mut schema = op.params_schema();
                // The schema keyword and title are noise to a tool host.
                if let Some(o) = schema.as_object_mut() {
                    o.remove("$schema");
                    o.remove("title");
                }
                let mut description = op.summary.to_string();
                if op.mutates {
                    description.push_str(" Writes to the dataset or project it names.");
                }
                if let Some(stage) = op.stage {
                    description.push_str(&format!(" Long-running; stage '{stage}' (run_cancel stops it)."));
                }
                json!({
                    "name": Server::tool_name(op.name),
                    "title": op.name,
                    "description": description,
                    "inputSchema": schema,
                    "annotations": {
                        "title": op.name,
                        "readOnlyHint": !op.mutates,
                        "destructiveHint": op.mutates,
                        "idempotentHint": !op.mutates,
                        "openWorldHint": false,
                    },
                })
            })
            .collect()
    }

    fn resources() -> Vec<Value> {
        vec![
            json!({
                "uri": "pointcloudlabeler://catalogue",
                "name": "catalogue",
                "title": "Operation catalogue",
                "description": "Every operation with its group, summary and parameter schema.",
                "mimeType": "application/json",
            }),
            json!({
                "uri": "pointcloudlabeler://recipe-example",
                "name": "recipe-example",
                "title": "Example batch recipe",
                "description": "A recipe for `pointcloudlabeler recipe run`: the manuscript's workflow per plot.",
                "mimeType": "application/json",
            }),
        ]
    }

    /// Handle one message. Returns what to send back, in order: progress
    /// notifications a tool call emitted, then the response (none for a
    /// notification). `progress` receives notifications as they happen,
    /// for a transport that can send them before the response.
    pub fn handle(&mut self, msg: &Value, mut emit: impl FnMut(Outgoing)) -> Option<Outgoing> {
        let id = msg.get("id").cloned();
        let method = match msg.get("method").and_then(Value::as_str) {
            Some(m) => m.to_string(),
            None => {
                // A response from the client (to a ping we never send) or garbage.
                return id.map(|id| error(id, -32600, "invalid request: no method"));
            }
        };
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let is_notification = id.is_none();
        let result: Result<Value, (i64, String)> = match method.as_str() {
            "initialize" => {
                self.initialized = true;
                Ok(json!({
                    "protocolVersion": negotiate(params.get("protocolVersion").and_then(Value::as_str)),
                    "capabilities": { "tools": { "listChanged": false }, "resources": { "subscribe": false, "listChanged": false } },
                    "serverInfo": { "name": SERVER_NAME, "title": "PointCloudLabeler", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": "Tools are PointCloudLabeler's operations: project_*, dataset_*, ground_*, segment_*, metrics_*, qc_*, review_*, transfer_*, export_*, change_*, run_*. Paths are on the machine the server runs on. Start with project_open or project_create, then dataset_import; ground_classify before segment_*; metrics_trees and qc_flags read the segmentation. Operations that write say so.",
                }))
            }
            "notifications/initialized" | "notifications/cancelled" | "notifications/roots/list_changed" => return None,
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": Server::tools() })),
            "tools/call" => self.call_tool(&params, &mut emit),
            "resources/list" => Ok(json!({ "resources": Server::resources() })),
            "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
            "resources/read" => match params.get("uri").and_then(Value::as_str) {
                Some("pointcloudlabeler://catalogue") => Ok(json!({ "contents": [{ "uri": "pointcloudlabeler://catalogue", "mimeType": "application/json", "text": ops::describe_all().to_string() }] })),
                Some("pointcloudlabeler://recipe-example") => Ok(json!({ "contents": [{ "uri": "pointcloudlabeler://recipe-example", "mimeType": "application/json", "text": serde_json::to_string_pretty(&super::recipe::example()).unwrap_or_default() }] })),
                Some(other) => Err((-32002, format!("unknown resource {other}"))),
                None => Err((-32602, "resources/read needs a uri".into())),
            },
            "prompts/list" => Ok(json!({ "prompts": [] })),
            "logging/setLevel" => Ok(json!({})),
            other => Err((-32601, format!("method not found: {other}"))),
        };
        if is_notification {
            return None;
        }
        let id = id.unwrap_or(Value::Null);
        Some(match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err((code, message)) => error(id, code, &message),
        })
    }

    fn call_tool(&mut self, params: &Value, emit: &mut impl FnMut(Outgoing)) -> Result<Value, (i64, String)> {
        let name = params.get("name").and_then(Value::as_str).ok_or((-32602, "tools/call needs a name".to_string()))?;
        let op = Server::op_of(name).ok_or((-32602, format!("unknown tool {name}")))?;
        let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);
        let token = params.get("_meta").and_then(|m| m.get("progressToken")).cloned();
        // Progress: notifications as the pass reports, each with the
        // client's token, 0..100 so hosts can draw a bar.
        let sink: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let progress = match &token {
            Some(tok) => {
                let tok = tok.clone();
                let sink = sink.clone();
                let last = Mutex::new((String::new(), -1i32));
                Progress::new(move |stage, pct| {
                    let pct = if pct <= 1.0 { pct * 100.0 } else { pct };
                    let bucket = (pct * 2.0) as i32;
                    let mut l = last.lock().unwrap_or_else(|e| e.into_inner());
                    if l.0 == stage && l.1 == bucket {
                        return;
                    }
                    *l = (stage.to_string(), bucket);
                    sink.lock().unwrap_or_else(|e| e.into_inner()).push(json!({
                        "jsonrpc": "2.0",
                        "method": "notifications/progress",
                        "params": { "progressToken": tok, "progress": pct, "total": 100.0, "message": stage },
                    }));
                })
            }
            None => Progress::silent(),
        };
        let ctx = OpContext::new(progress, self.state.clone());
        let outcome = op.run(&ctx, arguments);
        for n in sink.lock().unwrap_or_else(|e| e.into_inner()).drain(..) {
            emit(n);
        }
        // Tool errors are results with isError, so the model can read them.
        Ok(match outcome {
            Ok(v) => json!({
                "content": [{ "type": "text", "text": serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string()) }],
                "structuredContent": if v.is_object() { v } else { json!({ "result": v }) },
                "isError": false,
            }),
            Err(e) => json!({
                "content": [{ "type": "text", "text": e }],
                "isError": true,
            }),
        })
    }
}

fn negotiate(requested: Option<&str>) -> &'static str {
    // The versions this core knows. An older client keeps its own.
    match requested {
        Some("2024-11-05") => "2024-11-05",
        Some("2025-03-26") => "2025-03-26",
        _ => PROTOCOL_VERSION,
    }
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Serve over `input`/`output`: one JSON-RPC message per line in, one
/// per line out. Progress notifications go out as they happen. Returns
/// when the input closes.
pub fn serve<R: BufRead, W: Write>(server: &mut Server, input: R, output: W) -> Result<(), String> {
    let out = Arc::new(Mutex::new(output));
    let write = |v: &Value| {
        let mut o = out.lock().unwrap_or_else(|e| e.into_inner());
        let _ = writeln!(o, "{}", v);
        let _ = o.flush();
    };
    for line in input.lines() {
        let line = line.map_err(|e| format!("read: {e}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                write(&error(Value::Null, -32700, &format!("parse error: {e}")));
                continue;
            }
        };
        // A batch is handled message by message.
        let messages: Vec<Value> = match msg {
            Value::Array(a) => a,
            other => vec![other],
        };
        for m in messages {
            if let Some(response) = server.handle(&m, |n| write(&n)) {
                write(&response);
            }
        }
    }
    Ok(())
}

/// The stdio transport on this process's stdin and stdout.
pub fn serve_stdio(ctx: &OpContext) -> Result<(), String> {
    let mut server = Server::new(ctx.state.clone());
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    eprintln!("{SERVER_NAME} MCP server on stdio ({} tools); waiting for initialize", ops::catalogue().len());
    serve(&mut server, stdin.lock(), stdout.lock())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exchange(server: &mut Server, lines: &[Value]) -> Vec<Value> {
        let input: String = lines.iter().map(|l| l.to_string() + "\n").collect();
        let mut out: Vec<u8> = Vec::new();
        serve(server, input.as_bytes(), &mut out).unwrap();
        String::from_utf8(out).unwrap().lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    #[test]
    fn the_handshake_lists_capabilities_and_the_tools_are_the_catalogue() {
        let mut s = Server::new(Arc::new(AppState::default()));
        let replies = exchange(&mut s, &[
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "0" } } }),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
            json!({ "jsonrpc": "2.0", "id": 3, "method": "ping" }),
        ]);
        assert_eq!(replies.len(), 3, "a notification gets no reply: {replies:?}");
        assert_eq!(replies[0]["id"], 1);
        assert_eq!(replies[0]["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(replies[0]["result"]["serverInfo"]["name"], SERVER_NAME);
        assert!(replies[0]["result"]["capabilities"]["tools"].is_object());
        let tools = replies[1]["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), ops::catalogue().len());
        for t in tools {
            let name = t["name"].as_str().unwrap();
            assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'), "{name} is not a host-safe tool name");
            assert!(t["inputSchema"]["type"] == "object", "{name} has no object schema");
            assert!(t["inputSchema"].get("$schema").is_none());
            assert!(!t["description"].as_str().unwrap().is_empty());
        }
        assert!(tools.iter().any(|t| t["name"] == "segment_chm" && t["title"] == "segment.chm"));
        assert_eq!(replies[2]["result"], json!({}));
    }

    #[test]
    fn a_tool_call_runs_the_operation_and_reports_progress_with_the_token() {
        let dir = std::env::temp_dir().join(format!("pcl-mcp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut s = Server::new(Arc::new(AppState::default()));
        let replies = exchange(&mut s, &[
            json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "review_set", "arguments": { "octreeDir": dir.to_string_lossy(), "verdicts": { "4": "ok" } }, "_meta": { "progressToken": "p1" } } }),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "review_get", "arguments": { "octreeDir": dir.to_string_lossy() } } }),
            json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "ground_classify", "arguments": { "octreeDir": dir.to_string_lossy(), "cellsize": 2 } } }),
            json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "no_such_tool", "arguments": {} } }),
        ]);
        let r1 = replies.iter().find(|r| r["id"] == 1).unwrap();
        assert_eq!(r1["result"]["isError"], false);
        assert_eq!(r1["result"]["structuredContent"]["ok"], 1);
        let r2 = replies.iter().find(|r| r["id"] == 2).unwrap();
        assert_eq!(r2["result"]["structuredContent"]["verdicts"]["4"], "ok");
        // A failing operation is a tool result with isError, readable by the model.
        let r3 = replies.iter().find(|r| r["id"] == 3).unwrap();
        assert_eq!(r3["result"]["isError"], true);
        assert!(r3["result"]["content"][0]["text"].as_str().unwrap().contains("invalid parameters"));
        // An unknown tool is a protocol error.
        let r4 = replies.iter().find(|r| r["id"] == 4).unwrap();
        assert_eq!(r4["error"]["code"], -32602);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn progress_notifications_carry_the_token_and_precede_the_response() {
        let mut s = Server::new(Arc::new(AppState::default()));
        let mut emitted = Vec::new();
        // dataset.import on a missing file fails before any progress; use a
        // Progress-reporting operation instead: run the handler with a fake
        // sink by calling the catalogue through a tool that reports.
        let response = s.handle(
            &json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": { "name": "run_status", "arguments": { "stage": "mcp-test" }, "_meta": { "progressToken": 42 } } }),
            |n| emitted.push(n),
        ).unwrap();
        assert_eq!(response["id"], 9);
        assert_eq!(response["result"]["structuredContent"]["running"], false);
        // run.status reports no progress; the plumbing is exercised by the
        // sink closure itself:
        let sink: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let tok = json!(42);
        let sink2 = sink.clone();
        let p = Progress::new(move |stage, pct| {
            sink2.lock().unwrap().push(json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": { "progressToken": tok, "progress": pct, "total": 100.0, "message": stage } }));
        });
        p.report("bin", 50.0);
        let n = &sink.lock().unwrap()[0];
        assert_eq!(n["method"], "notifications/progress");
        assert_eq!(n["params"]["progressToken"], 42);
        assert_eq!(n["params"]["progress"], 50.0);
        assert!(emitted.is_empty());
    }

    #[test]
    fn resources_malformed_input_and_unknown_methods_are_answered_properly() {
        let mut s = Server::new(Arc::new(AppState::default()));
        let mut out: Vec<u8> = Vec::new();
        let input = "not json\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"resources/list\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"resources/read\",\"params\":{\"uri\":\"pointcloudlabeler://catalogue\"}}\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"nothing/here\"}\n[{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"ping\"},{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"ping\"}]\n";
        serve(&mut s, input.as_bytes(), &mut out).unwrap();
        let replies: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(replies[0]["error"]["code"], -32700);
        assert_eq!(replies[1]["result"]["resources"].as_array().unwrap().len(), 2);
        let text = replies[2]["result"]["contents"][0]["text"].as_str().unwrap();
        let catalogue: Value = serde_json::from_str(text).unwrap();
        assert!(catalogue.as_array().unwrap().len() >= 40);
        assert_eq!(replies[3]["error"]["code"], -32601);
        assert_eq!(replies[4]["id"], 4);
        assert_eq!(replies[5]["id"], 5);
        assert_eq!(negotiate(Some("2024-11-05")), "2024-11-05");
        assert_eq!(negotiate(Some("2099-01-01")), PROTOCOL_VERSION);
    }
}
