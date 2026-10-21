'use strict';

// ============================================================
// Samplerate aus dem Datei-Header lesen, damit decodeAudioData NICHT
// resampled (Python: librosa.load(sr=None) -> native Samplerate)
// ============================================================
function sniffSampleRate(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  const str = (o, n) => String.fromCharCode(...b.subarray(o, o + n));

  // WAV
  if (str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE') {
    let o = 12;
    while (o + 8 <= b.length) {
      const id = str(o, 4), size = dv.getUint32(o + 4, true);
      if (id === 'fmt ') return dv.getUint32(o + 12, true);
      o += 8 + size + (size & 1);
    }
  }
  // FLAC
  if (str(0, 4) === 'fLaC' && b.length > 21) {
    return (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
  }
  // OGG (Vorbis / Opus)
  if (str(0, 4) === 'OggS') {
    const head = b.subarray(0, Math.min(b.length, 4096));
    const find = (s) => {
      outer: for (let i = 0; i < head.length - s.length; i++) {
        for (let j = 0; j < s.length; j++) if (head[i + j] !== s.charCodeAt(j)) continue outer;
        return i;
      }
      return -1;
    };
    if (find('OpusHead') >= 0) return 48000;
    const v = find('vorbis');
    if (v >= 1) return dv.getUint32(v + 11, true);
  }
  // MP3 (optional ID3v2, dann erster Frame-Sync)
  let o = 0;
  if (str(0, 3) === 'ID3') o = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
  for (let i = o; i < Math.min(b.length - 4, o + 65536); i++) {
    if (b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0) {
      const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, idx = (b[i + 2] >> 2) & 3;
      if (ver === 1 || layer === 0 || idx === 3) continue;
      const table = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
      return table[ver][idx];
    }
  }
  return null;
}

/** ArrayBuffer -> { samples: Float32Array (mono, Mittelwert der Kanaele), sampleRate, nativeKnown } */
async function decodeToMono(arrayBuffer) {
  const sniffed = sniffSampleRate(arrayBuffer);
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  let ctx;
  try { ctx = new Ctx(1, 1, sniffed || 44100); }
  catch (e) { ctx = new Ctx(1, 1, 44100); }

  const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  const ch = audioBuffer.numberOfChannels, len = audioBuffer.length;
  const samples = new Float32Array(len);
  if (ch === 1) samples.set(audioBuffer.getChannelData(0));
  else {
    for (let c = 0; c < ch; c++) {
      const d = audioBuffer.getChannelData(c);
      for (let i = 0; i < len; i++) samples[i] += d[i];
    }
    for (let i = 0; i < len; i++) samples[i] /= ch;
  }
  return {
    samples,
    sampleRate: audioBuffer.sampleRate,
    nativeKnown: !!sniffed && sniffed === audioBuffer.sampleRate
  };
}

/** Analyse im Web Worker starten. Gibt ein Promise mit dem Ergebnisobjekt zurueck. */
function runWorker(samples, sampleRate, options = {}, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('worker.js');
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.value, m.stage);
      else if (m.type === 'result') { worker.terminate(); resolve(m.result); }
      else if (m.type === 'error') { worker.terminate(); reject(new Error(m.message)); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'Worker-Fehler')); };
    worker.postMessage({ type: 'analyze', samples, sampleRate, options }, [samples.buffer]);
  });
}

/** Komfort-API: rohe Audiodaten (ArrayBuffer/Blob/File) -> Ergebnis-JSON */
async function analyzeAudioData(input, options = {}, onProgress = () => {}) {
  const buf = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
  onProgress(0, 'Dekodiere Audio');
  const { samples, sampleRate, nativeKnown } = await decodeToMono(buf);
  const result = await runWorker(samples, sampleRate, options, onProgress);
  result.meta.native_samplerate_verified = nativeKnown;
  return result;
}
window.analyzeAudioData = analyzeAudioData; // auch aus der Konsole nutzbar

// ============================================================
// UI
// ============================================================
const $ = (id) => document.getElementById(id);

function formatOutput(out) {
  const lw = Math.max(...out.zeilen.filter(([l]) => l).map(([l]) => l.length));
  let s = '---------- AUFMERKSAMKEITS-ANALYSE ----------\n\n';
  for (const [l, v] of out.zeilen) {
    if (!l) { s += '\n'; continue; }
    s += `${l.padEnd(lw)} : ${v}\n`;
  }
  s += `\n${'>>> GESAMT-AUFMERKSAMKEITSSCORE (0-100)'.padEnd(lw)} : ${out.aufmerksamkeits_score}\n`;
  s += '\n----------------------------------------------\n';
  return s;
}

function addDownload(container, name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.textContent = `⬇ ${name}`;
  a.style.display = 'block';
  container.appendChild(a);
}

$('run').addEventListener('click', async () => {
  const file = $('file').files[0];
  if (!file) { alert('Bitte zuerst eine Audio-Datei waehlen.'); return; }

  $('run').disabled = true;
  $('out').textContent = '';
  $('json').textContent = '';
  $('downloads').innerHTML = '';
  $('status').textContent = 'Starte …';
  $('bar').value = 0;

  try {
    const result = await analyzeAudioData(
      file,
      { exportJson: $('exportJson').checked },
      (v, stage) => { $('bar').value = v; $('status').textContent = `${stage} – ${Math.round(v * 100)} %`; }
    );

    $('status').textContent =
      `Fertig in ${(result.meta.elapsed_ms / 1000).toFixed(1)} s · ${result.meta.sample_rate} Hz` +
      (result.meta.native_samplerate_verified ? '' : ' (⚠ native Samplerate nicht verifiziert)');
    $('out').textContent = formatOutput(result.output);

    const { json_export, ...rest } = result;
    $('json').textContent = JSON.stringify(rest, null, 2);
    if (json_export) for (const [n, t] of Object.entries(json_export)) addDownload($('downloads'), n, t);
  } catch (err) {
    $('status').textContent = 'Fehler: ' + err.message;
  } finally {
    $('run').disabled = false;
  }
});
