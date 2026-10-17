use crate::analysis::{MODULE, Result, hash};
use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn token() -> String {
    let mut b = [0u8; 16];
    OsRng.fill_bytes(&mut b);
    b.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|_| "无法创建本地数据目录。".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法保护本地目录权限。".to_string())?;
    }
    Ok(())
}
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(p) = path.parent() {
        private_dir(p)?;
    }
    let temp = path.with_extension(format!("{}.tmp", token()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .map_err(|_| "无法保存本地文件。".to_string())?;
    file.write_all(bytes)
        .map_err(|_| "无法写入本地文件。".to_string())?;
    file.sync_all()
        .map_err(|_| "无法保存本地文件。".to_string())?;
    fs::rename(&temp, path).map_err(|_| "无法完成本地文件保存。".to_string())
}
pub fn save(path: &Path, value: &Value) -> Result<()> {
    write_private(
        path,
        &serde_json::to_vec_pretty(value).map_err(|_| "无效的数据。".to_string())?,
    )
}
pub fn load(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}

#[derive(Clone)]
pub struct Bridge {
    pub profile: PathBuf,
    pub cli: PathBuf,
    pub address: String,
    secret: String,
}
impl Bridge {
    pub fn new(settings: &Value) -> Result<Self> {
        let profile = PathBuf::from(settings["profile"].as_str().unwrap_or(""));
        if !profile.is_file() || profile.extension().and_then(|s| s.to_str()) != Some("conf") {
            return Err("请选择现有 Surge 配置文件；工具只读取，不修改该文件。".into());
        }
        let host = settings["host"].as_str().unwrap_or("").trim();
        if host.is_empty()
            || host.len() > 253
            || !host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || ".:-".contains(c))
        {
            return Err("请输入 iPhone 的局域网地址，例如 192.168.1.10。".into());
        }
        let cli = PathBuf::from(
            settings["cli"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("/Applications/Surge.app/Contents/Applications/surge-cli"),
        );
        if !cli.is_file() {
            return Err("实时检测需要安装 Surge Mac；仍可直接使用 HAR 离线分析。".into());
        }
        let contents =
            fs::read_to_string(&profile).map_err(|_| "无法读取所选配置文件。".to_string())?;
        let (secret, port) = credentials(&contents)?;
        let address = if host.contains(':') {
            format!("[{host}]:{port}")
        } else {
            format!("{host}:{port}")
        };
        Ok(Self {
            profile,
            cli,
            address,
            secret,
        })
    }
    fn process(&self, args: &[&str], raw: bool) -> Result<Child> {
        let mut c = Command::new(&self.cli);
        c.args(["--remote", &self.address, "--password-stdin"]);
        if raw {
            c.arg("--raw");
        }
        c.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = c
            .spawn()
            .map_err(|_| "无法启动 Surge 连接工具。".to_string())?;
        if let Some(mut input) = child.stdin.take() {
            if writeln!(input, "{}", self.secret).is_err() {
                let _ = child.kill();
                return Err("无法发送连接凭据。".into());
            }
        }
        Ok(child)
    }
    pub fn command(&self, args: &[&str], raw: bool) -> Result<String> {
        let mut child = self.process(args, raw)?;
        let stdout = child.stdout.take().ok_or("无法读取 Surge 返回结果。")?;
        let reader = thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stdout.take(2_000_001).read_to_end(&mut bytes);
            bytes
        });
        let started = Instant::now();
        let status;
        loop {
            if let Some(s) = child
                .try_wait()
                .map_err(|_| "Surge 连接异常。".to_string())?
            {
                status = s;
                break;
            }
            if started.elapsed() > Duration::from_secs(12) {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("连接手机超时。请检查同一网络、手机地址和 Surge 远程控制。".into());
            }
            thread::sleep(Duration::from_millis(30));
        }
        let bytes = reader.join().map_err(|_| "Surge 返回异常。".to_string())?;
        if !status.success() || bytes.len() > 2_000_000 {
            return Err("Surge 未完成请求，请检查远程控制权限或诊断模块同步。".into());
        }
        let text = String::from_utf8(bytes).map_err(|_| "Surge 返回格式异常。".to_string())?;
        if !raw
            && ["error", "failed", "not found"]
                .iter()
                .any(|s| text.to_lowercase().contains(s))
        {
            return Err("Surge 未完成请求，请检查手机中的诊断模块。".into());
        }
        Ok(text)
    }
    pub fn json(&self, args: &[&str]) -> Result<Value> {
        let text = self.command(args, true)?;
        let v: Value =
            serde_json::from_str(&text).map_err(|_| "Surge 返回格式异常。".to_string())?;
        if !v["error"].is_null() {
            return Err("Surge 返回错误；请检查连接和版本兼容性。".into());
        }
        Ok(v)
    }
    pub fn modules(&self) -> Result<Value> {
        self.json(&["module", "list"])
    }
    pub fn scripts(&self) -> Result<Value> {
        Ok(self.json(&["script", "list"])?["scripts"].clone())
    }
    pub fn enabled(&self) -> Result<bool> {
        Ok(self.modules()?["enabled"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == MODULE)))
    }
    pub fn lease(&self, value: &Value, folder: &Path) -> Result<()> {
        let value = if value.is_null() {
            String::new()
        } else {
            value.to_string()
        };
        let source = format!(
            "if(!$persistentStore.write({},'surge-ad-check-session')){{throw new Error('lease write failed');}}$done();",
            json!(value)
        );
        let path = folder.join("lease.js");
        write_private(&path, source.as_bytes())?;
        self.command(
            &["script", "evaluate", path.to_str().ok_or("文件路径无效。")?],
            false,
        )?;
        Ok(())
    }
    pub fn watch(&self) -> Result<Child> {
        self.process(&["watch", "request", "request-update"], true)
    }
    pub fn digest(&self) -> Result<String> {
        Ok(hash(
            &fs::read(&self.profile).map_err(|_| "无法核验主配置文件。".to_string())?,
        ))
    }
}

