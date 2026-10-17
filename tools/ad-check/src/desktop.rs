//! Native macOS shell. Only the trusted local page can request a fixed export.
use crate::{analysis::Result, app::Shared, handoff};
use muda::{
    AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
    accelerator::{Accelerator, Code, Modifiers},
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    platform::run_return::EventLoopExtRunReturn,
    window::WindowBuilder,
};
use wry::{NewWindowResponse, WebViewBuilder};

#[derive(Debug)]
enum DesktopEvent {
    Export(String),
    Menu(muda::MenuId),
}

fn local_page(candidate: &str, origin: &str) -> bool {
    url::Url::parse(candidate)
        .is_ok_and(|u| u.origin().ascii_serialization() == origin && u.path() == "/")
}

fn export(shared: &Shared, route: &str) -> Result<(&'static str, Vec<u8>)> {
    let s = shared.lock().map_err(|_| "无法读取报告。")?;
    if s.phase != "done" {
        return Err("请先结束检测或导入 HAR。".into());
    }
    let report = s.report()?;
    match route {
        "report" => Ok((
            "surge-ad-check-report.json",
            serde_json::to_vec_pretty(&report).map_err(|_| "报告生成失败。")?,
        )),
        "handoff" => Ok(("surge-ad-check-handoff.zip", handoff::package(&report)?)),
        _ => Err("未知导出类型。".into()),
    }
}

