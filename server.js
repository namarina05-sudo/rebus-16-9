/**
 * REBUS render server — 1600x900 (16:9 landscape)
 *
 * Expects a multipart/form-data POST to /render with:
 *   - fon   : background video (looped to fill duration)   [file]
 *   - img1  : first rebus picture (PNG/JPG)                [file]
 *   - img2  : second rebus picture (PNG/JPG)               [file]
 *   - payload : JSON string with:
 *       {
 *         "answer":  "tend",
 *         "digit1":  8,            // how many letters to cross out of picture 1
 *         "digit2":  8,            // how many letters to cross out of picture 2
 *         "cut1":    "prefix",     // which side to cross out: "prefix" (front) | "suffix" (back)
 *         "cut2":    "prefix",
 *         "timings": { "start": 2, "step": 0.3, "answer_reveal": 13.2, "duration": 15 }
 *       }
 *
 * Returns: the rendered mp4 (video/mp4) in the response body.
 *
 * NOTE: layout coordinates below are a first pass for 16:9 — tweak the
 * CONSTANTS block to taste; nothing else needs to change.
 */
const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
const upload = multer({ dest: os.tmpdir() });

// ---- CONSTANTS (16:9 layout) -------------------------------------------------
const W = 1600;
const H = 900;
const IMG = 300;                 // rebus picture size (square)
const IMG_Y = 210;               // top of both pictures
const LEFT_CX = 520;             // centre X of picture 1
const RIGHT_CX = 1080;           // centre X of picture 2
const CAPTION_Y = 540;           // "cut first/last N" caption row
const ANSWER_Y = 700;            // answer row (bottom)
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
// -----------------------------------------------------------------------------

function esc(t) {
  // escape text for ffmpeg drawtext
  return String(t == null ? '' : t)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

function captionFor(cut, digit) {
  const n = Number(digit) || 0;
  const side = String(cut).toLowerCase() === 'suffix' ? 'last' : 'first';
  return `cut ${side} ${n}`;
}

function buildFilter(p) {
  const t = p.timings || {};
  const start = Number(t.start) || 2;
  const step = Number(t.step) || 0.3;
  const reveal = Number(t.answer_reveal) || 13.2;
  const dur = Number(t.duration) || 15;

  const i1x = LEFT_CX - IMG / 2;
  const i2x = RIGHT_CX - IMG / 2;

  const cap1 = esc(captionFor(p.cut1, p.digit1));
  const cap2 = esc(captionFor(p.cut2, p.digit2));
  const answer = esc(String(p.answer || '').toUpperCase());

  const parts = [];
  // background: cover 1600x900, loop handled by -stream_loop on input
  parts.push(`[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[bg]`);
  parts.push(`[1:v]scale=${IMG}:${IMG}[i1]`);
  parts.push(`[2:v]scale=${IMG}:${IMG}[i2]`);
  // place pictures (staggered appearance)
  parts.push(`[bg][i1]overlay=${i1x}:${IMG_Y}:enable='gte(t,${start})'[b1]`);
  parts.push(`[b1][i2]overlay=${i2x}:${IMG_Y}:enable='gte(t,${(start + step).toFixed(2)})'[b2]`);
  // plus sign between the pictures
  parts.push(`[b2]drawtext=fontfile=${FONT}:text='+':fontsize=130:fontcolor=white:borderw=6:bordercolor=black:x=(w-text_w)/2:y=${IMG_Y + IMG / 2 - 75}:enable='gte(t,${start})'[b3]`);
  // captions under each picture
  parts.push(`[b3]drawtext=fontfile=${FONT}:text='${cap1}':fontsize=48:fontcolor=yellow:borderw=5:bordercolor=black:x=${LEFT_CX}-text_w/2:y=${CAPTION_Y}:enable='gte(t,${start})'[b4]`);
  parts.push(`[b4]drawtext=fontfile=${FONT}:text='${cap2}':fontsize=48:fontcolor=yellow:borderw=5:bordercolor=black:x=${RIGHT_CX}-text_w/2:y=${CAPTION_Y}:enable='gte(t,${(start + step).toFixed(2)})'[b5]`);
  // "= ?" before reveal, then the answer after reveal
  parts.push(`[b5]drawtext=fontfile=${FONT}:text='\\?':fontsize=110:fontcolor=white:borderw=6:bordercolor=black:x=(w-text_w)/2:y=${ANSWER_Y}:enable='between(t,${start},${reveal})'[b6]`);
  parts.push(`[b6]drawtext=fontfile=${FONT}:text='${answer}':fontsize=120:fontcolor=#00e676:borderw=8:bordercolor=black:x=(w-text_w)/2:y=${ANSWER_Y}:enable='gte(t,${reveal})'[vout]`);

  return { filter: parts.join(';'), dur };
}

app.get('/', (_req, res) => res.send('rebus render 1600x900 ok'));
app.get('/health', (_req, res) => res.json({ ok: true, w: W, h: H }));

app.post(
  '/render',
  upload.fields([
    { name: 'fon', maxCount: 1 },
    { name: 'img1', maxCount: 1 },
    { name: 'img2', maxCount: 1 },
  ]),
  (req, res) => {
    const files = req.files || {};
    const fon = files.fon && files.fon[0];
    const img1 = files.img1 && files.img1[0];
    const img2 = files.img2 && files.img2[0];

    if (!fon || !img1 || !img2) {
      return res.status(400).json({
        error: 'missing files',
        need: ['fon', 'img1', 'img2'],
        got: Object.keys(files),
      });
    }

    let payload = {};
    try {
      payload = req.body && req.body.payload ? JSON.parse(req.body.payload) : {};
    } catch (e) {
      return res.status(400).json({ error: 'bad payload json', detail: String(e) });
    }

    const { filter, dur } = buildFilter(payload);
    const out = path.join(os.tmpdir(), `rebus_${crypto.randomBytes(6).toString('hex')}.mp4`);

    const args = [
      '-y',
      '-stream_loop', '-1', '-i', fon.path, // looped background
      '-i', img1.path,
      '-i', img2.path,
      '-filter_complex', filter,
      '-map', '[vout]',
      '-t', String(dur),
      '-r', '30',
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-movflags', '+faststart',
      out,
    ];

    const ff = spawn('ffmpeg', args);
    let err = '';
    ff.stderr.on('data', (d) => { err += d.toString(); });

    ff.on('close', (code) => {
      const cleanup = () => {
        [fon.path, img1.path, img2.path, out].forEach((f) => {
          try { fs.unlinkSync(f); } catch (_) {}
        });
      };
      if (code !== 0 || !fs.existsSync(out)) {
        cleanup();
        return res.status(500).json({ error: 'ffmpeg failed', code, log: err.slice(-4000) });
      }
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="rebus_${(payload.answer || 'out')}.mp4"`);
      const stream = fs.createReadStream(out);
      stream.pipe(res);
      stream.on('close', cleanup);
    });
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`rebus render (1600x900) listening on ${PORT}`));
