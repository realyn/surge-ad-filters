use crate::{analysis::Result, bridge};
use serde_json::{Value, json};
use std::{io::Read, path::Path, time::Duration};
use url::Url;
const SERVICE: &str = "com.realyn.surge-ad-check.llm";

pub fn defaults() -> Value {
    json!({"enabled":false,"provider":"qwen","baseURL":"https://dashscope.aliyuncs.com/compatible-mode/v1","model":"qwen-plus","maxTokens":1200,"hasKey":false})
}
pub fn settings(folder: &Path) -> Value {
    let v = bridge::load(&folder.join("llm.json"));
    if v.is_object() { v } else { defaults() }
}
fn endpoint(value: &Value) -> Result<String> {
    let raw = value["baseURL"]
        .as_str()
        .unwrap_or("")
        .trim()
        .trim_end_matches('/');
    let u = Url::parse(raw).map_err(|_| "API 地址格式无效。".to_string())?;
    if u.scheme() != "https"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err("API 地址必须是无账号、查询参数和片段的 HTTPS 地址。".into());
    }
    if raw.ends_with("/chat/completions") {
        return Err("请填写 Base URL，不要包含 /chat/completions。".into());
    }
    Ok(format!("{raw}/chat/completions"))
}
fn account(settings: &Value) -> String {
    bridge_hash(settings["baseURL"].as_str().unwrap_or(""))
}
fn bridge_hash(s: &str) -> String {
    crate::analysis::hash(s.as_bytes())
}

pub fn save(folder: &Path, value: &Value) -> Result<Value> {
    endpoint(value)?;
    let model = value["model"].as_str().unwrap_or("").trim();
    if model.is_empty() || model.len() > 128 || model.chars().any(char::is_control) {
        return Err("请输入有效的模型 ID。".into());
    }
    let provider = value["provider"]
        .as_str()
        .filter(|s| ["qwen", "deepseek", "custom"].contains(s))
        .unwrap_or("custom");
    let previous = settings(folder);
    let mut config = json!({"enabled":value["enabled"]==true,"provider":provider,"baseURL":value["baseURL"].as_str().unwrap().trim().trim_end_matches('/'),"model":model,"maxTokens":value["maxTokens"].as_u64().unwrap_or(1200).clamp(256,2400),"hasKey":previous["hasKey"]==true&&previous["baseURL"]==value["baseURL"]});
    if let Some(key) = value["apiKey"].as_str().filter(|s| !s.trim().is_empty()) {
        if key.len() > 8192 || key.chars().any(char::is_control) {
            return Err("API Key 格式无效。".into());
        }
        #[cfg(target_os = "macos")]
        security_framework::passwords::set_generic_password(
            SERVICE,
            &account(&config),
            key.trim().as_bytes(),
        )
        .map_err(|_| "无法保存到 Mac 钥匙串，请允许钥匙串访问。".to_string())?;
        #[cfg(not(target_os = "macos"))]
        return Err("此版本的 API 密钥存储仅支持 Mac 钥匙串。".into());
        config["hasKey"] = json!(true);
    }
    bridge::save(&folder.join("llm.json"), &config)?;
    Ok(config)
}
pub fn forget(folder: &Path) -> Result<Value> {
    let mut s = settings(folder);
    #[cfg(target_os = "macos")]
    {
        let _ = security_framework::passwords::delete_generic_password(SERVICE, &account(&s));
    }
    s["hasKey"] = json!(false);
    s["enabled"] = json!(false);
    bridge::save(&folder.join("llm.json"), &s)?;
    Ok(s)
}

