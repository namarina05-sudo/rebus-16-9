const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const upload = multer({ dest: os.tmpdir() });

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

const W = 900;
const H = 1600;
const FPS = 30;

const GREEN = '0x1E7A1E';
const DIGIT_COLOR = '0xD00000';
const BORDER = 'white';

const IMG = 300;
const DIGIT_FONT = 110;
const ANSWER_FONT = 90;

const COL1_CX = 300;
const COL2_CX = 600;
const ROW1_CY = 451;
const ROW2_CY = 751;
const ANSWER_CY = 1000;

const OVERLAY_NAMES = ['topleft', 'item', 'transport', 'nizpravo'];

app.get('/health', (req, res) => res.json({ ok: true }));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, '\u2019')
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, ' ');
}

function layoutRow(cut) {
  const isPrefix = String(cut).toLowerCase() === 'prefix';
  if (isPrefix) return { imgCX: COL1_CX, digitCX: COL2_CX };
  return { imgCX: COL2_CX, digitCX: COL1_CX };
}

function digitDraw({ text, digitCX, rowCY, appear }) {
  return [
    'drawtext=fontfile=' + FONT,
    "text='" + esc(text) + "'",
    'fontsize=' + DIGIT_FONT,
    'fontcolor=' + DIGIT_COLOR,
    'borderw=4',
    'bordercolor=' + BORDER,
    'x=(' + digitCX + '-text_w/2)',
    'y=(' + rowCY + '-text_h/2)',
    "enable='gte(t," + appear + ")'",
  ].join(':');
}

function answerDraw({ text, cy, appear }) {
  return [
    'drawtext=fontfile=' + FONT,
    "text='" + esc(text) + "'",
    'fontsize=' + ANSWER_FONT,
    'fontcolor=' + GREEN,
    'borderw=4',
    'bordercolor=' + BORDER,
    'x=(w-text_w)/2',
    'y=(' + cy + '-text_h/2)',
    "enable='gte(t," + appear + ")'",
  ].join(':');
}

app.post(
  '/render',
  upload.fields([
    { name: 'fon', maxCount: 1 },
    { name: 'img1', maxCount: 1 },
    { name: 'img2', maxCount: 1 },
    { name: 'topleft', maxCount: 1 },
    { name: 'item', maxCount: 1 },
    { name: 'transport', maxCount: 1 },
    { name: 'nizpravo', maxCount: 1 },
  ]),
  (req, res) => {
    let payload = {};
    try { payload = JSON.parse(req.body.payload || '{}'); }
    catch (e) { return res.status(400).json({ error: 'BAD_PAYLOAD', detail: String(e) }); }

    const f = req.files || {};
    for (const k of ['fon', 'img1', 'img2']) {
      if (!f[k] || !f[k][0]) return res.status(400).json({ error: 'MISSING_FILE', field: k });
    }

    const t = payload.timings || {};
    const start = Number(t.start != null ? t.start : 2);
    const step = Number(t.step != null ? t.step : 0.3);
    const answerReveal = Number(t.answer_reveal != null ? t.answer_reveal : 13.2);
    const duration = Number(t.duration != null ? t.duration : (payload.duration || 15));

    const answer = payload.answer || '';
    const digit1 = payload.digit1 != null ? String(payload.digit1) : '';
    const digit2 = payload.digit2 != null ? String(payload.digit2) : '';
    const cut1 = payload.cut1 || 'prefix';
    const cut2 = payload.cut2 || 'suffix';

    const r1 = layoutRow(cut1);
    const r2 = layoutRow(cut2);

    const tImg1 = start;
    const tDig1 = start + step;
    const tImg2 = start + 2 * step;
    const tDig2 = start + 3 * step;

    const outPath = path.join(os.tmpdir(), 'out_' + Date.now() + '.mp4');

    const args = ['-y'];
    args.push('-stream_loop', '-1', '-i', f.fon[0].path);
    args.push('-loop', '1', '-i', f.img1[0].path);
    args.push('-loop', '1', '-i', f.img2[0].path);
    let idx = 3;
    const overlayInputs = [];
    for (const nm of OVERLAY_NAMES) {
      if (f[nm] && f[nm][0]) { args.push('-loop', '1', '-i', f[nm][0].path); overlayInputs.push({ nm, idx }); idx++; }
    }

    const segs = [];
    segs.push('[0:v]scale=' + W + ':' + H + ',setsar=1,fps=' + FPS + '[bg]');
    let last = 'bg';

    overlayInputs.forEach((ov, i) => {
      const sc = 'fr' + i;
      segs.push('[' + ov.idx + ':v]scale=' + W + ':' + H + '[' + sc + ']');
      const out = 'ov' + i;
      segs.push('[' + last + '][' + sc + ']overlay=0:0[' + out + ']');
      last = out;
    });

    segs.push('[1:v]scale=' + IMG + ':' + IMG + '[p1]');
    segs.push('[2:v]scale=' + IMG + ':' + IMG + '[p2]');
    segs.push('[' + last + '][p1]overlay=x=' + (r1.imgCX - IMG / 2) + ':y=' + (ROW1_CY - IMG / 2) +
              ":enable='gte(t," + tImg1 + ")'[o1]");
    segs.push('[o1][p2]overlay=x=' + (r2.imgCX - IMG / 2) + ':y=' + (ROW2_CY - IMG / 2) +
              ":enable='gte(t," + tImg2 + ")'[o2]");
    last = 'o2';

    const draws = [];
    if (digit1) draws.push(digitDraw({ text: digit1, digitCX: r1.digitCX, rowCY: ROW1_CY, appear: tDig1 }));
    if (digit2) draws.push(digitDraw({ text: digit2, digitCX: r2.digitCX, rowCY: ROW2_CY, appear: tDig2 }));
    if (answer) draws.push(answerDraw({ text: answer, cy: ANSWER_CY, appear: answerReveal }));

    let prev = last;
    draws.forEach((d, i2) => {
      const out = 'd' + i2;
      segs.push('[' + prev + ']' + d + '[' + out + ']');
      prev = out;
    });
    if (draws.length === 0) {
      segs.push('[' + last + ']null[vout]');
    } else {
      segs[segs.length - 1] = segs[segs.length - 1].replace('[' + prev + ']', '[vout]');
    }

    const filterComplex = segs.join(';');

    args.push(
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-map', '0:a?',
      '-t', String(duration),
      '-r', String(FPS),
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-threads', '2',
      '-filter_complex_threads', '1',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      outPath
    );

    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });

    ff.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(outPath)) {
        console.error('FFMPEG FAILED code=' + code);
        console.error(stderr);
        return res.status(500).json({ error: 'FFMPEG_FAILED', exitCode: code, stderr: stderr.slice(-4000) });
      }
      res.setHeader('Content-Type', 'video/mp4');
      const stream = fs.createReadStream(outPath);
      stream.pipe(res);
      stream.on('close', () => { try { fs.unlinkSync(outPath); } catch (e) {} });
    });

    ff.on('error', (err) => {
      console.error('SPAWN ERROR', err);
      res.status(500).json({ error: 'SPAWN_ERROR', detail: String(err) });
    });
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Render server on ' + PORT));
