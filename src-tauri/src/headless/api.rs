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

//! The HTTP API: the catalogue as JSON endpoints, with jobs and progress
//! streams, and the MCP streamable HTTP transport on the same port.
//!
//! `pointcloudlabeler serve` listens — on 127.0.0.1:7878 unless told
//! otherwise — and never connects anywhere: hyper is built with its
//! server features only, and the application's rule that it has no
//! network egress stands (src/persistence/noNetwork.test.ts checks the
//! features and that no default build carries this). Bound to anything
//! but the loopback interface, the server refuses to start without a
//! bearer token; with one, every request has to carry it. HTTPS comes
//! from `api-tls` with a certificate and key the user supplies.
//!
//! Routes:
//!
//! - `GET  /api/health` — version and counts.
//! - `GET  /api/ops` and `GET /api/ops/{name}` — the catalogue, with schemas.
//! - `POST /api/ops/{name}` — run an operation with the JSON body as its
//!   parameters; the result as JSON. With `?async=1` (or
//!   `Prefer: respond-async`) the run becomes a job and the reply is
//!   202 with its id.
//! - `GET  /api/jobs`, `GET /api/jobs/{id}` — jobs and their state;
//!   `GET /api/jobs/{id}/events` — server-sent events (`progress`,
//!   `done`, `failed`) until the job ends; `DELETE /api/jobs/{id}` — ask
//!   the job's stage to stop.
//! - `GET  /api/openapi.json` — an OpenAPI 3.1 document generated from
//!   the catalogue.
//! - `POST /mcp` — one MCP JSON-RPC message; the response as JSON, or as
//!   an SSE stream carrying the progress notifications first when the
//!   client accepts `text/event-stream`.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use bytes::Bytes;
use clap::{Arg, ArgAction, ArgMatches, Command};
use http_body_util::{BodyExt, Full};
use hyper::body::{Frame, Incoming};
use hyper::header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;

use super::mcp;
use crate::ops::{self, OpContext};
use crate::progress::Progress;
use crate::state::AppState;

pub const DEFAULT_BIND: &str = "127.0.0.1:7878";
const MAX_BODY: usize = 16 * 1024 * 1024;

// --- jobs ---------------------------------------------------------------

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Running,
    Done,
    Failed,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub id: u64,
    pub op: String,
    pub status: JobStatus,
    pub stage: String,
    pub pct: f32,
    pub seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub stop_requested: bool,
}

struct Job {
    id: u64,
    op: String,
    status: JobStatus,
    stage: String,
    pct: f32,
    started: Instant,
    finished: Option<Instant>,
    result: Option<Value>,
    error: Option<String>,
    stop_requested: bool,
    events: broadcast::Sender<Value>,
}

impl Job {
    fn view(&self) -> JobView {
        JobView {
            id: self.id,
            op: self.op.clone(),
            status: self.status,
            stage: self.stage.clone(),
            pct: self.pct,
            seconds: self.finished.unwrap_or_else(Instant::now).duration_since(self.started).as_secs_f64(),
            result: self.result.clone(),
            error: self.error.clone(),
            stop_requested: self.stop_requested,
        }
    }
}

/// The jobs this process has run: in memory, for the life of the server.
#[derive(Default)]
pub struct Jobs {
    next: AtomicU64,
    map: Mutex<BTreeMap<u64, Job>>,
}

