use crate::{analysis::Result, bridge};
use serde_json::{Value, json};
use std::path::Path;

fn validated(value: &Value) -> Result<Value> {
    let font = value["font"].as_str().unwrap_or("");
    let size = value["size"].as_u64().unwrap_or(0);
    if !["system", "pingfang", "heiti", "song"].contains(&font) || ![13, 14, 16, 18].contains(&size)
    {
        return Err("请选择支持的字体和字号。".into());
    }
    Ok(json!({"font":font,"size":size}))
}

pub fn settings(folder: &Path) -> Value {
    validated(&bridge::load(&folder.join("appearance.json")))
        .unwrap_or_else(|_| json!({"font":"system","size":14}))
}

pub fn save(folder: &Path, value: &Value) -> Result<Value> {
    let result = validated(value)?;
    bridge::save(&folder.join("appearance.json"), &result)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_supported_preferences() {
        for font in ["system", "pingfang", "heiti", "song"] {
            for size in [13, 14, 16, 18] {
                assert_eq!(
                    validated(&json!({"font":font,"size":size,"extra":"discard"})).unwrap(),
                    json!({"font":font,"size":size})
                );
            }
        }
        for value in [
            json!({"font":"url(remote)","size":14}),
            json!({"font":"system","size":100}),
            json!({"font":"song","size":14.5}),
            Value::Null,
        ] {
            assert!(validated(&value).is_err());
        }
    }
}
