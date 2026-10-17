mod analysis;
mod app;
mod bridge;
mod handoff;
mod llm;
use analysis::Result;
use app::{App, Shared};
use fs2::FileExt;
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    path::PathBuf,
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
use tiny_http::{Header, Method, Request, Response, Server};

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).unwrap()
}
fn respond(req: Request, status: u16, mime: &str, data: Vec<u8>, download: Option<&str>) {
    let mut response=Response::from_data(data).with_status_code(status)
        .with_header(header("Content-Type",mime)).with_header(header("Cache-Control","no-store"))
        .with_header(header("X-Content-Type-Options","nosniff"))
        .with_header(header("Referrer-Policy","no-referrer"))
        .with_header(header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'none'"));
    if let Some(name) = download {
        response = response.with_header(header(
            "Content-Disposition",
            &format!("attachment; filename=\"{name}\""),
        ));
    }
    let _ = req.respond(response);
}
fn authorized(req: &Request, host: &str, token: &str) -> bool {
    let get = |name: &str| {
        req.headers()
            .iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
            .map(|h| h.value.as_str())
    };
    get("Host") == Some(host)
        && get("Origin").is_none_or(|o| o == format!("http://{host}"))
        && get("X-Ad-Check-Token") == Some(token)
}
fn handle(mut req: Request, shared: Shared, host: &str, token: &str, quit: Arc<AtomicBool>) {
    let path = req.url().to_string();
    if !path.starts_with("/api/") {
        let good_host = req
            .headers()
            .iter()
            .any(|h| h.field.equiv("Host") && h.value.as_str() == host);
        if req.method() != &Method::Get || !good_host {
            respond(req, 403, "text/plain", b"Forbidden".to_vec(), None);
            return;
        }
        let (mime, body) = match path.as_str() {
            "/" => (
                "text/html; charset=utf-8",
                include_bytes!("../web/index.html").as_slice(),
            ),
            "/app.js" => (
                "text/javascript; charset=utf-8",
                include_bytes!("../web/app.js").as_slice(),
            ),
            "/style.css" => (
                "text/css; charset=utf-8",
                include_bytes!("../web/style.css").as_slice(),
            ),
            _ => ("text/plain", b"Not found".as_slice()),
        };
        let status = if mime == "text/plain" { 404 } else { 200 };
        respond(req, status, mime, body.to_vec(), None);
        return;
    }
    if !authorized(&req, host, token) {
        respond(
            req,
            403,
            "application/json",
            r#"{"error":"连接凭证无效，请重新打开应用。"}"#.as_bytes().to_vec(),
            None,
        );
        return;
    }
    if req.method() == &Method::Get
        && ["/api/state", "/api/report", "/api/handoff", "/api/summary"].contains(&path.as_str())
    {
        let result = (|| -> Result<(Vec<u8>, &str, Option<&str>)> {
            let mut s = shared.lock().unwrap();
            s.heartbeat = std::time::Instant::now();
            if path == "/api/handoff" {
                if s.phase != "done" {
                    return Err("请先完成检测或导入 HAR。".into());
                }
                return Ok((
                    handoff::package(&s.report()?)?,
                    "application/zip",
                    Some("surge-ad-check-handoff.zip"),
                ));
            }
            let value = if path == "/api/state" {
                let mut v = s.snapshot()?;
                v["llm"] = llm::settings(&s.folder);
                v
            } else if path == "/api/summary" {
                llm::summary(&s.report()?)
            } else {
                s.report()?
            };
            Ok((
                serde_json::to_vec(&value).unwrap(),
                "application/json",
                if path == "/api/report" {
                    Some("surge-ad-check-report.json")
                } else {
                    None
                },
            ))
        })();
        match result {
            Ok((b, m, n)) => respond(req, 200, m, b, n),
            Err(e) => respond(
                req,
                400,
                "application/json",
                json!({"error":e}).to_string().into_bytes(),
                None,
            ),
        }
        return;
    }
    let is_json = req.headers().iter().any(|h| {
        h.field.equiv("Content-Type")
            && h.value.as_str().split(';').next() == Some("application/json")
    });
    if req.method() != &Method::Post || !is_json {
        respond(
            req,
            405,
            "application/json",
            br#"{"error":"POST JSON required"}"#.to_vec(),
            None,
        );
        return;
    }
    let max = if path == "/api/import" {
        24_000_000
    } else {
        32_000
    };
    let mut bytes = Vec::new();
    if req
        .as_reader()
        .take(max + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > max
    {
        respond(
            req,
            413,
            "application/json",
            br#"{"error":"File too large"}"#.to_vec(),
            None,
        );
        return;
    }
    let value = match serde_json::from_slice::<Value>(&bytes) {
        Ok(v) => v,
        Err(_) => {
            respond(
                req,
                400,
                "application/json",
                br#"{"error":"Invalid JSON"}"#.to_vec(),
                None,
            );
            return;
        }
    };
    let result = (|| -> Result<Value> {
        if path == "/api/start" {
            App::start(&shared)?;
            return Ok(json!({"ok":true}));
        }
        if path == "/api/llm/test" || path == "/api/llm/analyze" {
            let (folder, report) = {
                let s = shared.lock().unwrap();
                if path.ends_with("analyze") && s.phase != "done" {
                    return Err("请先结束检测或导入 HAR。".into());
                }
                (
                    s.folder.clone(),
                    if path.ends_with("analyze") {
                        Some(s.report()?)
                    } else {
                        None
                    },
                )
            };
            return llm::call(&folder, report.as_ref());
        }
        let mut s = shared.lock().unwrap();
        s.heartbeat = std::time::Instant::now();
        match path.as_str() {
            "/api/settings" => s.configure(&value)?,
            "/api/prepare" => s.prepare()?,
            "/api/stop" => s.stop()?,
            "/api/recover" => s.recover()?,
            "/api/feedback" => s.feedback(&value)?,
            "/api/baseline" => s.baseline()?,
            "/api/import" => s.import_har(value)?,
            "/api/llm/settings" => {
                return llm::save(&s.folder, &value);
            }
            "/api/llm/forget" => {
                return llm::forget(&s.folder);
            }
            "/api/quit" => {
                s.stop()?;
                quit.store(true, Ordering::SeqCst);
            }
            _ => return Err("未知操作。".into()),
        }
        Ok(json!({"ok":true}))
    })();
    match result {
        Ok(v) => respond(
            req,
            200,
            "application/json",
            v.to_string().into_bytes(),
            None,
        ),
        Err(e) => respond(
            req,
            400,
            "application/json",
            json!({"error":e}).to_string().into_bytes(),
            None,
        ),
    }
}
fn launch() -> Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).is_some_and(|v| v == "--watchdog") {
        if let (Some(folder), Some(session)) = (args.get(2), args.get(3)) {
            bridge::watchdog(&PathBuf::from(folder), session);
        }
        return Ok(());
    }
    let folder = args
        .iter()
        .position(|a| a == "--data-dir")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                .join("Library/Application Support/Surge Ad Check")
        });
    bridge::private_dir(&folder)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(folder.join("app.lock"))
        .map_err(|_| "无法打开本地数据目录。")?;
    if lock.try_lock_exclusive().is_err() {
        let runtime = bridge::load(&folder.join("runtime.json"));
        if let Some(url) = runtime["url"].as_str() {
            let _ = Command::new("open").arg(url).spawn();
        }
        return Ok(());
    }
    let shared = Arc::new(Mutex::new(App::new(folder.clone())?));
    let quit = Arc::new(AtomicBool::new(false));
    let q = quit.clone();
    ctrlc::set_handler(move || {
        q.store(true, Ordering::SeqCst);
    })
    .map_err(|_| "无法设置退出保护。")?;
    let server = Server::http("127.0.0.1:0").map_err(|_| "无法启动本机界面。")?;
    let host = server.server_addr().to_string();
    let token = bridge::token();
    let url = format!("http://{host}/#{token}");
    bridge::save(&folder.join("runtime.json"), &json!({"url":url}))?;
    if !args.iter().any(|a| a == "--no-open") {
        let _ = Command::new("open").arg(&url).spawn();
    }
    println!("Surge Ad Check 已启动；连接信息保存在本地 runtime.json。");
    let s = shared.clone();
    let q = quit.clone();
    thread::spawn(move || {
        while !q.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_secs(2));
            let mut a = s.lock().unwrap();
            if a.phase == "running"
                && (bridge::now() >= a.deadline || a.heartbeat.elapsed() > Duration::from_secs(45))
            {
                let _ = a.stop();
            }
        }
    });
    while !quit.load(Ordering::SeqCst) {
        if let Some(req) = server
            .recv_timeout(Duration::from_millis(200))
            .map_err(|_| "本机界面连接中断。")?
        {
            let s = shared.clone();
            let h = host.clone();
            let t = token.clone();
            let q = quit.clone();
            thread::Builder::new()
                .stack_size(16 * 1024 * 1024)
                .spawn(move || handle(req, s, &h, &t, q))
                .map_err(|_| "无法启动本地请求处理。")?;
        }
    }
    let _ = shared.lock().unwrap().stop();
    let _ = fs::remove_file(folder.join("runtime.json"));
    Ok(())
}
fn main() {
    if let Err(e) = launch() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