impl Jobs {
    /// Start `op` with `params` on a thread; the job id, and its event stream.
    fn start(self: &Arc<Self>, state: Arc<AppState>, op: &'static ops::OpDef, params: Value) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (events, _) = broadcast::channel(256);
        let job = Job {
            id,
            op: op.name.to_string(),
            status: JobStatus::Running,
            stage: String::new(),
            pct: 0.0,
            started: Instant::now(),
            finished: None,
            result: None,
            error: None,
            stop_requested: false,
            events: events.clone(),
        };
        self.map.lock().unwrap_or_else(|e| e.into_inner()).insert(id, job);
        let jobs = self.clone();
        let progress = {
            let jobs = jobs.clone();
            let events = events.clone();
            let last = Mutex::new((String::new(), -1i32));
            Progress::new(move |stage, pct| {
                let pct = if pct <= 1.0 { pct * 100.0 } else { pct };
                let bucket = (pct * 2.0) as i32;
                let mut l = last.lock().unwrap_or_else(|e| e.into_inner());
                if l.0 == stage && l.1 == bucket {
                    return;
                }
                *l = (stage.to_string(), bucket);
                if let Some(j) = jobs.map.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&id) {
                    j.stage = stage.to_string();
                    j.pct = pct;
                }
                let _ = events.send(json!({ "event": "progress", "data": { "id": id, "stage": stage, "pct": pct } }));
            })
        };
        let ctx = OpContext::new(progress, state);
        std::thread::Builder::new()
            .name(format!("job-{id}"))
            .spawn(move || {
                let outcome = op.run(&ctx, params);
                let mut m = jobs.map.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(j) = m.get_mut(&id) {
                    j.finished = Some(Instant::now());
                    j.pct = 100.0;
                    match outcome {
                        Ok(v) => {
                            j.status = JobStatus::Done;
                            j.result = Some(v);
                        }
                        Err(e) => {
                            j.status = JobStatus::Failed;
                            j.error = Some(e);
                        }
                    }
                    let view = j.view();
                    let kind = if j.status == JobStatus::Done { "done" } else { "failed" };
                    let _ = events.send(json!({ "event": kind, "data": view }));
                }
            })
            .ok();
        id
    }

    fn view(&self, id: u64) -> Option<JobView> {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).get(&id).map(Job::view)
    }

    fn list(&self) -> Vec<JobView> {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).values().map(Job::view).collect()
    }

    fn subscribe(&self, id: u64) -> Option<(JobView, broadcast::Receiver<Value>)> {
        let m = self.map.lock().unwrap_or_else(|e| e.into_inner());
        m.get(&id).map(|j| (j.view(), j.events.subscribe()))
    }

    /// Ask the job's operation to stop; true if the job exists and runs.
    fn cancel(&self, id: u64) -> Option<JobView> {
        let mut m = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let j = m.get_mut(&id)?;
        if j.status == JobStatus::Running {
            if let Some(stage) = ops::find(&j.op).and_then(|o| o.stage) {
                crate::commands::cancel::octree_cancel(stage.to_string());
            }
            j.stop_requested = true;
        }
        Some(j.view())
    }
}

// --- the service -----------------------------------------------------------

pub struct Api {
    pub state: Arc<AppState>,
    pub jobs: Arc<Jobs>,
    pub token: Option<String>,
    mcp: Mutex<mcp::Server>,
}

impl Api {
    pub fn new(state: Arc<AppState>, token: Option<String>) -> Arc<Api> {
        Arc::new(Api { mcp: Mutex::new(mcp::Server::new(state.clone())), state, jobs: Arc::new(Jobs::default()), token })
    }
}

type BoxBody = http_body_util::combinators::BoxBody<Bytes, Infallible>;

fn full(body: impl Into<Bytes>) -> BoxBody {
    Full::new(body.into()).boxed()
}

fn json_response(status: StatusCode, v: &Value) -> Response<BoxBody> {
    let mut r = Response::new(full(serde_json::to_vec(v).unwrap_or_default()));
    *r.status_mut() = status;
    r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r
}

fn error_response(status: StatusCode, message: impl Into<String>) -> Response<BoxBody> {
    json_response(status, &json!({ "error": message.into() }))
}

/// A body fed from a channel: server-sent events.
struct EventBody {
    rx: tokio::sync::mpsc::Receiver<Bytes>,
}