pub fn request_body(config: &Value, report: Option<&Value>) -> Value {
    let system = "你是 Surge 广告规则维护助手。输入是程序生成的脱敏诊断摘要，不含完整响应。必须区分已观察事实、可能解释和待验证项目。没有实机数据时不能断言广告消失或正常浏览不受影响。结构变化不等于广告。不要猜测接口、广告字段或报告未提供的内容，不提供未经验证的整站域名/IP 拦截方案。请按“观察证据、可能原因、最小修改方向、需要补抓的内容、回归验证和回滚”给出中文修复方案；没有字段级证据时不得编造可安装脚本。未知字段名已做指纹化，不能猜测其原始名字。禁止要求上传凭据、证书或完整个人抓包。你无权修改配置或执行操作。";
    let message = report
        .map(|r| {
            format!(
                "分析以下诊断摘要。指出证据缺口，只有证据充分时才建议下一步修复方向：\n{}",
                summary(r)
            )
        })
        .unwrap_or_else(|| "连接测试：只回复 OK。".into());
    let mut body = json!({"model":config["model"],"stream":false,"max_tokens":if report.is_some(){config["maxTokens"].as_u64().unwrap_or(1200)}else{32},"messages":[{"role":"system","content":if report.is_some(){system}else{"只做连接测试。"}},{"role":"user","content":message}]});
    if config["provider"] == "qwen" {
        body["enable_thinking"] = json!(false);
    }
    if config["provider"] == "deepseek" {
        body["thinking"] = json!({"type":"disabled"});
    }
    body
}
pub fn summary(report: &Value) -> Value {
    // Explicit export whitelist: never connection settings, request URLs, bodies or credentials.
    let rows=report["rows"].as_array().map(|rows|rows.iter().map(|r|json!({"route":r["route"],"count":r["count"],"status":r["status"],"reasons":r["reasons"],"beforeAds":r["beforeAds"],"afterAds":r["afterAds"],"normal":r["normal"],"preservation":r["preservation"],"simulated":r["simulated"],"baseline":r["baseline"],"structureChanges":r["changes"],"newTypes":r["newTypes"]})).collect::<Vec<_>>()).unwrap_or_default();
    json!({"evidenceMode":report["mode"].as_str().unwrap_or("live"),"rows":rows,"coverage":report["coverage"],"visibleFeedback":report["feedback"],"newEndpointCount":report["newEndpointCount"],"failedRequests":report["failedRequests"],"errors":report["errors"],"notice":report["notice"]})
}
pub fn call(folder: &Path, report: Option<&Value>) -> Result<Value> {
    let config = settings(folder);
    if config["enabled"] != true {
        return Err("请先在设置中启用可选模型分析。".into());
    }
    let url = endpoint(&config)?;
    #[cfg(target_os = "macos")]
    let key = security_framework::passwords::get_generic_password(SERVICE, &account(&config))
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .ok_or("请先填写 API Key 并保存到钥匙串。")?;
    #[cfg(not(target_os = "macos"))]
    let key: String = return Err("此版本仅支持 Mac 钥匙串。".into());
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(50)))
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = agent
        .post(&url)
        .header("Authorization", format!("Bearer {key}"))
        .send_json(request_body(&config, report))
        .map_err(|_| "API 连接失败或超时；请检查地址、网络和模型服务状态。".to_string())?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(match status {
            401 | 403 => "API 鉴权失败，请检查密钥与模型权限。".into(),
            429 => "API 限流或额度不足，请在服务商控制台检查。".into(),
            404 => "API 地址或模型不存在，请核对 Base URL 和模型 ID。".into(),
            _ => format!("API 返回 HTTP {status}，未执行任何配置修改。"),
        });
    }
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(2_000_001)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取 API 响应。".to_string())?;
    if bytes.len() > 2_000_000 {
        return Err("API 响应超出大小限制。".into());
    }
    parse_response(&config, &bytes)
}

fn parse_response(config: &Value, bytes: &[u8]) -> Result<Value> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| "API 未返回兼容的 JSON 数据。".to_string())?;
    let content = value["choices"][0]["message"]["content"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("模型没有返回文本；请使用支持非流式 Chat Completions 的模型。")?;
    // The response remains untrusted advice; no tools or executable actions exist here.
    Ok(
        json!({"text":content.chars().take(20000).collect::<String>(),"usage":{"prompt_tokens":value["usage"]["prompt_tokens"].as_u64(),"completion_tokens":value["usage"]["completion_tokens"].as_u64()},"model":config["model"],"adviceOnly":true}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn safe_endpoints() {
        assert!(endpoint(&json!({"baseURL":"http://example.com"})).is_err());
        assert!(endpoint(&json!({"baseURL":"https://key@example.com"})).is_err());
        assert!(endpoint(&json!({"baseURL":"https://example.com?token=x"})).is_err());
        assert_eq!(
            endpoint(&json!({"baseURL":"https://api.deepseek.com"})).unwrap(),
            "https://api.deepseek.com/chat/completions"
        );
    }
    #[test]
    fn export_drops_credentials() {
        let r = summary(
            &json!({"settings":{"apiKey":"SECRET"},"body":"PRIVATE","URL":"https://secret.invalid","rows":[]}),
        );
        assert!(!r.to_string().contains("SECRET"));
        assert!(!r.to_string().contains("PRIVATE"));
        assert!(!r.to_string().contains("secret.invalid"));
    }
    #[test]
    fn test_does_not_send_report() {
        let b = request_body(&defaults(), None);
        assert_eq!(b["max_tokens"], 32);
        assert!(!b.to_string().contains("诊断摘要"));
    }
    #[test]
    fn compatible_response_is_advice_only() {
        let config = json!({"model":"test-model"});
        let response=br#"{"choices":[{"message":{"content":"OK","tool_calls":[{"function":{"name":"run"}}]}}],"usage":{"prompt_tokens":12,"completion_tokens":2}}"#;
        let result = parse_response(&config, response).unwrap();
        assert_eq!(result["text"], "OK");
        assert_eq!(result["adviceOnly"], true);
        assert!(result["tool_calls"].is_null());
        assert_eq!(result["usage"]["prompt_tokens"], 12);
        assert!(
            parse_response(
                &config,
                br#"{"choices":[{"message":{"reasoning_content":"thinking"}}]}"#
            )
            .is_err()
        );
        assert!(parse_response(&config, b"not json").is_err());
    }
}
