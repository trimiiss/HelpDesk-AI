/**
 * A phone in a browser tab. It speaks Twilio's media protocol, so the gateway
 * can't tell it from a real call, and you can test with your own voice without a
 * phone number. Mic audio is converted to 8 kHz mu-law, the same as a phone line.
 */
export const PHONE_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Helpdesk Test Phone</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --panel:#fff; --text:#1a1d23; --muted:#626b7a; --border:#dfe3e9; --go:#15803d; --stop:#b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14161a; --panel:#1d2026; --text:#e7e9ee; --muted:#9aa3b2; --border:#2e333c; --go:#4ade80; --stop:#f2b8b5; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,sans-serif; }
  main { width:100%; max-width:440px; background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:24px; }
  h1 { margin:0 0 4px; font-size:20px; }
  p { margin:0 0 16px; color:var(--muted); }
  button { width:100%; padding:12px; border:0; border-radius:8px; font:inherit; font-weight:600; color:var(--panel); background:var(--go); cursor:pointer; }
  button.hangup { background:var(--stop); }
  #status { margin:12px 0 0; min-height:1.5em; }
  #log { margin-top:12px; max-height:240px; overflow-y:auto; display:grid; gap:6px; }
  #log div { padding:6px 10px; border:1px solid var(--border); border-radius:6px; overflow-wrap:anywhere; }
  form { display:none; gap:8px; margin-top:12px; }
  form.on { display:flex; }
  input { flex:1; min-width:0; padding:10px; border:1px solid var(--border); border-radius:8px; background:var(--bg); color:var(--text); font:inherit; }
  form button { width:auto; padding:10px 14px; }
</style>
</head>
<body>
<main>
  <h1>Helpdesk test phone</h1>
  <p id="intro"></p>
  <button id="call" type="button">Start call</button>
  <p id="status" role="status"></p>
  <form id="typed"><input id="line" placeholder="Type what the caller says" autocomplete="off" /><button type="submit">Say</button></form>
  <div id="log"></div>
</main>
<script>
const AI = '__SIM_AI__';
const intro = document.getElementById('intro');
const button = document.getElementById('call');
const statusLine = document.getElementById('status');
const log = document.getElementById('log');
const typed = document.getElementById('typed');
const line = document.getElementById('line');

intro.textContent = AI === 'real'
  ? 'Talk through your microphone to the real AI. No phone number needed.'
  : 'Fake AI mode: type what the caller says, and answers come from your knowledge files.';

let socket, audio, stopMic, playAt = 0, sources = [];

function addLog(who, text) {
  const row = document.createElement('div');
  row.textContent = who + ': ' + text;
  log.append(row);
  log.scrollTop = log.scrollHeight;
}

function linearToMulaw(sample) {
  const BIAS = 0x84, CLIP = 32635;
  let value = Math.max(-1, Math.min(1, sample)) * 32767;
  const sign = value < 0 ? 0x80 : 0;
  value = Math.min(Math.abs(value), CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function mulawToLinear(byte) {
  const value = ~byte & 0xff;
  const exponent = (value >> 4) & 0x07;
  const sample = ((((value & 0x0f) << 3) + 0x84) << exponent) - 0x84;
  return (value & 0x80 ? -sample : sample) / 32768;
}

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function agentText(bytes) {
  const marker = 'SIM-AGENT:';
  if (bytes.length < marker.length) return null;
  for (let i = 0; i < marker.length; i++) if (bytes[i] !== marker.charCodeAt(i)) return null;
  const end = bytes.indexOf(0, marker.length);
  return new TextDecoder().decode(bytes.subarray(marker.length, end === -1 ? undefined : end));
}

function play(bytes) {
  const buffer = audio.createBuffer(1, bytes.length, 8000);
  const channel = buffer.getChannelData(0);
  const silent = agentText(bytes) !== null || AI !== 'real';
  for (let i = 0; i < bytes.length; i++) channel[i] = silent ? 0 : mulawToLinear(bytes[i]);
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.connect(audio.destination);
  playAt = Math.max(playAt, audio.currentTime);
  source.start(playAt);
  playAt += buffer.duration;
  sources.push(source);
  source.onended = () => { sources = sources.filter((s) => s !== source); };
}

/** Twilio echoes a mark once the audio before it has played. */
function echoMark(name) {
  const wait = Math.max(0, (playAt - audio.currentTime) * 1000);
  setTimeout(() => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event: 'mark', name }));
  }, wait);
}

function clearPlayback() {
  for (const source of sources) { try { source.stop(); } catch {} }
  sources = [];
  playAt = 0;
}

async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const input = audio.createMediaStreamSource(stream);
  const code = 'class Tap extends AudioWorkletProcessor { process(inputs) { if (inputs[0][0]) this.port.postMessage(inputs[0][0].slice(0)); return true; } } registerProcessor("tap", Tap);';
  await audio.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
  const tap = new AudioWorkletNode(audio, 'tap');

  const ratio = audio.sampleRate / 8000;
  let pending = [], sum = 0, count = 0, frame = [];
  tap.port.onmessage = ({ data }) => {
    for (const sample of data) {
      sum += sample; count++;
      if (count >= ratio) {
        frame.push(linearToMulaw(sum / count));
        sum = 0; count -= ratio;
        if (frame.length === 160) {
          if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event: 'media', payload: toBase64(frame) }));
          frame = [];
        }
      }
    }
  };
  input.connect(tap);
  return () => { input.disconnect(); tap.disconnect(); stream.getTracks().forEach((track) => track.stop()); };
}

function finish(detail) {
  if (stopMic) { stopMic(); stopMic = undefined; }
  clearPlayback();
  if (audio) { audio.close(); audio = undefined; }
  if (socket) { socket.onclose = null; socket.close(); socket = undefined; }
  typed.classList.remove('on');
  button.textContent = 'Start call';
  button.classList.remove('hangup');
  statusLine.textContent = detail;
}

async function startCall() {
  log.replaceChildren();
  audio = new AudioContext();
  if (AI === 'real') {
    try { stopMic = await startMic(); }
    catch { finish('Microphone access is needed for this test.'); return; }
  }

  statusLine.textContent = 'Connecting...';
  socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/phone');
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.event === 'connected') {
      statusLine.textContent = 'In call';
      if (AI !== 'real') { typed.classList.add('on'); line.focus(); }
    } else if (message.event === 'media') {
      const bytes = fromBase64(message.media.payload);
      const text = agentText(bytes);
      if (text !== null) addLog('Agent', text);
      play(bytes);
    } else if (message.event === 'mark') {
      echoMark(message.mark.name);
    } else if (message.event === 'clear') {
      clearPlayback();
      addLog('Agent', '(interrupted)');
    } else if (message.event === 'ended') {
      finish(message.detail);
    }
  };
  socket.onclose = () => finish('Call ended');
  button.textContent = 'Hang up';
  button.classList.add('hangup');
}

button.addEventListener('click', () => { socket ? finish('Call ended') : startCall(); });

typed.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = line.value.trim();
  if (!text || !socket) return;
  addLog('You', text);
  socket.send(JSON.stringify({ event: 'say', text }));
  line.value = '';
});
</script>
</body>
</html>`;
