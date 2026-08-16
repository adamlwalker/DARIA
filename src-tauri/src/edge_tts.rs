//! Microsoft Edge online TTS (Read Aloud) for the "read replies aloud" path.
//!
//! Protocol matches the current `edge-tts` client: Sec-MS-GEC + MUID cookie,
//! Chromium 143 headers, MP3 stream decoded to the PCM the frontend plays.
//! Live voice chat stays on Kokoro.

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::Request;
use tungstenite::{connect, Message};

const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION: &str = "143.0.3650.75";
const VOICES_URL: &str =
    "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list";
const WSS_URL: &str =
    "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
const ORIGIN: &str = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";

const WIN_EPOCH: i64 = 11_644_473_600;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeVoice {
    pub short_name: String,
    pub locale: String,
    pub gender: String,
    pub friendly_name: String,
}

fn fallback_voices() -> Vec<EdgeVoice> {
    const ROWS: &[(&str, &str, &str, &str)] = &[
        ("en-US-JennyNeural", "en-US", "Female", "Jenny (US)"),
        ("en-US-GuyNeural", "en-US", "Male", "Guy (US)"),
        ("en-US-AriaNeural", "en-US", "Female", "Aria (US)"),
        ("en-US-DavisNeural", "en-US", "Male", "Davis (US)"),
        ("en-US-AvaNeural", "en-US", "Female", "Ava (US)"),
        ("en-US-AndrewNeural", "en-US", "Male", "Andrew (US)"),
        ("en-US-EmmaNeural", "en-US", "Female", "Emma (US)"),
        ("en-US-EmmaMultilingualNeural", "en-US", "Female", "Emma Multilingual (US)"),
        ("en-US-BrianNeural", "en-US", "Male", "Brian (US)"),
        ("en-GB-SoniaNeural", "en-GB", "Female", "Sonia (UK)"),
        ("en-GB-RyanNeural", "en-GB", "Male", "Ryan (UK)"),
        ("en-GB-LibbyNeural", "en-GB", "Female", "Libby (UK)"),
        ("en-AU-NatashaNeural", "en-AU", "Female", "Natasha (AU)"),
        ("en-AU-WilliamNeural", "en-AU", "Male", "William (AU)"),
        ("en-CA-ClaraNeural", "en-CA", "Female", "Clara (CA)"),
        ("en-IE-ConnorNeural", "en-IE", "Male", "Connor (IE)"),
        ("en-IN-NeerjaNeural", "en-IN", "Female", "Neerja (IN)"),
    ];
    ROWS.iter()
        .map(|(s, l, g, f)| EdgeVoice {
            short_name: (*s).into(),
            locale: (*l).into(),
            gender: (*g).into(),
            friendly_name: (*f).into(),
        })
        .collect()
}

