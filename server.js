"use strict";

const express  = require("express");
const multer   = require("multer");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const { spawn }  = require("child_process");
const Groq       = require("groq-sdk");
const { v4: uuidv4 } = require("uuid");

/* ─────────────────────── Config ─────────────────────── */
const PORT       = process.env.PORT || 3001;
const UPLOADS    = "/tmp/cs-uploads";
const OUTPUTS    = "/tmp/cs-outputs";
const MAX_MB     = 500;

/* Quality presets — mirror of frontend QUALITY_PRESETS */
const QUALITY_PRESETS = {
  "720p":  { w: 720,  h: 1280, crf: "28", preset: "ultrafast", tune: true  },
  "1080p": { w: 1080, h: 1920, crf: "23", preset: "ultrafast", tune: false },
  "4k":    { w: 2160, h: 3840, crf: "18", preset: "fast",      tune: false },
};

/* Ensure temp dirs exist */
[UPLOADS, OUTPUTS].forEach(d => fs.mkdirSync(d, { recursive: true }));

/* ─────────────────────── App ─────────────────────── */
const app = express();

/* CORS — explicit allow-list */
app.use(cors({
  origin: [
    "https://clipstudio-topaz.vercel.app",
    "https://clipstudio.com",
    "http://localhost:5173",
    "http://localhost:5174",
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));

/* Handle preflight OPTIONS for all routes */
app.options("*", cors());

app.use(express.json());

/* ─────────────────────── Multer ─────────────────────── */
const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype.startsWith("video/") ||
               [".mp4", ".mov", ".webm", ".mkv"].includes(
                 path.extname(file.originalname).toLowerCase()
               );
    cb(ok ? null : new Error("Only video files are accepted"), ok);
  },
});

/* ─────────────────────── Helpers ─────────────────────── */

/** Round to nearest even integer (FFmpeg libx264 requires even dimensions) */
const even = n => Math.round(n / 2) * 2 || 2;

/**
 * Build FFmpeg arguments for ANY layout + quality + fps + trim.
 *
 * config fields consumed here:
 *   layers, crops, videoWidth, videoHeight  — layout geometry
 *   quality      — "720p" | "1080p" | "4k"  (default "720p")
 *   fps          — 30 | 60                  (default 30)
 *   trimStart    — seconds into source to start (default 0)
 *   trimDuration — seconds to encode (default: full file)
 */
