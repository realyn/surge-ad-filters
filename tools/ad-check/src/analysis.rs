use boa_engine::{Context, Source};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const INSPECT: &str = include_str!("../inspect.js");
const ANALYSIS: &str = include_str!("../analysis.js");
pub const MODULE: &str = "Surge Ad Check";
pub type Result<T> = std::result::Result<T, String>;
pub fn hash(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

pub fn definitions() -> Vec<Value> {
    [
        ("weibo",include_str!("../../../apps/weibo/Weibo.sgmodule"),include_str!("../../../apps/weibo/weibo.js")),
        ("zhibo8",include_str!("../../../apps/zhibo8/Zhibo8.sgmodule"),include_str!("../../../apps/zhibo8/zhibo8.js")),
        ("xianyu",include_str!("../../../apps/xianyu/Xianyu.sgmodule"),include_str!("../../../apps/xianyu/xianyu.js")),
    ].iter().map(|(app,module,source)| {
        let line=module.lines().find(|l|l.starts_with(&format!("{app}-ad-filter ="))).expect("embedded module");
        let pattern=line.split("pattern=").nth(1).unwrap().split(",requires-body").next().unwrap();
        let url=line.split("script-path=").nth(1).unwrap().split(',').next().unwrap();
        json!({"app":app,"line":line,"pattern":pattern,"sourceURL":url,"source":source,"sourceHash":hash(source.as_bytes())})
    }).collect()
}

pub struct Engine {
    ctx: Context,
}
impl Engine {
    pub fn new() -> Result<Self> {
        let mut ctx = Context::default();
        ctx.runtime_limits_mut().set_loop_iteration_limit(2_000_000);
        ctx.runtime_limits_mut().set_recursion_limit(128);
        let script = format!(
            "{INSPECT}\nconst DEFINITIONS={};\n{ANALYSIS}",
            json!(definitions())
        );
        ctx.eval(Source::from_bytes(&script))
            .map_err(|_| "内置分析器初始化失败。".to_string())?;
        Ok(Self { ctx })
    }
    pub fn run(&mut self, method: &str, args: &[Value]) -> Result<Value> {
        if ![
            "ingest",
            "metadata",
            "replay",
            "precedence",
            "report",
            "baseline",
            "event",
            "match",
        ]
        .contains(&method)
        {
            return Err("未知分析动作。".into());
        }
        let code = format!(
            "JSON.stringify(Engine.{method}({}))",
            args.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join(",")
        );
        let value = self.ctx.eval(Source::from_bytes(&code)).map_err(|_| {
            if method == "baseline" {
                "请完成实机检测，确认已检查应用未看到广告且浏览正常；不能用模拟或异常结果建立基准。"
            } else {
                "分析未完成；输入可能超出大小、结构或运行限制。"
            }
            .to_string()
        })?;
        let text = value
            .as_string()
            .ok_or("分析返回格式异常。")?
            .to_std_string_escaped();
        serde_json::from_str(&text).map_err(|_| "分析返回格式异常。".into())
    }
}

pub fn run(method: &str, args: &[Value]) -> Result<Value> {
    Engine::new()?.run(method, args)
}

pub fn wrapper(def: &Value) -> String {
    let app = &def["app"];
    let source_hash = &def["sourceHash"];
    format!(
        r#"// Surge Ad Check observer. No networking; executes the original embedded filter.
{INSPECT}
(function(realDone){{const raw=$response.body;let completed=false;
function observedDone(result){{if(completed)return;completed=true;
try{{const lease=JSON.parse($persistentStore.read('surge-ad-check-session')||'null');
if(lease&&Date.now()<lease.expires){{const app={app};const route=AdCheck.route(app,$request.url);
const event={{v:1,session:lease.id,app,route,source:{source_hash},status:Number($response.status||$response.statusCode||200),
before:AdCheck.inspect(app,route,raw),after:AdCheck.inspect(app,route,result&&typeof result.body==='string'?result.body:raw)}};
event.preserved=event.before.protected!==null&&event.before.protected!==undefined?event.before.protected===event.after.protected:null;
delete event.before.protected;delete event.after.protected;
console.log('AD_CHECK_V1 '+JSON.stringify(event));}}}}catch(_){{}}
realDone(result);}}
(function($done){{
{}
}})(observedDone);
}})($done);
"#,
        def["source"].as_str().unwrap()
    )
}

pub fn build() -> (BTreeMap<String, String>, BTreeMap<String, String>) {
    let defs = definitions();
    let mut files = BTreeMap::new();
    let mut paths = BTreeMap::new();
    let mut module = String::from(
        "#!name=Surge Ad Check\n#!desc=限时诊断：执行原过滤代码，仅记录脱敏摘要。检测结束后自动关闭。\n\n[Script]\n",
    );
    for d in &defs {
        let app = d["app"].as_str().unwrap();
        let content = wrapper(d);
        let filename = format!("SurgeAdCheck-{app}-{}.js", &hash(content.as_bytes())[..16]);
        let mut line = d["line"]
            .as_str()
            .unwrap()
            .replace(&format!("{app}-ad-filter ="), &format!("adcheck-{app} ="));
        line = line
            .replace(",debug=false", "")
            .replace(",debug=true", "")
            .replace(d["sourceURL"].as_str().unwrap(), &filename);
        module.push_str(&format!("{line},debug=true\n"));
        files.insert(filename.clone(), content);
        paths.insert(app.into(), filename);
    }
    files.insert("SurgeAdCheck.sgmodule".into(), module);
    (files, paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_is_uncovered() {
        let r = run("report", &[json!({})]).unwrap();
        assert!(
            r["rows"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r["status"] == "uncovered")
        );
    }
    #[test]
    fn no_rules_or_mitm() {
        let (files, _) = build();
        let s = &files["SurgeAdCheck.sgmodule"];
        assert!(!s.contains("[Rule]"));
        assert!(!s.contains("[MITM]"));
        assert!(!s.contains("[General]"));
    }
    #[test]
    fn xianyu_replay_protects_normal() {
        let r=run("replay",&[json!([{"url":"https://acs.m.goofish.com/gw/mtop.taobao.idlehome.home.nextfresh/8.0?token=private", "status":200,"body":"{\"data\":{\"sections\":[{\"data\":{\"clickParam\":{\"args\":{\"cardType\":\"mamaAD\"}}}},{\"data\":{\"clickParam\":{\"args\":{\"cardType\":\"item\"}}},\"title\":\"SECRET_ITEM\"}],\"nextPage\":true}}"}])]).unwrap();
        assert_eq!(r[0]["before"]["ads"], 1);
        assert_eq!(r[0]["after"]["ads"], 0);
        assert_eq!(r[0]["after"]["normal"], 1);
        assert_eq!(r[0]["preserved"], true);
        assert!(!r.to_string().contains("SECRET_ITEM"));
        assert!(!r.to_string().contains("private"));
    }
    fn execute(
        source: &str,
        url: &str,
        body: &str,
        status: u16,
        lease: bool,
        logging_fails: bool,
    ) -> Value {
        let mut c = Context::default();
        c.runtime_limits_mut().set_loop_iteration_limit(2_000_000);
        let code = format!(
            r#"JSON.stringify((()=>{{let output=[],logs=[];const $request={{url:{}}},$response={{body:{},status:{status}}},$persistentStore={{read:()=>{}}},console={{log:s=>{{if({logging_fails})throw Error('log');logs.push(s);}}}},$done=r=>output.push(r);{};return {{output,logs}};}})())"#,
            json!(url),
            json!(body),
            json!(if lease {
                json!({"id":"test-session","expires":9_999_999_999_999u64}).to_string()
            } else {
                "null".into()
            }),
            source
        );
        let v = c
            .eval(Source::from_bytes(&code))
            .unwrap()
            .as_string()
            .unwrap()
            .to_std_string_escaped();
        serde_json::from_str(&v).unwrap()
    }
    #[test]
    fn observers_preserve_original_results_even_when_logging_fails() {
        std::thread::Builder::new().stack_size(16*1024*1024).spawn(||{
        let fixtures=[("weibo","https://api.weibo.cn/2/statuses/home_timeline",r#"{"statuses":[{"is_ad":1,"text":"ad"},{"text":"PRIVATE_POST"}],"max_id":"NORMAL_PAGE"}"#),
            ("zhibo8","https://a.qiumibao.com/ios/config/",r#"{"advert":{"enable":true},"advert_config":{"splash_bk":"enable","activities_config":[{"title":"ad"}]},"news":{"title":"PRIVATE_NEWS"}}"#),
            ("xianyu","https://acs.m.goofish.com/gw/mtop.taobao.idlehome.home.nextfresh/8.0",r#"{"data":{"sections":[{"data":{"clickParam":{"args":{"cardType":"mamaAD"}}}},{"title":"PRIVATE_ITEM"}],"nextPage":true}}"#)];
        for(app,url,body)in fixtures{let d=definitions().into_iter().find(|d|d["app"]==app).unwrap();
            for(raw,status)in [(body,200),("invalid json",200),(body,503)]{

                for(lease,broken_log)in [(true,false),(true,true),(false,false)]{
                    let original=execute(d["source"].as_str().unwrap(),url,raw,status,false,broken_log);
                    let observed=execute(&wrapper(&d),url,raw,status,lease,broken_log);assert_eq!(observed["output"],original["output"]);assert_eq!(observed["output"].as_array().unwrap().len(),1);
                    assert!(!observed["logs"].to_string().contains("PRIVATE_"));assert!(!observed["logs"].to_string().contains("NORMAL_PAGE"));
                    if !lease||broken_log{assert_eq!(observed["logs"],original["logs"]);}
                }
            }
        }
        }).unwrap().join().unwrap();
    }
    #[test]
    fn sessions_and_versions_reject_unrelated_logs() {
        let d = &definitions()[0];
        let v = json!({"v":1,"app":"weibo","route":"weibo.feed","source":d["sourceHash"],"session":"old"});
        assert!(run("event", &[v.clone(), json!("new")]).unwrap().is_null());
        let mut v = v;
        v["source"] = json!("fake");
        assert!(run("event", &[v, json!("old")]).unwrap().is_null());
    }
    #[test]
    fn simulation_cannot_be_promoted() {
        assert!(
            run(
                "baseline",
                &[
                    json!({"mode":"har","restored":true,"errors":[]}),
                    Value::Null
                ]
            )
            .is_err()
        );
    }
    #[test]
    fn baseline_retains_unvisited_routes() {
        let old = json!({"routes":{"weibo.comments":{"shapes":["old"],"sources":["source"]}},"endpoints":[]});
        let r = json!({"restored":true,"errors":[],"time":"test","endpoints":[],"feedback":{"xianyu":{"visibleAd":"no","normalBrowsing":"yes"}},"rows":[{"route":"xianyu.home","app":"xianyu","count":1,"simulated":false,"reasons":[],"shapes":["new"],"sources":["new-source"]}]});
        let b = run("baseline", &[r, old.clone()]).unwrap();
        assert_eq!(
            b["baseline"]["routes"]["weibo.comments"],
            old["routes"]["weibo.comments"]
        );
        assert_eq!(b["count"], 1);
    }
    #[test]
    fn metadata_never_exports_urls_or_queries() {
        let v=run("metadata",&[json!({"URL":"https://api.weibo.cn/2/statuses/private-id?token=SECRET","completed":true})]).unwrap();
        assert_eq!(v["app"], "weibo");
        assert!(!v.to_string().contains("SECRET"));
        assert!(!v.to_string().contains("private-id"));
        assert!(!v.to_string().contains("api.weibo"));
    }
}