impl hyper::body::Body for EventBody {
    type Data = Bytes;
    type Error = Infallible;
    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(b)) => Poll::Ready(Some(Ok(Frame::data(b)))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

fn sse_frame(event: &str, data: &Value) -> Bytes {
    Bytes::from(format!("event: {event}\ndata: {data}\n\n"))
}

fn sse_response(rx: tokio::sync::mpsc::Receiver<Bytes>) -> Response<BoxBody> {
    let mut r = Response::new(BodyExt::boxed(EventBody { rx }));
    r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    r.headers_mut().insert("cache-control", HeaderValue::from_static("no-cache"));
    r
}

fn wants_sse(req: &Request<Incoming>) -> bool {
    req.headers().get("accept").and_then(|v| v.to_str().ok()).is_some_and(|a| a.contains("text/event-stream"))
}

async fn read_json_body(req: Request<Incoming>) -> Result<Value, Response<BoxBody>> {
    let body = req.into_body();
    let collected = body.collect().await.map_err(|e| error_response(StatusCode::BAD_REQUEST, format!("read body: {e}")))?.to_bytes();
    if collected.len() > MAX_BODY {
        return Err(error_response(StatusCode::PAYLOAD_TOO_LARGE, "body over 16 MiB"));
    }
    if collected.is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_slice(&collected).map_err(|e| error_response(StatusCode::BAD_REQUEST, format!("body is not valid JSON: {e}")))
}

fn query_flag(req: &Request<Incoming>, key: &str) -> bool {
    req.uri().query().is_some_and(|q| q.split('&').any(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, "1"));
        k == key && matches!(v, "1" | "true" | "yes")
    }))
}

/// Route and answer one request.
pub async fn handle(api: Arc<Api>, req: Request<Incoming>) -> Result<Response<BoxBody>, Infallible> {
    Ok(route(api, req).await)
}

