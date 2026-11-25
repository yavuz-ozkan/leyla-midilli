// Makes every spoken clip for the game from audio/lines.json with ElevenLabs, then packs them into audio-pack.js.
//   node tools/make-audio.mjs --dry     count clips and characters, spend nothing
//   node tools/make-audio.mjs           make the clips that are missing, then pack
// Existing clips are kept, so it is safe to run again after adding words.
// The API key is read from elevenlabs-key.txt in the folder ABOVE this project, so it can never be committed with it.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AUDIO = path.join(ROOT, 'audio');
const cfg = JSON.parse(readFileSync(path.join(AUDIO, 'lines.json'), 'utf8'));
const dry = process.argv.includes('--dry');

// Every clip the game needs. id is also the file path under audio/ (without .mp3).
const clips = [];
for (const it of cfg.items) {
  clips.push({ id: 'word/' + it.id, voice: 'word', tts: it.tr + '.' });
  clips.push({ id: 'ask/' + it.id, voice: 'pony', tts: `[excited] ${it.tr}! ${it.tr} nerede?` });
}
for (const v of cfg.variants) for (const c of cfg.colors) {
  const phrase = `${c.tr} ${v.tr}`;
  clips.push({ id: `word/${v.id}-${c.id}`, voice: 'word', tts: phrase + '.' });
  clips.push({ id: `ask/${v.id}-${c.id}`, voice: 'pony', tts: `[excited] ${phrase}! ${phrase} nerede?` });
}
for (const r of cfg.rooms) clips.push({ id: 'word/room-' + r.id, voice: 'word', tts: r.tr + '.' });
for (const n of cfg.names) clips.push({ id: 'name/' + n.id, voice: 'pony', tts: `[excited] ${n.tts}!` });
for (const l of cfg.lines) clips.push({ id: 'line/' + l.id, voice: 'pony', tts: l.tts });

const chars = clips.reduce((a, c) => a + c.tts.length, 0);
console.log(`clips: ${clips.length}   characters to speak (tags included): ${chars}`);
if (dry) process.exit(0);

const key = readFileSync(path.join(path.dirname(ROOT), 'elevenlabs-key.txt'), 'utf8').trim();
const headers = { 'xi-api-key': key, 'Content-Type': 'application/json' };
const credits = async () => { const s = await (await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers })).json(); return s.character_limit - s.character_count; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const before = await credits();
let made = 0, kept = 0; const failed = [];
for (const c of clips) {
  const file = path.join(AUDIO, c.id + '.mp3');
  if (existsSync(file) && statSync(file).size > 1000) { kept++; continue; }
  mkdirSync(path.dirname(file), { recursive: true });
  let ok = false, err = '';
  for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${cfg.voices[c.voice].id}?output_format=${cfg.format}`, { method: 'POST', headers, body: JSON.stringify({ text: c.tts, model_id: cfg.model, language_code: 'tr' }) });
      if (!r.ok) { err = `${r.status} ${(await r.text()).slice(0, 160)}`; if (/quota|credit/i.test(err)) break; await sleep(3000 * attempt); continue; }
      writeFileSync(file, Buffer.from(await r.arrayBuffer())); ok = true;
    } catch (e) { err = String(e.message); await sleep(3000 * attempt); }
  }
  if (ok) made++; else failed.push(`${c.id}: ${err}`);
  if (failed.length >= 5) { console.log('STOPPED after 5 failures'); break; }
}

// Pack: one file the game loads in a single request. 64 kbps is 8000 bytes a second.
const data = {}, seconds = {}, odd = [];
for (const c of clips) {
  const file = path.join(AUDIO, c.id + '.mp3');
  if (!existsSync(file)) continue;
  const buf = readFileSync(file);
  data[c.id] = buf.toString('base64');
  seconds[c.id] = Math.round(buf.length / 800) / 10;
  const plain = c.tts.replace(/\[[^\]]*\]/g, '').trim();
  if (seconds[c.id] < 0.4 || seconds[c.id] > 2.5 + 0.13 * plain.length) odd.push(`${c.id} ${seconds[c.id]}s "${c.tts}"`);
}
writeFileSync(path.join(ROOT, 'audio-pack.js'), 'window.LM_AUDIO=' + JSON.stringify({ seconds, data }) + ';');
const after = await credits();
console.log(`made=${made} kept=${kept} failed=${failed.length}`);
failed.forEach((f) => console.log('  FAILED ' + f));
console.log(`credits: spent ${before - after}, left ${after}`);
console.log(`packed ${Object.keys(data).length} clips into audio-pack.js (${(statSync(path.join(ROOT, 'audio-pack.js')).size / 1e6).toFixed(1)} MB)`);
console.log(`clips with an unusual length: ${odd.length}`);
odd.forEach((o) => console.log('  ' + o));