fn credentials(contents: &str) -> Result<(String, u16)> {
    let setting = contents
        .lines()
        .filter_map(|l| l.split_once('='))
        .find(|(k, _)| k.trim() == "external-controller-access")
        .map(|(_, v)| v.trim())
        .ok_or("配置中没有远程控制信息；请先在 Surge 中启用远程控制。")?;
    let (secret, address) = setting.rsplit_once('@').ok_or("远程控制信息格式无效。")?;
    let port = address
        .rsplit_once(':')
        .and_then(|(_, p)| p.parse::<u16>().ok())
        .filter(|p| *p > 0)
        .ok_or("远程控制端口无效。")?;
    if secret.is_empty() || secret.contains(['\n', '\r']) {
        return Err("远程控制密码格式无效。".into());
    }
    Ok((secret.to_string(), port))
}

pub fn defaults() -> Value {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let folder = home.join("Library/Mobile Documents/iCloud~com~nssurge~inc/Documents");
    let mut profiles = fs::read_dir(folder)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("conf"))
        .collect::<Vec<_>>();
    profiles.sort();
    let selected = profiles
        .iter()
        .find(|p| {
            p.file_stem()
                .is_some_and(|s| s.to_string_lossy().to_lowercase().contains("home"))
        })
        .or(profiles.first());
    json!({"host":"","profile":selected.map(|p|p.to_string_lossy().into_owned()).unwrap_or_default(),"cli":"/Applications/Surge.app/Contents/Applications/surge-cli","profiles":profiles})
}

pub fn restore(folder: &Path) -> Result<()> {
    let mut state = load(&folder.join("recovery.json"));
    if state["pending"] != true {
        return Ok(());
    }
    let b = Bridge::new(&state["settings"])?;
    b.command(&["module", "disable", MODULE], false)?;
    if b.enabled()? {
        return Err("诊断模块尚未关闭，请在手机 Surge 手动关闭 Surge Ad Check。".into());
    }
    let _ = b.lease(&Value::Null, folder);
    state["pending"] = json!(false);
    save(&folder.join("recovery.json"), &state)
}
pub fn watchdog(folder: &Path, session: &str) {
    for _ in 0..240 {
        let state = load(&folder.join("recovery.json"));
        if state["pending"] != true || state["session"] != session {
            return;
        }
        if now() >= state["deadline"].as_u64().unwrap_or(0) && restore(folder).is_ok() {
            return;
        }
        thread::sleep(Duration::from_secs(3));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_are_read_only() {
        let c = "[General]\nexternal-controller-access = test@0.0.0.0:6170\n";
        assert_eq!(credentials(c).unwrap(), ("test".into(), 6170));
        assert!(credentials("external-controller-access = password").is_err());
    }
}