async fn route(api: Arc<Api>, req: Request<Incoming>) -> Response<BoxBody> {
    let path = req.uri().path().trim_end_matches('/').to_string();
    let method = req.method().clone();
    // Authentication, when a token is set: every route but nothing else.
    if let Some(token) = &api.token {
        let given = req.headers().get(AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).map(str::trim);
        if given != Some(token.as_str()) {
            let mut r = error_response(StatusCode::UNAUTHORIZED, "a bearer token is required");
            r.headers_mut().insert("www-authenticate", HeaderValue::from_static("Bearer"));
            return r;
        }
    }
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    match (method, parts.as_slice()) {
        (Method::GET, ["api", "health"]) | (Method::GET, []) => json_response(StatusCode::OK, &json!({
            "ok": true,
            "name": mcp::SERVER_NAME,
            "version": env!("CARGO_PKG_VERSION"),
            "operations": ops::catalogue().len(),
            "jobs": api.jobs.list().len(),
            "project": api.state.project_folder().map(|p| p.to_string_lossy().into_owned()),
        })),
        (Method::GET, ["api", "ops"]) => json_response(StatusCode::OK, &ops::describe_all()),
        (Method::GET, ["api", "openapi.json"]) => json_response(StatusCode::OK, &openapi()),
        (Method::GET, ["api", "ops", name]) => match ops::find(name) {
            Some(op) => json_response(StatusCode::OK, &op.describe()),
            None => error_response(StatusCode::NOT_FOUND, format!("unknown operation '{name}'")),
        },
        (Method::POST, ["api", "ops", name]) => {
            let name = name.to_string();
            let Some(op) = ops::find(&name) else {
                return error_response(StatusCode::NOT_FOUND, format!("unknown operation '{name}'"));
            };
            let as_job = query_flag(&req, "async") || req.headers().get("prefer").and_then(|v| v.to_str().ok()).is_some_and(|p| p.contains("respond-async"));
            let params = match read_json_body(req).await {
                Ok(v) => v,
                Err(r) => return r,
            };
            if as_job {
                let id = api.jobs.start(api.state.clone(), op, params);
                let mut r = json_response(StatusCode::ACCEPTED, &json!({ "jobId": id, "op": op.name, "status": "running", "events": format!("/api/jobs/{id}/events") }));
                r.headers_mut().insert("location", HeaderValue::from_str(&format!("/api/jobs/{id}")).unwrap());
                return r;
            }
            // Synchronous: the pass runs on a blocking thread; the reply waits.
            let state = api.state.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                let ctx = OpContext::new(Progress::silent(), state);
                op.run(&ctx, params)
            })
            .await
            .unwrap_or_else(|e| Err(format!("the operation thread died: {e}")));
            match outcome {
                Ok(v) => json_response(StatusCode::OK, &v),
                Err(e) => error_response(StatusCode::UNPROCESSABLE_ENTITY, e),
            }
        }
        (Method::GET, ["api", "jobs"]) => json_response(StatusCode::OK, &serde_json::to_value(api.jobs.list()).unwrap_or(Value::Null)),
        (Method::GET, ["api", "jobs", id]) => match id.parse::<u64>().ok().and_then(|id| api.jobs.view(id)) {
            Some(j) => json_response(StatusCode::OK, &serde_json::to_value(j).unwrap_or(Value::Null)),
            None => error_response(StatusCode::NOT_FOUND, "no such job"),
        },
        (Method::DELETE, ["api", "jobs", id]) => match id.parse::<u64>().ok().and_then(|id| api.jobs.cancel(id)) {
            Some(j) => json_response(StatusCode::OK, &serde_json::to_value(j).unwrap_or(Value::Null)),
            None => error_response(StatusCode::NOT_FOUND, "no such job"),
        },
        (Method::GET, ["api", "jobs", id, "events"]) => {
            let Some((view, mut rx)) = id.parse::<u64>().ok().and_then(|id| api.jobs.subscribe(id)) else {
                return error_response(StatusCode::NOT_FOUND, "no such job");
            };
            let (tx, body_rx) = tokio::sync::mpsc::channel::<Bytes>(64);
            tokio::spawn(async move {
                // The state as of subscribing, then every event until the end.
                let _ = tx.send(sse_frame("state", &serde_json::to_value(&view).unwrap_or(Value::Null))).await;
                if view.status != JobStatus::Running {
                    return;
                }
                loop {
                    match rx.recv().await {
                        Ok(ev) => {
                            let kind = ev["event"].as_str().unwrap_or("progress").to_string();
                            if tx.send(sse_frame(&kind, &ev["data"])).await.is_err() {
                                return;
                            }
                            if kind != "progress" {
                                return;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => return,
                    }
                }
            });
            sse_response(body_rx)
        }
        (Method::POST, ["mcp"]) => {
            let sse = wants_sse(&req);
            let msg = match read_json_body(req).await {
                Ok(v) => v,
                Err(r) => return r,
            };
            let api2 = api.clone();
            let (notes, response) = tokio::task::spawn_blocking(move || {
                let mut server = api2.mcp.lock().unwrap_or_else(|e| e.into_inner());
                let mut notes = Vec::new();
                let messages: Vec<Value> = match msg {
                    Value::Array(a) => a,
                    other => vec![other],
                };
                let mut responses = Vec::new();
                for m in messages {
                    if let Some(r) = server.handle(&m, |n| notes.push(n)) {
                        responses.push(r);
                    }
                }
                (notes, responses)
            })
            .await
            .unwrap_or_else(|_| (Vec::new(), Vec::new()));
            if response.is_empty() {
                let mut r = Response::new(full(Vec::new()));
                *r.status_mut() = StatusCode::ACCEPTED;
                return r;
            }
            let response = if response.len() == 1 { response.into_iter().next().unwrap() } else { Value::Array(response) };
            if sse {
                let (tx, body_rx) = tokio::sync::mpsc::channel::<Bytes>(64);
                tokio::spawn(async move {
                    for n in notes {
                        if tx.send(sse_frame("message", &n)).await.is_err() {
                            return;
                        }
                    }
                    let _ = tx.send(sse_frame("message", &response)).await;
                });
                let mut r = sse_response(body_rx);
                r.headers_mut().insert("mcp-session-id", HeaderValue::from_static("pointcloudlabeler"));
                r
            } else {
                let mut r = json_response(StatusCode::OK, &response);
                r.headers_mut().insert("mcp-session-id", HeaderValue::from_static("pointcloudlabeler"));
                r
            }
        }
        (Method::GET, ["mcp"]) => error_response(StatusCode::METHOD_NOT_ALLOWED, "this server opens no server-initiated stream; POST messages"),
        (Method::DELETE, ["mcp"]) => {
            let mut r = Response::new(full(Vec::new()));
            *r.status_mut() = StatusCode::NO_CONTENT;
            r
        }
        _ => error_response(StatusCode::NOT_FOUND, "no such route — see /api/openapi.json"),
    }
}