fn gec_version() -> String {
    format!("1-{CHROMIUM_FULL_VERSION}")
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Sec-MS-GEC: Windows-filetime ticks snapped to 5 minutes, SHA-256 with the
/// trusted client token. `clock_skew_secs` corrects a drifting local clock.
fn sec_ms_gec(clock_skew_secs: i64) -> String {
    let mut ticks = unix_now() + clock_skew_secs + WIN_EPOCH;
    ticks -= ticks.rem_euclid(300);
    let ticks = ticks * 10_000_000;
    let digest = Sha256::digest(format!("{ticks}{TRUSTED_CLIENT_TOKEN}").into_bytes());
    digest.iter().map(|b| format!("{b:02X}")).collect()
}

fn muid() -> String {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{n:032x}").to_ascii_uppercase()
}

fn xml_escape(s: &str) -> String {
    s.chars()
        .map(|c| {
            let code = c as u32;
            if (code <= 8) || (11..=12).contains(&code) || (14..=31).contains(&code) {
                ' '
            } else {
                c
            }
        })
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn pct(delta: f32) -> String {
    format!("{:+.0}%", delta)
}

fn rate_pct(speed: f32) -> String {
    pct((speed.clamp(0.5, 2.0) - 1.0) * 100.0)
}

fn pitch_hz(pitch: f32) -> String {
    format!("{:+.0}Hz", pitch.clamp(-50.0, 50.0))
}

fn connection_id() -> String {
    format!("{:032x}", unix_now().unsigned_abs() as u128 * 1_000_000 + (unix_now() as u128 % 997))
}

fn js_date() -> String {
    let secs = unix_now();
    format!("Thu Jan 01 1970 {secs} GMT+0000 (Coordinated Universal Time)")
}

fn apply_common_headers(req: &mut Request<()>) {
    let headers = req.headers_mut();
    headers.insert("User-Agent", USER_AGENT.parse().unwrap());
    headers.insert("Origin", ORIGIN.parse().unwrap());
    headers.insert("Pragma", "no-cache".parse().unwrap());
    headers.insert("Cache-Control", "no-cache".parse().unwrap());
    headers.insert("Accept-Language", "en-US,en;q=0.9".parse().unwrap());
    headers.insert("Cookie", format!("muid={};", muid()).parse().unwrap());
}

fn mp3_to_f32(bytes: &[u8]) -> Result<(Vec<f32>, u32)> {
    if bytes.is_empty() {
        bail!("Edge TTS returned no audio");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") {
        return pcm_from_riff(bytes);
    }
    let mut dec = minimp3::Decoder::new(bytes);
    let mut samples = Vec::new();
    let mut sr = 24000u32;
    loop {
        match dec.next_frame() {
            Ok(frame) => {
                sr = frame.sample_rate as u32;
                let ch = frame.channels.max(1);
                if ch == 1 {
                    samples.extend(frame.data.iter().map(|s| *s as f32 / 32768.0));
                } else {
                    for chunk in frame.data.chunks(ch) {
                        samples.push(chunk[0] as f32 / 32768.0);
                    }
                }
            }
            Err(minimp3::Error::Eof) => break,
            Err(e) => bail!("Edge TTS MP3 decode failed: {e}"),
        }
    }
    if samples.is_empty() {
        bail!("Edge TTS MP3 decoded to silence");
    }
    Ok((samples, sr))
}

fn pcm_from_riff(bytes: &[u8]) -> Result<(Vec<f32>, u32)> {
    let pcm = if bytes.len() > 44 { &bytes[44..] } else { &[] };
    let samples = pcm
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect();
    Ok((samples, 24000))
}

fn is_english_locale(locale: &str) -> bool {
    let l = locale.to_ascii_lowercase();
    l == "en" || l.starts_with("en-") || l.starts_with("en_")
}

pub async fn list_english_voices() -> Result<Vec<EdgeVoice>> {
    let url = format!(
        "{VOICES_URL}?trustedclienttoken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={}&Sec-MS-GEC-Version={}",
        sec_ms_gec(0),
        gec_version()
    );
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let resp = client
        .get(&url)
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Cookie", format!("muid={};", muid()))
        .send()
        .await;
    let Ok(resp) = resp else {
        return Ok(fallback_voices());
    };
    if !resp.status().is_success() {
        return Ok(fallback_voices());
    }
    let body = match resp.text().await {
        Ok(t) => t,
        Err(_) => return Ok(fallback_voices()),
    };
    let rows: Vec<serde_json::Value> = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return Ok(fallback_voices()),
    };
    let mut out: Vec<EdgeVoice> = rows
        .into_iter()
        .filter_map(|v| {
            let locale = v.get("Locale")?.as_str()?.to_string();
            if !is_english_locale(&locale) {
                return None;
            }
            let short_name = v
                .get("ShortName")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            if short_name.is_empty() {
                return None;
            }
            let gender = v
                .get("Gender")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let friendly = v
                .get("FriendlyName")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| short_name.clone());
            Some(EdgeVoice {
                short_name,
                locale,
                gender,
                friendly_name: friendly,
            })
        })
        .collect();
    if out.is_empty() {
        return Ok(fallback_voices());
    }
    out.sort_by(|a, b| {
        a.locale
            .cmp(&b.locale)
            .then(a.friendly_name.cmp(&b.friendly_name))
    });
    Ok(out)
}