function buildFFmpegArgs(inputPath, outputPath, config) {
  const {
    layers, crops,
    videoWidth: VW, videoHeight: VH,
    quality      = "720p",
    fps          = 30,
    trimStart    = 0,
    trimDuration = null,
    assPath      = null,
  } = config;

  if (!VW || !VH) throw new Error("videoWidth / videoHeight are required");

  const q = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS["720p"];
  const OUT_W = q.w, OUT_H = q.h;

  /* Sort layers lowest-z → highest-z (highest renders on top) */
  const videoLayers = [...layers]
    .filter(l => l.type === "video" && l.source && crops[l.source])
    .sort((a, b) => (a.z ?? 1) - (b.z ?? 1));

  if (!videoLayers.length) throw new Error("No video layers in config");

  const filterParts = [];
  const streamNames = [];

  /* Base black canvas — dimensions match quality preset */
  filterParts.push(`color=c=black:s=${OUT_W}x${OUT_H}:r=${fps}[base]`);

  videoLayers.forEach((layer, idx) => {
    const crop = crops[layer.source];

    /* Source crop in pixels */
    const cx = Math.max(0, Math.round(crop.x / 100 * VW));
    const cy = Math.max(0, Math.round(crop.y / 100 * VH));
    const cw = Math.max(2, Math.min(Math.round(crop.w / 100 * VW), VW - cx));
    const ch = Math.max(2, Math.min(Math.round(crop.h / 100 * VH), VH - cy));

    /* Layer destination in output frame pixels (must be even for libx264) */
    const lx = Math.round(layer.x / 100 * OUT_W);
    const ly = Math.round(layer.y / 100 * OUT_H);
    const lw = even(layer.w / 100 * OUT_W);
    const lh = even(layer.h / 100 * OUT_H);

    /* Object-fit: cover — scale to fill, crop excess */
    const cropAR  = cw / ch;
    const layerAR = lw / lh;
    let scaleW, scaleH, padX = 0, padY = 0;
    if (cropAR > layerAR) {
      scaleH = lh; scaleW = Math.round(lh * cropAR); padX = Math.round((scaleW - lw) / 2);
    } else {
      scaleW = lw; scaleH = Math.round(lw / cropAR); padY = Math.round((scaleH - lh) / 2);
    }
    scaleW = even(scaleW); scaleH = even(scaleH);

    const sn = `v${idx}`;
    filterParts.push(
      `[0:v]crop=${cw}:${ch}:${cx}:${cy},` +
      `scale=${scaleW}:${scaleH},` +
      `crop=${lw}:${lh}:${padX}:${padY}[${sn}]`
    );
    streamNames.push({ name: sn, x: lx, y: ly });
  });

  /* Chain overlay filters */
  streamNames.forEach(({ name, x, y }, i) => {
    const inA  = i === 0 ? "[base]" : `[tmp${i - 1}]`;
    const outL = i === streamNames.length - 1 ? "[vout]" : `[tmp${i}]`;
    filterParts.push(`${inA}[${name}]overlay=${x}:${y}${outL}`);
  });

  /* Burn subtitles into the video stream when an ASS file is provided */
  const finalStream = assPath ? "[final]" : "[vout]";
  if (assPath) {
    /* Escape backslashes and colons in the path for FFmpeg filter syntax */
    const escaped = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
    filterParts.push(`[vout]ass='${escaped}'[final]`);
  }

  /* Input-side seek: -ss and -t MUST come before -i for fast keyframe seek.
     Always emit -ss (even when 0) so FFmpeg knows the segment is intentional. */
  const isTrimmed = trimDuration != null;
  const seekArgs  = isTrimmed
    ? ["-ss", trimStart.toFixed(3), "-t", trimDuration.toFixed(3)]
    : [];

  /* Output-side -t is a second hard stop — guarantees FFmpeg won't drift
     past the trim window due to GOP alignment or filter buffering. */
  const outTrimArgs = isTrimmed ? ["-t", trimDuration.toFixed(3)] : [];

  const cmd = [
    ...seekArgs,
    "-i", inputPath,
    "-filter_complex", filterParts.join(";\n"),
    "-map", finalStream,
    "-map", "0:a?",            // keep audio if present
    "-r",  String(fps),
    "-c:v", "libx264",
    "-crf",    q.crf,
    "-preset", q.preset,
    ...(q.tune ? ["-tune", "zerolatency"] : []),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    ...outTrimArgs,            // second -t on output side
    "-y",
    outputPath,
  ];

  console.log(`[export] quality=${quality} fps=${fps} trim=${trimStart.toFixed(2)}s + ${trimDuration != null ? trimDuration.toFixed(2)+"s" : "full"} → ${OUT_W}x${OUT_H}`);
  console.log(`[cmd]   ffmpeg ${cmd.join(" ")}`);
  return cmd;
}

/**
 * Run FFmpeg via spawn so stderr streams live to Railway logs.
 * Rejects if FFmpeg exits non-zero or exceeds TIMEOUT_MS.
 */
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max per export

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    /* ── Full command log — visible immediately in Railway logs ── */
    console.log("\n[FFmpeg] Starting process");
    console.log("[FFmpeg] cmd: ffmpeg", args.join(" "), "\n");

    /* Ensure output directory exists right before we need it */
    fs.mkdirSync(OUTPUTS, { recursive: true });

    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });

    let stderrBuf = "";

    /* Stream stderr live — shows codec init, frame progress, errors */
    ff.stderr.on("data", chunk => {
      const txt = chunk.toString();
      stderrBuf += txt;
      /* Only print lines that carry useful info; skip blank lines */
      txt.split("\n").forEach(line => {
        if (line.trim()) console.log("[FFmpeg]", line);
      });
    });

    /* Hard timeout — kills FFmpeg if it stalls completely */
    const timer = setTimeout(() => {
      console.error("[FFmpeg] TIMEOUT — killing process");
      ff.kill("SIGKILL");
      reject(new Error("FFmpeg timed out after 10 minutes"));
    }, TIMEOUT_MS);

    ff.on("error", err => {
      clearTimeout(timer);
      console.error("[FFmpeg] spawn error:", err.message);
      reject(new Error(`FFmpeg spawn failed: ${err.message}`));
    });

    ff.on("close", code => {
      clearTimeout(timer);
      if (code === 0) {
        console.log("[FFmpeg] Finished successfully");
        resolve();
      } else {
        const tail = stderrBuf.slice(-800);
        console.error(`[FFmpeg] Exited with code ${code}\n${tail}`);
        reject(new Error(`FFmpeg exited ${code}: ${tail.slice(-300)}`));
      }
    });
  });
}

/** Delete a file silently (ignore errors) */
const cleanup = f => f && fs.unlink(f, () => {});

/**
 * Extract a 16 kHz mono MP3 from the video — optimal for Whisper.
 * trimStart / trimDuration narrow the audio to only the segment being exported.
 */