/// An OpenAPI 3.1 document for the routes, the operations' schemas inlined.
pub fn openapi() -> Value {
    let mut paths = serde_json::Map::new();
    paths.insert("/api/health".into(), json!({ "get": { "summary": "Server health and counts", "responses": { "200": { "description": "ok" } } } }));
    paths.insert("/api/ops".into(), json!({ "get": { "summary": "The operation catalogue with parameter schemas", "responses": { "200": { "description": "ok" } } } }));
    paths.insert("/api/jobs".into(), json!({ "get": { "summary": "Jobs started with ?async=1", "responses": { "200": { "description": "ok" } } } }));
    paths.insert("/api/jobs/{id}".into(), json!({
        "get": { "summary": "A job's state and result", "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } }], "responses": { "200": { "description": "ok" }, "404": { "description": "no such job" } } },
        "delete": { "summary": "Ask the job's operation to stop", "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } }], "responses": { "200": { "description": "ok" } } }
    }));
    paths.insert("/api/jobs/{id}/events".into(), json!({ "get": { "summary": "Server-sent events: progress, done, failed", "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } }], "responses": { "200": { "description": "text/event-stream" } } } }));
    paths.insert("/mcp".into(), json!({ "post": { "summary": "Model Context Protocol, streamable HTTP transport", "responses": { "200": { "description": "a JSON-RPC response, or an SSE stream when accepted" } } } }));
    for op in ops::catalogue() {
        paths.insert(format!("/api/ops/{}", op.name), json!({
            "get": { "summary": format!("Describe {}", op.name), "tags": [op.group.as_str()], "responses": { "200": { "description": "ok" } } },
            "post": {
                "summary": op.summary,
                "tags": [op.group.as_str()],
                "parameters": [{ "name": "async", "in": "query", "required": false, "schema": { "type": "boolean" }, "description": "Run as a job; reply 202 with the job id" }],
                "requestBody": { "required": false, "content": { "application/json": { "schema": op.params_schema() } } },
                "responses": { "200": { "description": "the operation's result" }, "202": { "description": "a job was started" }, "404": { "description": "unknown operation" }, "422": { "description": "the operation failed; the error message in the body" } }
            }
        }));
    }
    json!({
        "openapi": "3.1.0",
        "info": { "title": "PointCloudLabeler API", "version": env!("CARGO_PKG_VERSION"), "description": "Every analysis of the desktop application as an HTTP endpoint. Results are the operations' JSON; long runs can be jobs with progress streams." },
        "paths": paths,
    })
}

// --- the server -----------------------------------------------------------

/// The `serve` subcommand.
pub fn command() -> Command {
    let c = Command::new("serve")
        .about("Serve the catalogue as an HTTP API (and MCP over HTTP) — on 127.0.0.1:7878 unless --bind says otherwise")
        .arg(Arg::new("bind").long("bind").value_name("ADDR:PORT").default_value(DEFAULT_BIND).help("Address to listen on. Anything but the loopback interface needs --token."))
        .arg(Arg::new("token").long("token").value_name("TOKEN").env("POINTCLOUDLABELER_API_TOKEN").help("Bearer token every request must carry (also from the environment)"))
        .arg(Arg::new("print-token").long("print-token").action(ArgAction::SetTrue).help("Generate a random token, print it, and require it"));
    #[cfg(feature = "api-tls")]
    let c = c
        .arg(Arg::new("tls-cert").long("tls-cert").value_name("PEM").requires("tls-key").help("Serve HTTPS with this certificate chain (PEM)"))
        .arg(Arg::new("tls-key").long("tls-key").value_name("PEM").requires("tls-cert").help("…and this private key (PEM)"));
    c
}

fn random_token() -> String {
    // No random crate in the tree is needed for a session token: the
    // clock, the pid and an address, mixed through a 64-bit hash.
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    std::time::SystemTime::now().hash(&mut h);
    std::process::id().hash(&mut h);
    let marker = Box::new(0u8);
    (&*marker as *const u8 as usize).hash(&mut h);
    let a = h.finish();
    std::time::Instant::now().hash(&mut h);
    let b = h.finish();
    format!("{a:016x}{b:016x}")
}

/// Run the server as the subcommand asks. Returns when the listener fails.
pub fn run(m: &ArgMatches) -> Result<(), String> {
    let bind: SocketAddr = m.get_one::<String>("bind").unwrap().parse().map_err(|e| format!("--bind: {e}"))?;
    let mut token = m.get_one::<String>("token").cloned().filter(|t| !t.is_empty());
    if m.get_flag("print-token") {
        let t = random_token();
        eprintln!("token: {t}");
        token = Some(t);
    }
    if !bind.ip().is_loopback() && token.is_none() {
        return Err(format!("{bind} is not the loopback interface — set --token (or POINTCLOUDLABELER_API_TOKEN), or --print-token"));
    }
    #[cfg(feature = "api-tls")]
    let tls = match (m.get_one::<String>("tls-cert"), m.get_one::<String>("tls-key")) {
        (Some(c), Some(k)) => Some(tls::acceptor(c, k)?),
        _ => None,
    };
    #[cfg(not(feature = "api-tls"))]
    let tls: Option<()> = None;
    let api = Api::new(Arc::new(AppState::default()), token);
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|e| format!("runtime: {e}"))?;
    rt.block_on(async move {
        let listener = tokio::net::TcpListener::bind(bind).await.map_err(|e| format!("bind {bind}: {e}"))?;
        let local = listener.local_addr().map_err(|e| e.to_string())?;
        eprintln!(
            "{} API on {}://{local} — {} operations; {}",
            mcp::SERVER_NAME,
            if tls.is_some() { "https" } else { "http" },
            ops::catalogue().len(),
            if api.token.is_some() { "bearer token required" } else { "no token (loopback only)" }
        );
        serve_on(listener, api, tls).await
    })
}

/// Accept connections on `listener` forever.
async fn serve_on(listener: tokio::net::TcpListener, api: Arc<Api>, tls: Option<TlsAcceptor>) -> Result<(), String> {
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("accept: {e}");
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let api = api.clone();
        let tls = tls.clone();
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |req| handle(api.clone(), req));
            #[cfg(feature = "api-tls")]
            if let Some(acceptor) = tls {
                match acceptor.accept(stream).await {
                    Ok(tls_stream) => {
                        let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(tls_stream), service).await;
                    }
                    Err(e) => eprintln!("tls handshake: {e}"),
                }
                return;
            }
            #[cfg(not(feature = "api-tls"))]
            let _ = tls;
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
        });
    }
}

