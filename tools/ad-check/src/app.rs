use crate::{
    analysis::{self, MODULE, Result},
    bridge::{self, Bridge},
};
use base64::Engine as _;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Instant,
};

pub type Shared = Arc<Mutex<App>>;
pub struct App {
    pub folder: PathBuf,
    pub settings: Value,
    pub phase: String,
    pub message: String,
    pub heartbeat: Instant,
    pub deadline: u64,
    pub session: String,
    pub child: Option<Child>,
    pub events: Vec<Value>,
    pub requests: Vec<Value>,
    pub errors: Vec<String>,
    pub feedback: Value,
    pub last: Value,
    pub baseline: Value,
    seen_events: HashSet<String>,
    seen_requests: HashSet<String>,
    bridge: Option<Bridge>,
    original_hash: String,
    paths: BTreeMap<String, String>,
}
impl App {
    pub fn new(folder: PathBuf) -> Result<Self> {
        bridge::private_dir(&folder)?;
        let saved = bridge::load(&folder.join("settings.json"));
        let settings = if saved.is_object() {
            saved
        } else {
            bridge::defaults()
        };
        let last = bridge::load(&folder.join("latest-report.json"));
        let has_report = last["rows"].is_array();
        Ok(Self {
            baseline: bridge::load(&folder.join("baseline.json")),
            folder,
            settings,
            phase: if has_report { "done" } else { "idle" }.into(),
            message: if has_report {
                "已载入上次报告；点击开始可进行新的检测。"
            } else {
                "选择手机连接后开始；也可以直接导入 HAR。"
            }
            .into(),
            heartbeat: Instant::now(),
            deadline: 0,
            session: last["id"]
                .as_str()
                .filter(|id| id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit()))
                .unwrap_or("")
                .into(),
            child: None,
            events: vec![],
            requests: vec![],
            errors: vec![],
            feedback: if has_report {
                last["feedback"].clone()
            } else {
                json!({})
            },
            last: if has_report { last } else { Value::Null },
            seen_events: HashSet::new(),
            seen_requests: HashSet::new(),
            bridge: None,
            original_hash: String::new(),
            paths: BTreeMap::new(),
        })
    }
    pub fn report(&self) -> Result<Value> {
        if !self.last.is_null() {
            return Ok(self.last.clone());
        }
        analysis::run(
            "report",
            &[
                json!({"events":self.events,"requests":self.requests,"baseline":self.baseline,"feedback":self.feedback,"errors":self.errors}),
            ],
        )
    }
    pub fn snapshot(&self) -> Result<Value> {
        Ok(
            json!({"phase":self.phase,"message":self.message,"remaining":if self.phase=="running"{self.deadline.saturating_sub(bridge::now())}else{0},"settings":self.settings,"report":self.report()?,"hasBaseline":!self.baseline.is_null(),"recoveryPending":bridge::load(&self.folder.join("recovery.json"))["pending"]==true}),
        )
    }
    pub fn configure(&mut self, value: &Value) -> Result<()> {
        if self.phase == "running" {
            return Err("请先结束检测再更改连接。".into());
        }
        let mut settings = json!({});
        for k in ["host", "profile", "cli"] {
            settings[k] = json!(value[k].as_str().unwrap_or(""));
        }
        Bridge::new(&settings)?;
        bridge::save(&self.folder.join("settings.json"), &settings)?;
        self.settings = settings;
        Ok(())
    }
    fn validate(&self, scripts: &Value, observed: bool) -> Result<()> {
        let failures = analysis::run("precedence", &[scripts.clone(), json!(observed)])?;
        if failures.as_array().is_none_or(|a| !a.is_empty()) {
            return Err(
                "诊断脚本的匹配顺序与预期不一致，已停止启动。请检查手机模块同步或重叠规则。".into(),
            );
        }
        for d in analysis::definitions() {
            let app = d["app"].as_str().unwrap();
            let name = if observed {
                format!("adcheck-{app}")
            } else {
                format!("{app}-ad-filter")
            };
            let hits = scripts
                .as_array()
                .ok_or("无法识别脚本列表。")?
                .iter()
                .filter(|s| s["enabled"] == true && s["name"] == name)
                .collect::<Vec<_>>();
            if hits.len() != 1 {
                return Err(format!("{app} 的脚本数量不符合预期；请检查重复模块。"));
            }
            let s = hits[0];
            let p = &s["parameters"];
            let expected = if observed {
                self.paths.get(app).map(String::as_str).unwrap_or("")
            } else {
                d["sourceURL"].as_str().unwrap()
            };
            if p["pattern"] != d["pattern"]
                || p["max-size"] != "2097152"
                || p["requires-body"] != "true"
                || s["path"] != expected
            {
                return Err(format!(
                    "{app} 的版本或参数与工具不一致。请同步诊断模块或更新工具后重试。"
                ));
            }
        }
        Ok(())
    }
    pub fn prepare(&mut self) -> Result<()> {
        if self.phase == "running" {
            return Err("检测已在进行中。".into());
        }
        bridge::restore(&self.folder)?;
        let b = Bridge::new(&self.settings)?;
        let hash = b.digest()?;
        if b.json(&["profile", "current"])?["profile"]
            != b.profile.file_stem().and_then(|x| x.to_str()).unwrap_or("")
        {
            return Err("手机当前配置与本机选定的配置名称不同，请选择正确文件。".into());
        }
        if b.enabled()? {
            return Err("诊断模块已开启，请先点击恢复正常模式。".into());
        }
        self.validate(&b.scripts()?, false)?;
        let (files, paths) = analysis::build();
        self.paths = paths;
        let parent = b.profile.parent().ok_or("配置目录无效。")?;
        for (name, content) in files {
            let target = parent.join(&name);
            if target.exists() {
                let old =
                    fs::read_to_string(&target).map_err(|_| "无法读取诊断文件。".to_string())?;
                if old == content {
                    continue;
                }
                if name != "SurgeAdCheck.sgmodule" || !old.starts_with("#!name=Surge Ad Check\n") {
                    return Err("同名文件不是本工具生成的版本，已保留。".into());
                }
            }
            // Only these four generated observer files are written. The profile is read-only.
            fs::write(&target, content)
                .map_err(|_| "无法写入独立诊断模块；请确认 Surge iCloud 目录可用。".to_string())?;
        }
        if b.digest() != Ok(hash.clone()) {
            return Err("主配置文件在检查期间发生外部变化；工具没有修改它。".into());
        }
        self.bridge = Some(b);
        self.original_hash = hash;
        self.phase = "ready".into();
        self.message = "连接通过。首次使用请打开 iPhone Surge 等待 iCloud 同步，随后开始。".into();
        Ok(())
    }
    pub fn start(shared: &Shared) -> Result<()> {
        let mut s = shared.lock().unwrap();
        s.prepare()?;
        let b = s.bridge.clone().ok_or("连接未准备。")?;
        let available = b.modules()?;
        if !available["available"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == MODULE))
        {
            return Err(
                "诊断模块尚未同步。请打开 iPhone Surge 等待几秒，再点开始；无需修改 Home。".into(),
            );
        }
        s.session = bridge::token();
        s.deadline = bridge::now() + 360;
        s.heartbeat = Instant::now();
        s.events.clear();
        s.requests.clear();
        s.errors.clear();
        s.seen_events.clear();
        s.seen_requests.clear();
        s.feedback = json!({});
        s.last = Value::Null;
        let session = s.session.clone();
        let folder = s.folder.clone();
        bridge::save(
            &folder.join("recovery.json"),
            &json!({"pending":true,"session":session,"settings":s.settings,"hash":s.original_hash,"deadline":s.deadline+30}),
        )?;
        let result = (|| -> Result<()> {
            Command::new(std::env::current_exe().map_err(|_| "无法启动恢复保护。".to_string())?)
                .args([
                    "--watchdog",
                    folder.to_str().ok_or("数据目录无效。")?,
                    &session,
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| "无法启动恢复保护。".to_string())?;
            b.lease(
                &json!({"id":session,"expires":(s.deadline+30)*1000}),
                &folder,
            )?;
            s.child = Some(b.watch()?);
            b.command(&["module", "enable", MODULE], false)?;
            s.validate(&b.scripts()?, true)?;
            Ok(())
        })();
        if let Err(e) = result {
            if let Some(mut p) = s.child.take() {
                let _ = p.kill();
                let _ = p.wait();
            }
            if let Err(r) = bridge::restore(&folder) {
                s.errors.push(r);
            }
            s.phase = "error".into();
            return Err(e);
        }
        let stdout = s
            .child
            .as_mut()
            .and_then(|c| c.stdout.take())
            .ok_or("无法读取手机请求。")?;
        s.phase = "running".into();
        s.message = "已开始：请在手机按检查路线浏览，完成后点击结束。最长 6 分钟自动结束。".into();
        drop(s);
        let failure_shared = shared.clone();
        let shared = shared.clone();
        thread::Builder::new()
            .stack_size(16 * 1024 * 1024)
            .spawn(move || {
                let mut engine = match analysis::Engine::new() {
                    Ok(e) => e,
                    Err(_) => {
                        let mut s = shared.lock().unwrap();
                        s.errors.push("摘要分析器初始化失败。".into());
                        let _ = s.stop();
                        return;
                    }
                };
                let mut reader = BufReader::new(stdout);
                loop {
                    let mut bytes = Vec::new();
                    match reader
                        .by_ref()
                        .take(2_000_001)
                        .read_until(b'\n', &mut bytes)
                    {
                        Ok(0) | Err(_) => break,
                        _ => {}
                    }
                    if bytes.len() > 2_000_000 {
                        break;
                    }
                    let record: Value = match serde_json::from_slice(&bytes) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let item = match engine.run("ingest", &[record, json!(session)]) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let mut s = shared.lock().unwrap();
                    if s.phase != "running" || s.session != session {
                        return;
                    }
                    if item["diagnosticIssue"] == true
                        && !s.errors.iter().any(|x| x.starts_with("诊断日志不完整"))
                    {
                        s.errors
                            .push("诊断日志不完整，部分接口无法验证；请更新工具后重试。".into());
                    }
                    let Some(id) = item["id"].as_str() else {
                        continue;
                    };
                    if item["request"]["completed"] == true
                        && s.requests.len() < 10000
                        && s.seen_requests.insert(id.into())
                    {
                        s.requests.push(item["request"].clone());
                    }
                    if let Some(events) = item["events"].as_array() {
                        for e in events {
                            let key = format!("{id}:{}", e["route"]);
                            if s.events.len() < 5000 && s.seen_events.insert(key) {
                                s.events.push(e.clone());
                            }
                        }
                    }
                }
                let mut s = shared.lock().unwrap();
                if s.phase == "running" && s.session == session {
                    s.errors
                        .push("手机数据连接中断，已尝试关闭诊断模块。".into());
                    let _ = s.stop();
                }
            })
            .map_err(|_| {
                let mut state = failure_shared.lock().unwrap();
                state.errors.push("无法启动摘要读取线程。".into());
                let _ = state.stop();
                "无法启动摘要读取线程，已尝试关闭诊断模块。".to_string()
            })?;
        Ok(())
    }
    pub fn stop(&mut self) -> Result<()> {
        if self.phase != "running" && self.phase != "error" {
            return Ok(());
        }
        self.phase = "stopping".into();
        if let Some(mut p) = self.child.take() {
            let _ = p.kill();
            let _ = p.wait();
        }
        if let Err(e) = bridge::restore(&self.folder) {
            self.errors.push(e);
        }
        let unchanged = self
            .bridge
            .as_ref()
            .is_some_and(|b| b.digest() == Ok(self.original_hash.clone()));
        if !unchanged {
            self.errors
                .push("主配置文件校验与开始时不一致或无法读取；工具没有写入该文件。".into());
        }
        self.last = Value::Null;
        let mut report = self.report()?;
        report["id"] = json!(self.session);
        report["homeUnchanged"] = json!(unchanged);
        report["restored"] =
            json!(bridge::load(&self.folder.join("recovery.json"))["pending"] != true);
        bridge::save(
            &self
                .folder
                .join("reports")
                .join(format!("{}.json", self.session)),
            &report,
        )?;
        self.message = if report["restored"] == true {
            "报告已生成，诊断模块已关闭。"
        } else {
            "诊断连接中断，请在手机手动关闭 Surge Ad Check。"
        }
        .into();
        bridge::save(&self.folder.join("latest-report.json"), &report)?;
        self.last = report;
        self.phase = "done".into();
        Ok(())
    }
    pub fn recover(&mut self) -> Result<()> {
        if self.phase == "running" {
            return self.stop();
        }
        if bridge::load(&self.folder.join("recovery.json"))["pending"] == true {
            bridge::restore(&self.folder)?;
        } else {
            let b = Bridge::new(&self.settings)?;
            b.command(&["module", "disable", MODULE], false)?;
            if b.enabled()? {
                return Err("请在手机手动关闭 Surge Ad Check。".into());
            }
        }
        self.phase = "idle".into();
        self.message = "诊断模块已关闭，原过滤模块保持原状态。".into();
        Ok(())
    }
    pub fn feedback(&mut self, value: &Value) -> Result<()> {
        let mut f = json!({});
        for app in ["weibo", "zhibo8", "xianyu"] {
            for key in ["visibleAd", "normalBrowsing"] {
                let v = value[app][key]
                    .as_str()
                    .filter(|s| ["yes", "no", "untested"].contains(s))
                    .unwrap_or("untested");
                f[app][key] = json!(v);
            }
        }
        self.feedback = f.clone();
        if !self.last.is_null() {
            self.last["feedback"] = f;
            bridge::save(
                &self
                    .folder
                    .join("reports")
                    .join(format!("{}.json", self.session)),
                &self.last,
            )?;
            bridge::save(&self.folder.join("latest-report.json"), &self.last)?;
        }
        Ok(())
    }
    pub fn baseline(&mut self) -> Result<()> {
        if self.phase != "done" {
            return Err("请先结束检测。".into());
        }
        let r = analysis::run("baseline", &[self.last.clone(), self.baseline.clone()])?;
        bridge::save(&self.folder.join("baseline.json"), &r["baseline"])?;
        self.baseline = r["baseline"].clone();
        self.message = format!(
            "已更新 {} 个已确认接口的基准；未覆盖的页面保留原基准。",
            r["count"]
        );
        Ok(())
    }
    pub fn import_har(&mut self, har: Value) -> Result<()> {
        if self.phase == "running" {
            return Err("请先结束实时检测。".into());
        }
        let entries = har["log"]["entries"]
            .as_array()
            .ok_or("文件不是有效 HAR。")?;
        if entries.len() > 20000 {
            return Err("HAR 条目过多，请导出较短的检测会话。".into());
        }
        let mut engine = analysis::Engine::new()?;
        let mut input = vec![];
        let mut requests = vec![];
        let mut missing = 0;
        for e in entries {
            let url = e["request"]["url"].as_str().unwrap_or("");
            let m=engine.run("metadata",&[json!({"URL":url,"completed":true,"failed":e["response"]["status"].as_u64().unwrap_or(0)>=400})])?;
            if m.is_null() {
                continue;
            }
            requests.push(m);
            let route = engine.run("match", &[json!(url)])?;
            if route.is_null() {
                continue;
            }
            let c = &e["response"]["content"];
            let Some(body) = c["text"].as_str().filter(|s| s.len() <= 3_000_000) else {
                missing += 1;
                continue;
            };
            let body = if c["encoding"] == "base64" {
                match base64::engine::general_purpose::STANDARD
                    .decode(body)
                    .ok()
                    .and_then(|b| String::from_utf8(b).ok())
                {
                    Some(b) => b,
                    None => {
                        missing += 1;
                        continue;
                    }
                }
            } else {
                body.into()
            };
            // Validate depth before passing untrusted text into the embedded JS parser.
            let candidate = if route == "weibo.splash-sdk" {
                body.trim_end()
                    .strip_suffix("OK")
                    .unwrap_or(&body)
                    .trim_end()
            } else {
                &body
            };
            if body.len() > 2_097_152 || serde_json::from_str::<Value>(candidate).is_err() {
                missing += 1;
                continue;
            }
            input.push(json!({"url":url,"status":e["response"]["status"],"body":body}));
            if input.len() > 300 {
                return Err("相关正文超过 300 条，请缩短导出的会话。".into());
            }
        }
        let parsed = engine.run("replay", &[json!(input)])?;
        self.events = parsed.as_array().cloned().unwrap_or_default();
        self.requests = requests;
        self.feedback = json!({});
        self.errors = vec![];
        if missing > 0 {
            self.errors.push(format!(
                "{missing} 条过滤接口正文缺失、超限或无法安全解析，不能验证。"
            ));
        }
        self.session = bridge::token();
        self.last = Value::Null;
        let mut report = self.report()?;
        report["id"] = json!(self.session);
        report["mode"] = json!("har");
        report["restored"] = json!(true);
        report["homeUnchanged"] = Value::Null;
        bridge::save(
            &self
                .folder
                .join("reports")
                .join(format!("{}.json", self.session)),
            &report,
        )?;
        bridge::save(&self.folder.join("latest-report.json"), &report)?;
        self.last = report;
        self.phase = "done".into();
        self.message = "HAR 已在本地完成模拟分析；没有向手机执行任何操作。".into();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn har_ignores_assets_and_rejects_excessively_nested_json() {
        let folder = std::env::temp_dir().join(format!("ad-check-test-{}", bridge::token()));
        let mut app = App::new(folder.clone()).unwrap();
        let deep = format!("{}0{}", "[".repeat(150), "]".repeat(150));
        app.import_har(json!({"log":{"entries":[
            {"request":{"url":"https://api.weibo.cn/static/image.png"},"response":{"status":200}},
            {"request":{"url":"https://api.weibo.cn/2/statuses/home_timeline"},"response":{"status":200,"content":{"text":deep}}}
        ]}})).unwrap();
        assert_eq!(app.last["errors"].as_array().unwrap().len(), 1);
        assert_eq!(app.last["mode"], "har");
        assert!(
            app.last["rows"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r["count"] == 0)
        );
        let reloaded = App::new(folder.clone()).unwrap();
        assert_eq!(reloaded.last["id"], app.last["id"]);
        fs::remove_dir_all(folder).unwrap();
    }
    #[test]
    fn valid_har_uses_embedded_filter_and_never_creates_live_baseline() {
        let folder = std::env::temp_dir().join(format!("ad-check-test-{}", bridge::token()));
        let mut app = App::new(folder.clone()).unwrap();
        app.import_har(json!({"log":{"entries":[{"request":{"url":"https://a.qiumibao.com/ios/config/"},"response":{"status":200,"content":{"text":"{\"advert\":{\"enable\":true}}"}}}]}})).unwrap();
        let row = app.last["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["route"] == "zhibo8.config")
            .unwrap();
        assert_eq!(row["beforeAds"], 1);
        assert_eq!(row["afterAds"], 0);
        assert!(app.baseline().is_err());
        fs::remove_dir_all(folder).unwrap();
    }
}