function extractAudio(inputPath, audioPath, trimStart = 0, trimDuration = null) {
  return new Promise((resolve, reject) => {
    const seekArgs = [];
    if (trimStart    >  0.01) seekArgs.push("-ss", String(trimStart));
    if (trimDuration != null) seekArgs.push("-t",  String(trimDuration));

    const ff = spawn("ffmpeg", [
      ...seekArgs,
      "-i",  inputPath,
      "-vn",             // strip video
      "-ar", "16000",    // 16 kHz — Whisper optimal
      "-ac", "1",        // mono
      "-f",  "mp3",
      "-y",  audioPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });

    let errBuf = "";
    ff.stderr.on("data", d => { errBuf += d.toString(); });
    ff.on("error", reject);
    ff.on("close", code =>
      code === 0 ? resolve() : reject(new Error(`Audio extract failed (${code}): ${errBuf.slice(-200)}`))
    );
  });
}

/**
 * Convert a Whisper segments array into an ASS subtitle file.
 * timeOffset = trimStart so timestamps are relative to the clip start.
 * PlayRes matches the quality-preset output resolution.
 */
function generateASS(segments, assPath, timeOffset = 0, outW = 720, outH = 1280) {
  const toT = sec => {
    const t  = Math.max(0, sec - timeOffset);
    const h  = Math.floor(t / 3600);
    const m  = Math.floor((t % 3600) / 60);
    const s  = Math.floor(t % 60);
    const cs = Math.round((t % 1) * 100);
    return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(cs).padStart(2,"0")}`;
  };

  /* Font size scales with output height — 72px at 1280px tall (720p) */
  const fontSize = Math.round(72 * (outH / 1280));

  const header = [
    "[Script Info]",
    "Title: ClipStudio Subtitles",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    `PlayResX: ${outW}`,
    `PlayResY: ${outH}`,
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    /* PrimaryColour=white, OutlineColour=black, Bold, Alignment=2 (bottom-center), MarginV=80 */
    `Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,20,20,80,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const events = segments
    .filter(s => s.text?.trim())
    .map(s => `Dialogue: 0,${toT(s.start)},${toT(s.end)},Default,,0,0,0,,${s.text.trim().replace(/\n/g, "\\N")}`)
    .join("\n");

  fs.writeFileSync(assPath, header + "\n" + events + "\n", "utf8");
  console.log(`[ASS] written ${segments.length} segments → ${assPath}`);
}

/* ─────────────────────── Routes ─────────────────────── */

app.get("/health", (_req, res) =>
  res.json({ status: "ok", version: "1.2.0", ffmpeg: true, whisper: !!process.env.GROQ_API_KEY })
);

/**
 * POST /api/transcribe
 * Body: multipart/form-data  { video: file, trimStart?: number, trimDuration?: number }
 * Returns: { segments: [{ start, end, text }] }
 */