pub fn run(
    url: &str,
    shared: Shared,
    quit: Arc<AtomicBool>,
    activate: Arc<AtomicBool>,
) -> Result<()> {
    let mut event_loop = EventLoopBuilder::<DesktopEvent>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title("Surge Ad Check")
        .with_inner_size(LogicalSize::new(1120., 820.))
        .with_min_inner_size(LogicalSize::new(800., 620.))
        .build(&event_loop)
        .map_err(|e| format!("无法创建应用窗口：{e}"))?;
    let quit_item = MenuItem::new(
        "退出 Surge Ad Check",
        true,
        Some(Accelerator::new(Some(Modifiers::META), Code::KeyQ)),
    );
    let settings_item = MenuItem::new(
        "设置…",
        true,
        Some(Accelerator::new(Some(Modifiers::META), Code::Comma)),
    );
    let menu = Menu::new();
    let app_menu = Submenu::with_items(
        "Surge Ad Check",
        true,
        &[
            &PredefinedMenuItem::about(
                Some("关于 Surge Ad Check"),
                Some(AboutMetadata {
                    name: Some("Surge Ad Check".into()),
                    version: Some(env!("CARGO_PKG_VERSION").into()),
                    ..Default::default()
                }),
            ),
            &PredefinedMenuItem::separator(),
            &settings_item,
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::hide(Some("隐藏 Surge Ad Check")),
            &PredefinedMenuItem::hide_others(Some("隐藏其他")),
            &PredefinedMenuItem::show_all(Some("全部显示")),
            &PredefinedMenuItem::separator(),
            &quit_item,
        ],
    )
    .map_err(|e| e.to_string())?;
    let edit = Submenu::with_items(
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(Some("撤销")),
            &PredefinedMenuItem::redo(Some("重做")),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::cut(Some("剪切")),
            &PredefinedMenuItem::copy(Some("复制")),
            &PredefinedMenuItem::paste(Some("粘贴")),
            &PredefinedMenuItem::select_all(Some("全选")),
        ],
    )
    .map_err(|e| e.to_string())?;
    let window_menu = Submenu::with_items(
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(Some("最小化")),
            &PredefinedMenuItem::close_window(Some("关闭窗口并退出")),
        ],
    )
    .map_err(|e| e.to_string())?;
    menu.append_items(&[&app_menu, &edit, &window_menu])
        .map_err(|e| e.to_string())?;
    menu.init_for_nsapp();
    let menu_proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |e: MenuEvent| {
        let _ = menu_proxy.send_event(DesktopEvent::Menu(e.id));
    }));
    let origin = url::Url::parse(url)
        .map_err(|_| "本机界面地址无效。")?
        .origin()
        .ascii_serialization();
    let ipc_origin = origin.clone();
    let proxy = event_loop.create_proxy();
    let webview = WebViewBuilder::new()
        .with_url(url)
        .with_initialization_script(
            "Object.defineProperty(window, 'adCheckDesktop', {value:true});",
        )
        .with_navigation_handler(move |u| local_page(&u, &origin))
        .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
        .with_download_started_handler(|_, _| false)
        .with_ipc_handler(move |req| {
            if !local_page(&req.uri().to_string(), &ipc_origin) {
                return;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(req.body()) {
                if v["command"] == "export" {
                    if let Some(route @ ("report" | "handoff")) = v["route"].as_str() {
                        let _ = proxy.send_event(DesktopEvent::Export(route.into()));
                    }
                }
            }
        })
        .build(&window)
        .map_err(|e| format!("无法载入应用界面：{e}"))?;
    window.set_focus();
    event_loop.run_return(|event, _, flow| {
        *flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(200));
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                quit.store(true, Ordering::SeqCst);
            }
            Event::Reopen { .. } => {
                window.set_visible(true);
                window.set_minimized(false);
                window.set_focus();
            }
            Event::UserEvent(DesktopEvent::Menu(id)) if id == quit_item.id() => {
                quit.store(true, Ordering::SeqCst);
            }
            Event::UserEvent(DesktopEvent::Menu(id)) if id == settings_item.id() => {
                let _ = webview.evaluate_script("window.showPage('settings')");
            }
            Event::UserEvent(DesktopEvent::Export(route)) => {
                let result = (|| -> Result<&str> {
                    let (name, bytes) = export(&shared, &route)?;
                    if let Some(path) = rfd::FileDialog::new()
                        .set_parent(&window)
                        .set_title("保存检测结果")
                        .set_file_name(name)
                        .save_file()
                    {
                        std::fs::write(&path, bytes)
                            .map_err(|_| "无法保存文件，请选择可写入的位置。")?;
                        Ok("已保存。")
                    } else {
                        Ok("已取消保存。")
                    }
                })();
                let message = match result {
                    Ok(m) => m.to_string(),
                    Err(e) => e,
                };
                let _ = webview.evaluate_script(&format!(
                    "window.desktopExportDone({})",
                    serde_json::to_string(&message).unwrap()
                ));
            }
            _ => {}
        }
        if activate.swap(false, Ordering::SeqCst) {
            window.set_visible(true);
            window.set_minimized(false);
            window.set_focus();
        }
        if quit.load(Ordering::SeqCst) {
            *flow = ControlFlow::Exit;
        }
    });
    // Keep the WebView alive for the entire event loop; backend cleanup follows in main.
    drop(webview);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn navigation_is_confined_to_our_page() {
        let origin = "http://127.0.0.1:12345";
        assert!(local_page("http://127.0.0.1:12345/#token", origin));
        for bad in [
            "https://example.com/",
            "http://127.0.0.1:12346/",
            "http://127.0.0.1:12345/api/report",
            "file:///tmp/a",
            "http://127.0.0.1:12345.evil.com/",
        ] {
            assert!(!local_page(bad, origin));
        }
    }
    #[test]
    fn native_exports_require_completed_evidence_and_use_sanitized_report() {
        let folder =
            std::env::temp_dir().join(format!("ad-check-native-test-{}", crate::bridge::token()));
        let mut app = crate::app::App::new(folder.clone()).unwrap();
        let shared = Arc::new(std::sync::Mutex::new(app));
        assert!(export(&shared, "report").is_err());
        app = crate::app::App::new(folder.clone()).unwrap();
        app.import_har(serde_json::json!({"log":{"entries":[{"request":{"url":"https://acs.m.goofish.com/gw/mtop.taobao.idlehome.home.nextfresh/8.0?token=PRIVATE_TOKEN"},"response":{"status":200,"content":{"text":"{\"data\":{\"sections\":[],\"nextPage\":true}}"}}}]}})).unwrap();
        *shared.lock().unwrap() = app;
        let (name, bytes) = export(&shared, "report").unwrap();
        assert_eq!(name, "surge-ad-check-report.json");
        assert!(!String::from_utf8(bytes).unwrap().contains("PRIVATE_TOKEN"));
        let (name, bytes) = export(&shared, "handoff").unwrap();
        assert_eq!(name, "surge-ad-check-handoff.zip");
        assert_eq!(&bytes[..2], b"PK");
        assert!(export(&shared, "file:///tmp/arbitrary").is_err());
        std::fs::remove_dir_all(folder).unwrap();
    }
}
