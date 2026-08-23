'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseJsonStrict } = require('./strict-json');
const {
  PreparationError,
  buildPreparedPlan,
  canonicalDigest,
} = require('./prepared-plan');

const RENDERER_ID = 'chipk-prepared-mobile-clip';
const RENDERER_VERSION = 1;

function fail(code, message, details) {
  throw new PreparationError(code, message, details);
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath, fsImpl = fs) {
  return sha256Buffer(fsImpl.readFileSync(filePath));
}

function requireRegularFile(filePath, label, fsImpl = fs) {
  const resolved = path.resolve(filePath || '');
  let metadata;
  try {
    metadata = fsImpl.lstatSync(resolved);
  } catch {
    fail('missing_preparation_input', `${label} 不存在`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    fail('invalid_preparation_input', `${label} 必須是非空 regular file`);
  }
  return resolved;
}

function readJsonFile(filePath, label, fsImpl = fs) {
  const resolved = requireRegularFile(filePath, label, fsImpl);
  try {
    return { resolved, value: parseJsonStrict(fsImpl.readFileSync(resolved, 'utf8'), label, 'invalid_preparation_input') };
  } catch (error) {
    if (error instanceof PreparationError) throw error;
    fail('invalid_preparation_input', `${label} 不是有效 JSON`);
  }
}

function parseRate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  if (value.includes('/')) {
    const [numerator, denominator] = value.split('/').map(Number);
    return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
      ? numerator / denominator
      : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeProbe(payload) {
  if (payload && Number.isFinite(Number(payload.durationSeconds))) {
    return {
      codec: String(payload.codec || ''),
      width: Number(payload.width),
      height: Number(payload.height),
      durationSeconds: Number(payload.durationSeconds),
      fps: parseRate(payload.fps),
    };
  }
  const stream = payload?.streams?.find((item) => item.codec_type === 'video') || payload?.streams?.[0];
  if (!stream) fail('video_probe_invalid', 'ffprobe 沒有回傳 video stream');
  return {
    codec: String(stream.codec_name || ''),
    width: Number(stream.width),
    height: Number(stream.height),
    durationSeconds: Number(stream.duration ?? payload?.format?.duration),
    fps: parseRate(stream.avg_frame_rate || stream.r_frame_rate),
  };
}

function defaultExec(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function probeVideo(videoPath, exec = defaultExec) {
  let output;
  try {
    output = exec('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,codec_type,width,height,avg_frame_rate,duration:format=duration',
      '-of', 'json',
      videoPath,
    ]);
  } catch {
    fail('video_probe_failed', 'ffprobe 無法驗證 video');
  }
  try {
    return normalizeProbe(JSON.parse(output));
  } catch (error) {
    if (error instanceof PreparationError) throw error;
    fail('video_probe_invalid', 'ffprobe 回傳無效 JSON');
  }
}

function number(value) {
  return Number(value.toFixed(6)).toString();
}

function cameraExpression(keyframes, key, fps) {
  const byFrame = [];
  for (const keyframe of keyframes) {
    const atFrame = Math.max(0, Math.round((keyframe.atMs / 1000) * fps));
    const item = { atFrame, value: keyframe[key] };
    if (byFrame.at(-1)?.atFrame === atFrame) byFrame[byFrame.length - 1] = item;
    else byFrame.push(item);
  }
  let expression = number(byFrame.at(-1).value);
  for (let index = byFrame.length - 2; index >= 0; index -= 1) {
    const start = byFrame[index];
    const end = byFrame[index + 1];
    const span = end.atFrame - start.atFrame;
    if (span <= 0) continue;
    const progress = `(on-${start.atFrame})/${span}`;
    const eased = `(0.5-0.5*cos(PI*${progress}))`;
    const segment = `${number(start.value)}+(${number(end.value - start.value)})*${eased}`;
    expression = `if(lte(on,${end.atFrame}),${segment},${expression})`;
  }
  return expression;
}

function seconds(ms) {
  return number(ms / 1000);
}

function clampedBox(center, size, limit) {
  return Math.round(Math.min(limit - size, Math.max(0, center - size / 2)));
}

function boxFilter({ x, y, size, color, alpha, thickness, startMs, endMs }) {
  return [
    `drawbox=x=${x}`,
    `y=${y}`,
    `w=${size}`,
    `h=${size}`,
    `color=${color}@${alpha}`,
    `t=${thickness}`,
    `enable='between(t,${seconds(startMs)},${seconds(endMs)})'`,
  ].join(':');
}

function buildFfmpegFilter(plan, profile) {
  const { width, height, fps } = plan.output;
  const keyframes = plan.presentation.camera.keyframes;
  const zoom = cameraExpression(keyframes, 'zoom', fps);
  const centerX = cameraExpression(keyframes, 'centerX', fps);
  const centerY = cameraExpression(keyframes, 'centerY', fps);
  const filters = [
    `fps=${number(fps)}`,
    [
      `zoompan=z='${zoom}'`,
      `x='max(0,min(iw-iw/zoom,iw*(${centerX})-iw/zoom/2))'`,
      `y='max(0,min(ih-ih/zoom,ih*(${centerY})-ih/zoom/2))'`,
      'd=1',
      `s=${width}x${height}`,
      `fps=${number(fps)}`,
    ].join(':'),
    'format=yuv420p',
  ];
  const markerSize = Math.max(8, Math.round(width * profile.emphasis.markerSizeRatio / 2) * 2);
  const thickness = Math.max(3, Math.round(markerSize * 0.18));
  const color = profile.emphasis.color;

  for (const interaction of plan.presentation.interactions) {
    if (interaction.kind === 'tap') {
      const centerPx = {
        x: interaction.screenPoint.x * width,
        y: interaction.screenPoint.y * height,
      };
      const phases = [
        { scale: 1, start: 0, end: 0.45, alpha: 0.9 },
        { scale: 1.7, start: 0.2, end: 0.72, alpha: 0.7 },
        { scale: 2.4, start: 0.42, end: 1, alpha: 0.45 },
      ];
      const total = interaction.emphasisEndOffsetMs - interaction.timing.startedOffsetMs;
      for (const phase of phases) {
        const size = Math.round(markerSize * phase.scale / 2) * 2;
        filters.push(boxFilter({
          x: clampedBox(centerPx.x, size, width),
          y: clampedBox(centerPx.y, size, height),
          size,
          color,
          alpha: phase.alpha,
          thickness,
          startMs: interaction.timing.startedOffsetMs + total * phase.start,
          endMs: interaction.timing.startedOffsetMs + total * phase.end,
        }));
      }
    }
    if (interaction.kind === 'long_press') {
      const size = markerSize * 2;
      filters.push(boxFilter({
        x: clampedBox(interaction.screenPoint.x * width, size, width),
        y: clampedBox(interaction.screenPoint.y * height, size, height),
        size,
        color,
        alpha: 0.72,
        thickness,
        startMs: interaction.timing.startedOffsetMs,
        endMs: interaction.timing.completedOffsetMs,
      }));
    }
    if (interaction.kind === 'swipe') {
      const samples = profile.emphasis.swipeTrailSamples;
      const start = interaction.screenPath.start;
      const end = interaction.screenPath.end;
      const elapsed = interaction.timing.completedOffsetMs - interaction.timing.startedOffsetMs;
      for (let index = 0; index < samples; index += 1) {
        const progress = index / (samples - 1);
        const x = (start.x + (end.x - start.x) * progress) * width;
        const y = (start.y + (end.y - start.y) * progress) * height;
        const visibleAt = interaction.timing.startedOffsetMs + elapsed * progress;
        filters.push(boxFilter({
          x: clampedBox(x, markerSize, width),
          y: clampedBox(y, markerSize, height),
          size: markerSize,
          color,
          alpha: index === samples - 1 ? 0.95 : 0.68,
          thickness: 'fill',
          startMs: visibleAt,
          endMs: Math.min(
            plan.output.durationMs,
            interaction.timing.completedOffsetMs + profile.emphasis.swipeTrailHoldMs,
          ),
        }));
      }
    }
  }
  return filters.join(',');
}

function ffmpegVersion(exec = defaultExec) {
  try {
    const line = String(exec('ffmpeg', ['-version'])).split(/\r?\n/, 1)[0];
    if (!/^ffmpeg version /.test(line)) fail('renderer_unavailable', 'ffmpeg version 無法辨識');
    return line;
  } catch (error) {
    if (error instanceof PreparationError) throw error;
    fail('renderer_unavailable', 'ffmpeg 不可用');
  }
}

function assertFfmpegCapabilities(exec = defaultExec) {
  let filters;
  let encoders;
  try {
    filters = String(exec('ffmpeg', ['-hide_banner', '-filters']));
    encoders = String(exec('ffmpeg', ['-hide_banner', '-encoders']));
  } catch {
    fail('renderer_unavailable', 'ffmpeg capabilities 無法讀取');
  }
  if (!/\bdrawbox\b/.test(filters) || !/\bzoompan\b/.test(filters) || !/\blibx264\b/.test(encoders)) {
    fail('renderer_unavailable', 'ffmpeg 缺少 zoompan、drawbox 或 libx264');
  }
}

function runFfmpeg(inputPath, outputPath, filter, plan, profile, exec = defaultExec) {
  assertFfmpegCapabilities(exec);
  try {
    exec('ffmpeg', [
      '-v', 'error',
      '-nostdin',
      '-i', inputPath,
      '-vf', filter,
      '-map', '0:v:0',
      '-an',
      '-c:v', profile.output.encoder,
      '-preset', profile.output.preset,
      '-crf', String(profile.output.crf),
      '-pix_fmt', profile.output.pixelFormat,
      '-fps_mode', 'cfr',
      '-t', number(plan.output.durationMs / 1000),
      '-movflags', '+faststart',
      '-y',
      outputPath,
    ]);
  } catch {
    fail('prepared_render_failed', 'ffmpeg prepared render 失敗');
  }
  return { version: ffmpegVersion(exec) };
}

function outputPaths(input, fsImpl = fs) {
  const resolved = {};
  for (const [key, extension] of [['video', '.mp4'], ['plan', '.json'], ['manifest', '.json']]) {
    const value = input[key];
    if (typeof value !== 'string' || !value.toLowerCase().endsWith(extension)) {
      fail('invalid_output_path', `--${key} 必須是 ${extension}`);
    }
    resolved[key] = path.resolve(value);
  }
  if (new Set(Object.values(resolved)).size !== 3) fail('invalid_output_path', 'prepared outputs 必須是三個不同檔案');
  const parents = new Set(Object.values(resolved).map((value) => path.dirname(value)));
  if (parents.size !== 1) fail('invalid_output_path', 'prepared outputs 必須位於同一目錄');
  const parent = [...parents][0];
  let parentMetadata;
  try {
    parentMetadata = fsImpl.lstatSync(parent);
  } catch {
    fail('invalid_output_path', 'prepared output directory 必須已存在');
  }
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    fail('invalid_output_path', 'prepared output directory 必須是 regular directory');
  }
  for (const [key, value] of Object.entries(resolved)) {
    if (fsImpl.existsSync(value)) fail('output_exists', `${key} 已存在，拒絕覆寫`);
  }
  return { ...resolved, parent };
}

function validateSourceManifest(manifest, actions, hashes, sourceProbe, sourcePaths) {
  if (!manifest || manifest.schemaVersion !== 1) {
    fail('invalid_preparation_input', 'recording manifest 必須是 schemaVersion 1');
  }
  if (manifest.artifacts?.rawVideo?.sha256 !== hashes.rawVideo) {
    fail('source_provenance_mismatch', 'recording manifest 的 raw video hash 不一致');
  }
  if (manifest.artifacts?.actions?.sha256 !== hashes.actions) {
    fail('source_provenance_mismatch', 'recording manifest 的 actions hash 不一致');
  }
  if (
    manifest.artifacts?.rawVideo?.file !== path.basename(sourcePaths.rawVideo) ||
    manifest.artifacts?.actions?.file !== path.basename(sourcePaths.actions)
  ) {
    fail('source_provenance_mismatch', 'recording manifest 的 artifact file identity 不一致');
  }
  if (manifest.recipe?.id !== actions.recipe?.id || manifest.recipe?.version !== actions.recipe?.version) {
    fail('source_provenance_mismatch', 'recording manifest 的 recipe identity 不一致');
  }
  if (manifest.recipe?.sha256 !== actions.recipe?.sha256) {
    fail('source_provenance_mismatch', 'recording manifest 的 recipe hash 不一致');
  }
  const manifestCalibration = manifest.recording?.timelineCalibration;
  if (
    manifest.recording?.anchorSemantics !== actions.recording?.anchorSemantics ||
    !manifestCalibration || typeof manifestCalibration !== 'object' || Array.isArray(manifestCalibration) ||
    canonicalDigest(manifestCalibration) !== canonicalDigest(actions.recording.timelineCalibration)
  ) {
    fail('source_provenance_mismatch', 'recording manifest 的 timeline calibration 不一致');
  }
  const manifestDurationSeconds = Number(manifest.recording?.durationSeconds);
  if (
    String(manifest.recording?.codec || '').toLowerCase() !== 'h264' ||
    manifest.recording?.width !== sourceProbe.width ||
    manifest.recording?.height !== sourceProbe.height ||
    !Number.isFinite(manifestDurationSeconds) ||
    Math.abs(manifestDurationSeconds - sourceProbe.durationSeconds) > 0.25
  ) {
    fail('source_provenance_mismatch', 'recording manifest 的 media facts 不一致');
  }
}

function writeJsonExclusive(filePath, value, fsImpl = fs) {
  fsImpl.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

function publish(staged, destinations, fsImpl = fs) {
  const published = [];
  try {
    for (const key of ['video', 'plan', 'manifest']) {
      fsImpl.linkSync(staged[key], destinations[key]);
      published.push(destinations[key]);
    }
  } catch {
    for (const filePath of published.reverse()) {
      try { fsImpl.unlinkSync(filePath); } catch (_) {}
    }
    fail('prepared_publication_failed', 'prepared artifacts 無法完整發布');
  }
}

async function renderPrepared(input, deps = {}) {
  const fsImpl = deps.fs || fs;
  const rawPath = requireRegularFile(input.raw, 'raw video', fsImpl);
  const actionsInput = readJsonFile(input.actions, 'actions', fsImpl);
  const manifestInput = readJsonFile(input.recordingManifest, 'recording manifest', fsImpl);
  const destinations = outputPaths(input, fsImpl);
  const bundleParents = new Set([
    path.dirname(rawPath),
    path.dirname(actionsInput.resolved),
    path.dirname(manifestInput.resolved),
    destinations.parent,
  ]);
  if (bundleParents.size !== 1) {
    fail(
      'input_output_directory_mismatch',
      'raw/actions/recording manifest 與 prepared outputs 必須位於同一 bundle directory',
    );
  }
  const sourcePaths = new Set([rawPath, actionsInput.resolved, manifestInput.resolved]);
  if (Object.values(destinations).some((value) => sourcePaths.has(value))) {
    fail('invalid_output_path', 'prepared output 不可覆蓋 source artifacts');
  }
  const sourceProbe = await (deps.probeVideo || probeVideo)(rawPath);
  const plan = buildPreparedPlan(actionsInput.value, input.profile, sourceProbe);
  const hashes = {
    rawVideo: sha256File(rawPath, fsImpl),
    actions: sha256File(actionsInput.resolved, fsImpl),
    recordingManifest: sha256File(manifestInput.resolved, fsImpl),
  };
  validateSourceManifest(
    manifestInput.value,
    actionsInput.value,
    hashes,
    sourceProbe,
    { rawVideo: rawPath, actions: actionsInput.resolved },
  );

  const tempDir = fsImpl.mkdtempSync(path.join(destinations.parent, '.prepared-mobile-clip-'));
  const staged = {
    video: path.join(tempDir, 'prepared.mp4'),
    plan: path.join(tempDir, 'prepared-plan.json'),
    manifest: path.join(tempDir, 'preparation-provenance.json'),
  };
  try {
    writeJsonExclusive(staged.plan, plan, fsImpl);
    const filter = buildFfmpegFilter(plan, input.profile);
    const renderer = await (deps.runFfmpeg || runFfmpeg)(
      rawPath,
      staged.video,
      filter,
      plan,
      input.profile,
    );
    requireRegularFile(staged.video, 'staged prepared video', fsImpl);
    const preparedProbe = await (deps.probeVideo || probeVideo)(staged.video);
    const frameToleranceSeconds = 1 / plan.output.fps + 0.05;
    if (
      String(preparedProbe.codec).toLowerCase() !== 'h264' ||
      preparedProbe.width !== plan.output.width ||
      preparedProbe.height !== plan.output.height ||
      Math.abs(preparedProbe.durationSeconds - plan.output.durationMs / 1000) > frameToleranceSeconds
    ) {
      fail('prepared_output_invalid', 'prepared output codec、dimensions 或 duration 不符合 plan');
    }
    const manifest = {
      experimentalSchemaVersion: 1,
      status: 'prepared_pending_human_review',
      generatedAt: new Date((deps.clock || Date.now)()).toISOString(),
      captureDuringPreparation: false,
      profile: plan.profile,
      source: {
        rawVideo: {
          file: path.basename(rawPath),
          sha256: hashes.rawVideo,
          codec: sourceProbe.codec,
          width: sourceProbe.width,
          height: sourceProbe.height,
          durationSeconds: sourceProbe.durationSeconds,
        },
        actions: {
          file: path.basename(actionsInput.resolved),
          sha256: hashes.actions,
          canonicalSha256: plan.source.actionsCanonicalSha256,
        },
        recordingManifest: {
          file: path.basename(manifestInput.resolved),
          sha256: hashes.recordingManifest,
        },
        provenanceValidation: 'passed',
      },
      plan: {
        file: path.basename(destinations.plan),
        sha256: sha256File(staged.plan, fsImpl),
        canonicalSha256: plan.sha256,
      },
      output: {
        role: 'experimental-prepared-video',
        file: path.basename(destinations.video),
        sha256: sha256File(staged.video, fsImpl),
        codec: 'h264',
        width: preparedProbe.width,
        height: preparedProbe.height,
        durationSeconds: preparedProbe.durationSeconds,
        fps: preparedProbe.fps,
      },
      tool: {
        id: RENDERER_ID,
        version: RENDERER_VERSION,
        ffmpeg: renderer?.version || 'injected_test_renderer',
        filterSha256: sha256Buffer(filter),
        profileCanonicalSha256: canonicalDigest(input.profile),
      },
      transformation: plan.evidenceBoundary.transformation,
      review: {
        status: 'pending_human_review',
        requiredChecks: [
          'tap emphasis is visible without hiding the target',
          'long press is sustained rather than presented as a normal tap',
          'swipe path and direction are perceptible',
          'result state remains readable during the hold',
          'camera targets and gesture geometry stay inside the frame without black bars',
        ],
      },
    };
    writeJsonExclusive(staged.manifest, manifest, fsImpl);
    (deps.publish || publish)(staged, destinations, fsImpl);
    return {
      ok: true,
      status: manifest.status,
      video: destinations.video,
      plan: destinations.plan,
      manifest: destinations.manifest,
      profileId: input.profile.id,
      planSha256: plan.sha256,
      freshSimulatorCapture: false,
    };
  } finally {
    try { fsImpl.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = {
  RENDERER_ID,
  RENDERER_VERSION,
  assertFfmpegCapabilities,
  buildFfmpegFilter,
  normalizeProbe,
  probeVideo,
  publish,
  renderPrepared,
  runFfmpeg,
  sha256File,
  validateSourceManifest,
};