app.post("/api/transcribe", upload.single("video"), async (req, res) => {
  const inputPath = req.file?.path;
  const audioPath = path.join(UPLOADS, `${uuidv4()}.mp3`);

  try {
    if (!req.file) return res.status(400).json({ error: "No video file received" });

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        error: "GROQ_API_KEY is not set on the server. Add it in Railway → Variables.",
      });
    }

    const trimStart    = Number(req.body.trimStart)    || 0;
    const trimDuration = req.body.trimDuration != null ? Number(req.body.trimDuration) : null;

    console.log(`[transcribe] file=${(req.file.size/1024/1024).toFixed(1)}MB trim=${trimStart}s+${trimDuration??'full'}s`);

    /* ── 1. Extract audio ── */
    await extractAudio(inputPath, audioPath, trimStart, trimDuration);

    /* ── 2. Send to Whisper ── */
    const groq   = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const result = await groq.audio.transcriptions.create({
      file:                    fs.createReadStream(audioPath),
      model:                   "whisper-large-v3",
      response_format:         "verbose_json",
      timestamp_granularities: ["segment", "word"],
      /* Anti-hallucination: restrict language + give context so Whisper
         doesn't invent words during silent/music sections */
      language: req.body.language || "nl",
      prompt:   "Gaming commentary, FIFA FC game footage. Exact speech only, no filler.",
    });

    cleanup(audioPath);
    cleanup(inputPath);

    /* ── Raw response inspection ── */
    console.log("[RAW groq]",         JSON.stringify(result).slice(0, 500));
    console.log("[words top level]",  result.words?.slice(0, 3));
    console.log("[segment0 words]",   result.segments?.[0]?.words?.slice(0, 3));

    /* Evenly distribute word timestamps when Groq returns no word data */
    const fakeWords = s => {
      const tokens = s.text.trim().split(/\s+/);
      const dur    = s.end - s.start;
      return tokens.map((word, i) => ({
        word,
        start: parseFloat((s.start + (dur / tokens.length) * i      ).toFixed(3)),
        end:   parseFloat((s.start + (dur / tokens.length) * (i + 1)).toFixed(3)),
      }));
    };

    const topLevelWords = result.words ?? [];

    const segments = (result.segments ?? []).map(s => {
      const raw = (s.words?.length > 0 ? s.words : null)
        ?? topLevelWords.filter(w => w.start >= s.start && w.start < s.end);

      const mapped = raw.map(w => ({
        word:  (w.word ?? w.text ?? "").trim(),
        start: parseFloat(w.start.toFixed(3)),
        end:   parseFloat((w.end ?? w.start + 0.1).toFixed(3)),
      }));

      const seg = {
        start: parseFloat(s.start.toFixed(3)),
        end:   parseFloat(s.end.toFixed(3)),
        text:  s.text.trim(),
        words: mapped.length > 0 ? mapped : fakeWords({
          text:  s.text.trim(),
          start: parseFloat(s.start.toFixed(3)),
          end:   parseFloat(s.end.toFixed(3)),
        }),
      };
      return seg;
    });

    console.log(`[transcribe] got ${segments.length} segments`);
    console.log("[words sample]", segments[0]?.words?.slice(0, 3));
    res.json({ segments });

  } catch (err) {
    cleanup(audioPath);
    cleanup(inputPath);
    console.error("[transcribe] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/export
 * Body: multipart/form-data
 *   video  — the source MP4 file
 *   config — JSON string with { layers, crops, videoWidth, videoHeight }
 *
 * Returns: video/mp4 file download
 */
app.post("/api/export", upload.single("video"), async (req, res) => {
  const inputPath  = req.file?.path;
  const outputPath = path.join(OUTPUTS, `${uuidv4()}.mp4`);

  try {
    /* ── Validate inputs ── */
    if (!req.file) {
      return res.status(400).json({ error: "No video file received" });
    }

    let config;
    try {
      config = JSON.parse(req.body.config ?? "{}");
    } catch {
      return res.status(400).json({ error: "config field must be valid JSON" });
    }

    const { layers, crops, videoWidth, videoHeight } = config;
    if (!layers?.length || !crops || !videoWidth || !videoHeight) {
      return res.status(400).json({
        error: "config must include: layers[], crops{}, videoWidth, videoHeight",
      });
    }

    /* Explicitly extract + default trim values so nothing silently drops */
    const trimStart    = Number(config.trimStart)    || 0;
    const trimDuration = config.trimDuration != null ? Number(config.trimDuration) : null;

    const subtitles = Array.isArray(config.subtitles) ? config.subtitles : [];

    console.log(`[route] file=${(req.file.size/1024/1024).toFixed(1)}MB quality=${config.quality??'720p'} fps=${config.fps??30}`);
    console.log(`[trim] trimStart=${trimStart}s  trimDuration=${trimDuration ?? "full video"}s`);
    console.log(`[subs] ${subtitles.length} subtitle segment(s)`);

    /* ── Generate ASS subtitle file if segments are provided ── */
    let assPath = null;
    if (subtitles.length > 0) {
      const q = QUALITY_PRESETS[config.quality ?? "720p"] ?? QUALITY_PRESETS["720p"];
      assPath = path.join(OUTPUTS, `${uuidv4()}.ass`);
      generateASS(subtitles, assPath, trimStart, q.w, q.h);
    }

    /* ── Build + run FFmpeg ── */
    const ffmpegArgs = buildFFmpegArgs(inputPath, outputPath, {
      ...config,
      trimStart,
      trimDuration,
      assPath,
    });
    await runFFmpeg(ffmpegArgs);

    /* ── Stream output to client ── */
    const stat = fs.statSync(outputPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="tiktok-clip.mp4"');
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("end",   () => { cleanup(inputPath); cleanup(outputPath); cleanup(assPath); });
    stream.on("error", () => { cleanup(inputPath); cleanup(outputPath); cleanup(assPath); });

  } catch (err) {
    cleanup(inputPath);
    cleanup(outputPath);
    cleanup(assPath);
    console.error("Export error:", err.message);

    const isClientError = err.message.includes("No video") ||
                          err.message.includes("config must");
    res.status(isClientError ? 400 : 500).json({ error: err.message });
  }
});

/* ─────────────────────── Multer error handler ─────────────────────── */
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `File too large (max ${MAX_MB} MB)` });
  }
  res.status(500).json({ error: err.message || "Unexpected server error" });
});

/* ─────────────────────── Start ─────────────────────── */
app.listen(PORT, () =>
  console.log(`ClipStudio backend listening on port ${PORT}`)
);