#[cfg(feature = "api-tls")]
type TlsAcceptor = tokio_rustls::TlsAcceptor;
#[cfg(not(feature = "api-tls"))]
type TlsAcceptor = ();

#[cfg(feature = "api-tls")]
mod tls {
    use rustls_pki_types::pem::PemObject;
    use rustls_pki_types::{CertificateDer, PrivateKeyDer};
    use std::sync::Arc;

    pub fn acceptor(cert_path: &str, key_path: &str) -> Result<tokio_rustls::TlsAcceptor, String> {
        let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(cert_path)
            .map_err(|e| format!("read {cert_path}: {e}"))?
            .collect::<Result<_, _>>()
            .map_err(|e| format!("parse {cert_path}: {e}"))?;
        if certs.is_empty() {
            return Err(format!("{cert_path} holds no certificate"));
        }
        let key = PrivateKeyDer::from_pem_file(key_path).map_err(|e| format!("read {key_path}: {e}"))?;
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| format!("tls versions: {e}"))?
            .with_no_client_auth()
            .with_single_cert(certs, key)
            .map_err(|e| format!("certificate and key: {e}"))?;
        Ok(tokio_rustls::TlsAcceptor::from(Arc::new(config)))
    }
}

/// Start a server on an ephemeral loopback port for tests and embedding;
/// returns the address once bound. Runs on its own runtime thread.
pub fn spawn_test_server(api: Arc<Api>) -> SocketAddr {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("api-test".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
            rt.block_on(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                tx.send(listener.local_addr().unwrap()).unwrap();
                let _ = serve_on(listener, api, None).await;
            });
        })
        .unwrap();
    rx.recv().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    /// A raw HTTP/1.1 request over std, so the test has no HTTP client
    /// crate in it either. Reads to EOF (Connection: close).
    fn http(addr: SocketAddr, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> (u16, String, String) {
        let mut s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
        for (k, v) in headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("\r\n");
        req.push_str(body);
        s.write_all(req.as_bytes()).unwrap();
        let mut raw = Vec::new();
        let _ = s.read_to_end(&mut raw);
        let text = String::from_utf8_lossy(&raw).to_string();
        let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
        let status: u16 = head.split_whitespace().nth(1).unwrap_or("0").parse().unwrap_or(0);
        let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") { dechunk(body) } else { body.to_string() };
        (status, head.to_string(), body)
    }

    fn dechunk(s: &str) -> String {
        let mut out = String::new();
        let mut rest = s;
        loop {
            let Some((size_line, after)) = rest.split_once("\r\n") else { break };
            let size = usize::from_str_radix(size_line.trim(), 16).unwrap_or(0);
            if size == 0 {
                break;
            }
            out.push_str(&after[..size.min(after.len())]);
            rest = after.get(size + 2..).unwrap_or("");
        }
        out
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pcl-api-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_catalogue_is_served_and_operations_run_synchronously() {
        let addr = spawn_test_server(Api::new(Arc::new(AppState::default()), None));
        let (status, _, body) = http(addr, "GET", "/api/health", &[], "");
        assert_eq!(status, 200);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["ok"], true);
        assert!(v["operations"].as_u64().unwrap() >= 40);

        let (status, _, body) = http(addr, "GET", "/api/ops", &[], "");
        assert_eq!(status, 200);
        assert!(serde_json::from_str::<Value>(&body).unwrap().as_array().unwrap().len() >= 40);
        let (status, _, body) = http(addr, "GET", "/api/ops/qc.flags", &[], "");
        assert_eq!(status, 200);
        assert!(body.contains("octreeDir"));
        let (status, _, _) = http(addr, "GET", "/api/ops/nothing.here", &[], "");
        assert_eq!(status, 404);

        let dir = scratch("sync");
        let params = json!({ "octreeDir": dir.to_string_lossy(), "verdicts": { "5": "flag" } }).to_string();
        let (status, _, body) = http(addr, "POST", "/api/ops/review.set", &[("Content-Type", "application/json")], &params);
        assert_eq!(status, 200, "{body}");
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["flagged"], 1);
        let (status, _, body) = http(addr, "POST", "/api/ops/review.set", &[], "{not json");
        assert_eq!(status, 400, "{body}");
        let (status, _, body) = http(addr, "POST", "/api/ops/dataset.info", &[], &json!({ "octreeDir": dir.to_string_lossy() }).to_string());
        assert_eq!(status, 422, "{body}");
        assert!(body.contains("is not a dataset"));
        let (status, _, body) = http(addr, "GET", "/api/openapi.json", &[], "");
        assert_eq!(status, 200);
        let doc: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(doc["openapi"], "3.1.0");
        assert!(doc["paths"]["/api/ops/segment.chm"]["post"]["requestBody"].is_object());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_job_runs_in_the_background_and_streams_its_end() {
        let addr = spawn_test_server(Api::new(Arc::new(AppState::default()), None));
        let dir = scratch("job");
        let params = json!({ "octreeDir": dir.to_string_lossy() }).to_string();
        let (status, head, body) = http(addr, "POST", "/api/ops/review.treemap?async=1", &[], &params);
        assert_eq!(status, 202, "{body}");
        let v: Value = serde_json::from_str(&body).unwrap();
        let id = v["jobId"].as_u64().unwrap();
        assert!(head.to_ascii_lowercase().contains(&format!("location: /api/jobs/{id}")));
        // Poll until done.
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut job = Value::Null;
        while Instant::now() < deadline {
            let (_, _, body) = http(addr, "GET", &format!("/api/jobs/{id}"), &[], "");
            job = serde_json::from_str(&body).unwrap();
            if job["status"] != "running" {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(job["status"], "done", "{job}");
        assert_eq!(job["result"], json!({}));
        // The event stream of a finished job: its state, then it closes.
        let (status, head, body) = http(addr, "GET", &format!("/api/jobs/{id}/events"), &[], "");
        assert_eq!(status, 200);
        assert!(head.to_ascii_lowercase().contains("text/event-stream"), "{head}");
        assert!(body.contains("event: state"), "{body}");
        let (status, _, body) = http(addr, "GET", "/api/jobs", &[], "");
        assert_eq!(status, 200);
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap().as_array().unwrap().len(), 1);
        let (status, _, _) = http(addr, "GET", "/api/jobs/999", &[], "");
        assert_eq!(status, 404);
        let (status, _, body) = http(addr, "DELETE", &format!("/api/jobs/{id}"), &[], "");
        assert_eq!(status, 200);
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["stopRequested"], false, "a finished job is not asked to stop");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_token_guards_every_route() {
        let addr = spawn_test_server(Api::new(Arc::new(AppState::default()), Some("s3cret".into())));
        let (status, head, _) = http(addr, "GET", "/api/health", &[], "");
        assert_eq!(status, 401);
        assert!(head.to_ascii_lowercase().contains("www-authenticate: bearer"));
        let (status, _, _) = http(addr, "GET", "/api/health", &[("Authorization", "Bearer wrong")], "");
        assert_eq!(status, 401);
        let (status, _, _) = http(addr, "GET", "/api/health", &[("Authorization", "Bearer s3cret")], "");
        assert_eq!(status, 200);
        let (status, _, _) = http(addr, "POST", "/mcp", &[], "{}");
        assert_eq!(status, 401);
    }

    #[test]
    fn the_mcp_transport_answers_over_http_as_json_or_as_events() {
        let addr = spawn_test_server(Api::new(Arc::new(AppState::default()), None));
        let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "0" } } }).to_string();
        let (status, head, body) = http(addr, "POST", "/mcp", &[("Content-Type", "application/json"), ("Accept", "application/json")], &init);
        assert_eq!(status, 200, "{body}");
        assert!(head.to_ascii_lowercase().contains("mcp-session-id"));
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["result"]["serverInfo"]["name"], "pointcloudlabeler");
        // A notification gets 202 and no body.
        let (status, _, body) = http(addr, "POST", "/mcp", &[], &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string());
        assert_eq!(status, 202);
        assert!(body.is_empty());
        // tools/list as an event stream.
        let list = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }).to_string();
        let (status, head, body) = http(addr, "POST", "/mcp", &[("Accept", "application/json, text/event-stream")], &list);
        assert_eq!(status, 200);
        assert!(head.to_ascii_lowercase().contains("text/event-stream"), "{head}");
        let data = body.lines().find(|l| l.starts_with("data: ")).unwrap().trim_start_matches("data: ");
        let v: Value = serde_json::from_str(data).unwrap();
        assert_eq!(v["id"], 2);
        assert!(v["result"]["tools"].as_array().unwrap().len() >= 40);
        let (status, _, _) = http(addr, "GET", "/mcp", &[], "");
        assert_eq!(status, 405);
    }

    #[test]
    fn a_non_loopback_bind_needs_a_token() {
        let m = command().try_get_matches_from(["serve", "--bind", "0.0.0.0:7878"]).unwrap();
        let err = run(&m).unwrap_err();
        assert!(err.contains("not the loopback interface"), "{err}");
        let m = command().try_get_matches_from(["serve", "--bind", "nonsense"]).unwrap();
        assert!(run(&m).unwrap_err().contains("--bind"));
        assert_eq!(random_token().len(), 32);
        assert_ne!(random_token(), random_token());
    }
}