pub async fn synthesize_edge(
    text: String,
    voice: String,
    speed: f32,
    pitch: f32,
    volume: f32,
) -> Result<(Vec<f32>, u32)> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok((Vec::new(), 24000));
    }
    let voice = if voice.trim().is_empty() {
        "en-US-JennyNeural".into()
    } else {
        voice
    };
    tokio::task::spawn_blocking(move || {
        match synthesize_blocking(&text, &voice, speed, pitch, volume, 0) {
            Ok(v) => Ok(v),
            Err(first) => {
                // One retry with a guessed clock skew of ±5 minutes if the
                // handshake was rejected (403).
                synthesize_blocking(&text, &voice, speed, pitch, volume, 300)
                    .or_else(|_| synthesize_blocking(&text, &voice, speed, pitch, volume, -300))
                    .map_err(|e| anyhow!("{first:#}; retry: {e:#}"))
            }
        }
    })
    .await?
}

fn synthesize_blocking(
    text: &str,
    voice: &str,
    speed: f32,
    pitch: f32,
    volume: f32,
    clock_skew: i64,
) -> Result<(Vec<f32>, u32)> {
    let conn = connection_id();
    let url = format!(
        "{WSS_URL}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={}&Sec-MS-GEC-Version={}&ConnectionId={conn}",
        sec_ms_gec(clock_skew),
        gec_version()
    );
    let mut req = url
        .into_client_request()
        .context("build Edge TTS websocket request")?;
    apply_common_headers(&mut req);

    let (mut ws, _resp) = connect(req).map_err(|e| anyhow!("Edge TTS connect failed: {e}"))?;

    let ts = js_date();
    let config = format!(
        "X-Timestamp:{ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"}},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}}}}}\r\n"
    );
    ws.send(Message::Text(config.into()))
        .context("send Edge TTS speech.config")?;

    let ssml = format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>\
            <voice name='{voice}'>\
                <prosody pitch='{pitch}' rate='{rate}' volume='{volume}'>{text}</prosody>\
            </voice>\
        </speak>",
        rate = rate_pct(speed),
        pitch = pitch_hz(pitch),
        volume = pct(volume.clamp(-50.0, 50.0)),
        text = xml_escape(text),
    );
    let ssml_msg = format!(
        "X-RequestId:{conn}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{ts}Z\r\nPath:ssml\r\n\r\n{ssml}"
    );
    ws.send(Message::Text(ssml_msg.into()))
        .context("send Edge TTS SSML")?;

    let mut audio = Vec::new();
    loop {
        match ws.read() {
            Ok(Message::Binary(bin)) => {
                if bin.len() < 2 {
                    continue;
                }
                let header_len = u16::from_be_bytes([bin[0], bin[1]]) as usize;
                if 2 + header_len > bin.len() {
                    continue;
                }
                audio.extend_from_slice(&bin[2 + header_len..]);
            }
            Ok(Message::Text(t)) => {
                if t.contains("Path:turn.end") {
                    break;
                }
            }
            Ok(Message::Ping(p)) => {
                let _ = ws.send(Message::Pong(p));
            }
            Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => {}
            Ok(Message::Close(_)) => break,
            Err(e) => bail!("Edge TTS read failed: {e}"),
        }
    }
    let _ = ws.close(None);
    mp3_to_f32(&audio)
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "hits Microsoft Edge TTS"]
    fn live_synth_jenny() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (samples, sr) = rt
            .block_on(super::synthesize_edge(
                "Hello from DARIA.".into(),
                "en-US-JennyNeural".into(),
                1.0,
                0.0,
                0.0,
            ))
            .expect("Edge TTS synthesize");
        assert!(sr >= 16000, "sample rate {sr}");
        assert!(samples.len() > 1000, "got {} samples", samples.len());
    }
}
