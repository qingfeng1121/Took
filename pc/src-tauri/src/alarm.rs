//! 闹钟响铃（定稿 §6.3.5）。
//!
//! 为什么不引额外依赖：Windows 上循环播放闹钟音最直接的一条路是 winmm.dll 的
//! PlaySoundW（SND_ASYNC 异步 + SND_LOOP 循环 + SND_FILENAME 按路径）。
//! 它已经在 windows-sys（tauri 的传递依赖，这里显式声明）里导出，不必为「响一声」再拖一个音频库。
//!
//! 声音来源：优先系统自带的 C:\Windows\Media\AlarmNN.wav（走系统「闹钟」那个文件，用户认得出），
//! 依次退到 Alarm01..Alarm10，都没有就退到系统提示音。
//!
//! **已知差异（如实记录，不假装等价）**：PlaySoundW 走系统默认输出通道，不是 Android
//! AudioAttributes.USAGE_ALARM 那种独立音量通道。Windows 上要做到「不受媒体音量影响」得走
//! WASAPI 会话并改写音频端点，代价远超收益，本期不做。

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;

    use windows_sys::Win32::Media::Audio::{
        PlaySoundW, SND_ASYNC, SND_FILENAME, SND_LOOP, SND_NODEFAULT,
    };

    /// SND_PURGE：停止本进程所有异步播放
    const SND_PURGE: u32 = 64;

    static PLAYING: AtomicBool = AtomicBool::new(false);
    static WAV: OnceLock<Vec<u16>> = OnceLock::new();

    fn wav_path() -> &'static Vec<u16> {
        WAV.get_or_init(|| {
            for i in 1..=10u8 {
                let p = format!(r"C:\Windows\Media\Alarm{:02}.wav", i);
                if std::path::Path::new(&p).exists() {
                    let mut v: Vec<u16> = p.encode_utf16().collect();
                    v.push(0);
                    return v;
                }
            }
            Vec::new()
        })
    }

    /// 开始循环响铃。重复调用幂等（已经在响就什么都不做）。
    pub fn start() {
        if PLAYING.swap(true, Ordering::SeqCst) {
            return;
        }
        let wav = wav_path();
        unsafe {
            if !wav.is_empty() {
                PlaySoundW(
                    wav.as_ptr(),
                    std::ptr::null_mut(),
                    SND_ASYNC | SND_LOOP | SND_FILENAME | SND_NODEFAULT,
                );
            } else {
                PlaySoundW(std::ptr::null(), std::ptr::null_mut(), SND_ASYNC);
            }
        }
        println!("[took][提醒] 响铃开始");
    }

    /// 停止响铃（幂等）。
    pub fn stop() {
        if !PLAYING.swap(false, Ordering::SeqCst) {
            return;
        }
        unsafe {
            PlaySoundW(std::ptr::null(), std::ptr::null_mut(), SND_PURGE);
        }
        println!("[took][提醒] 响铃停止");
    }

    pub fn is_playing() -> bool {
        PLAYING.load(Ordering::SeqCst)
    }
}

/// 开始循环响铃（非 Windows 上是空实现：那边没有 PlaySoundW）
pub fn start() {
    #[cfg(windows)]
    imp::start();
}

/// 停止响铃
pub fn stop() {
    #[cfg(windows)]
    imp::stop();
}

/// 当前是否在响（供设置页如实显示）
pub fn is_playing() -> bool {
    #[cfg(windows)]
    return imp::is_playing();
    #[cfg(not(windows))]
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_and_stop_are_idempotent() {
        // 测试里真的会调 PlaySoundW —— 本机行为，不联网。断言的是状态机幂等，
        // 不是「有声卡」：无声卡时 PlaySoundW 返回 0，但我们维护的标记仍必须自洽。
        start();
        start();
        assert!(is_playing(), "start() 之后应处于响铃中");
        stop();
        assert!(!is_playing(), "stop() 之后应不在响铃");
        stop();
        assert!(!is_playing(), "重复 stop() 仍是不在响铃（幂等）");
    }
}
