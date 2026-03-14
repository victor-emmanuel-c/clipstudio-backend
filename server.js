"use strict";

const express  = require("express");
const multer   = require("multer");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const { execFile } = require("child_process");
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

/* CORS — allow the Vercel frontend + localhost dev */
app.use(cors({
  origin: (origin, cb) => {
    const allowed = [
      /\.vercel\.app$/,
      /^http:\/\/localhost:\d+$/,
      /^http:\/\/127\.0\.0\.1:\d+$/,
    ];
    if (!origin || allowed.some(r => r.test(origin))) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));

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
    const outL = i === streamNames.length - 1 ? "[out]" : `[tmp${i}]`;
    filterParts.push(`${inA}[${name}]overlay=${x}:${y}${outL}`);
  });

  /* -ss / -t BEFORE -i = fast input-side seek (only reads selected segment) */
  const seekArgs = [];
  if (trimStart    >  0.01) seekArgs.push("-ss", trimStart.toFixed(3));
  if (trimDuration != null) seekArgs.push("-t",  trimDuration.toFixed(3));

  const cmd = [
    ...seekArgs,
    "-i", inputPath,
    "-filter_complex", filterParts.join(";\n"),
    "-map", "[out]",
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
    "-y",
    outputPath,
  ];

  console.log(`[export] quality=${quality} fps=${fps} trim=${trimStart.toFixed(1)}s+${(trimDuration??0).toFixed(1)}s out=${OUT_W}x${OUT_H}`);
  return cmd;
}

/** Run FFmpeg and return a promise; logs stderr on failure */
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log("FFmpeg args:", args.join(" "));
    execFile("ffmpeg", args, { maxBuffer: 200 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        console.error("FFmpeg stderr (last 2 KB):\n", stderr.slice(-2048));
        reject(new Error(`FFmpeg failed: ${stderr.slice(-400)}`));
      } else {
        resolve();
      }
    });
  });
}

/** Delete a file silently (ignore errors) */
const cleanup = f => f && fs.unlink(f, () => {});

/* ─────────────────────── Routes ─────────────────────── */

app.get("/health", (_req, res) =>
  res.json({ status: "ok", version: "1.0.0", ffmpeg: true })
);

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

    /* quality / fps / trim are optional — buildFFmpegArgs has safe defaults */
    console.log(`[route] file=${(req.file.size/1024/1024).toFixed(1)}MB quality=${config.quality??'720p'} fps=${config.fps??30}`);

    /* ── Build + run FFmpeg ── */
    const ffmpegArgs = buildFFmpegArgs(inputPath, outputPath, config);
    await runFFmpeg(ffmpegArgs);

    /* ── Stream output to client ── */
    const stat = fs.statSync(outputPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="tiktok-clip.mp4"');
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("end",   () => { cleanup(inputPath); cleanup(outputPath); });
    stream.on("error", () => { cleanup(inputPath); cleanup(outputPath); });

  } catch (err) {
    cleanup(inputPath);
    cleanup(outputPath);
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
