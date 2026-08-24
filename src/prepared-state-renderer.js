'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { pngSize } = require('../scripts/app-locator');
const { parseJsonStrict } = require('./strict-json');

const RENDERER_ID = 'chipk-screenshot-state-preparer';
const RENDERER_VERSION = 1;

class PreparedStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PreparedStateError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PreparedStateError(code, message);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalDigest(value) {
  return sha256Buffer(JSON.stringify(canonicalize(value)));
}

function sha256File(filePath, fsImpl = fs) {
  return sha256Buffer(fsImpl.readFileSync(filePath));
}

function requireRegularFile(filePath, label, fsImpl = fs) {
  let metadata;
  try {
    metadata = fsImpl.lstatSync(filePath);
  } catch {
    fail('MISSING_PREPARATION_INPUT', `${label} is missing`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    fail('INVALID_PREPARATION_INPUT', `${label} must be a non-empty regular file`);
  }
}

function readCaptureManifest(filePath, fsImpl = fs) {
  requireRegularFile(filePath, 'capture manifest', fsImpl);
  try {
    return parseJsonStrict(
      fsImpl.readFileSync(filePath, 'utf8'),
      'capture manifest',
      'INVALID_PREPARATION_INPUT',
    );
  } catch (error) {
    if (error?.code) throw error;
    fail('INVALID_PREPARATION_INPUT', 'capture manifest must be valid JSON');
  }
}

function validateCaptureManifest({ manifest, screenshotPath, captureManifestPath, capturePlan, catalogVersion }, fsImpl = fs) {
  if (!manifest || manifest.schemaVersion !== 1
    || manifest.route?.id !== capturePlan.route.id
    || manifest.parameters?.stockid !== capturePlan.parameters.stockid
    || manifest.parameters?.stockname !== capturePlan.parameters.stockname
    || manifest.catalogVersion !== catalogVersion) {
    fail('CAPTURE_PROVENANCE_MISMATCH', 'capture manifest does not match the reviewed route, stock, or catalog');
  }
  const screenshotSha256 = sha256File(screenshotPath, fsImpl);
  if (manifest.screenshot?.file !== path.basename(screenshotPath)
    || manifest.screenshot?.sha256 !== screenshotSha256) {
    fail('CAPTURE_PROVENANCE_MISMATCH', 'capture manifest screenshot identity does not match the fresh PNG');
  }
  const expectedTexts = manifest.verification?.expectedTexts;
  const matchedTexts = manifest.verification?.matchedTexts;
  if (!Array.isArray(expectedTexts) || !Array.isArray(matchedTexts)
    || expectedTexts.length !== capturePlan.expectedTexts.length
    || matchedTexts.length !== capturePlan.expectedTexts.length
    || capturePlan.expectedTexts.some((text, index) => (
      expectedTexts[index] !== text || matchedTexts[index] !== text
    ))) {
    fail('CAPTURE_READINESS_INCOMPLETE', 'capture manifest does not prove every fail-closed readiness text');
  }
  const content = manifest.verification?.contentTexts;
  if (!content || !Array.isArray(content.expected) || !Array.isArray(content.observed)
    || !Array.isArray(content.missing)
    || content.missing.length !== 0
    || content.expected.length !== capturePlan.contentTexts.length
    || content.observed.length !== capturePlan.contentTexts.length
    || capturePlan.contentTexts.some((text, index) => (
      content.expected[index] !== text || content.observed[index] !== text
    ))) {
    fail('CAPTURE_CONTENT_INCOMPLETE', 'capture manifest does not prove every reviewed content text');
  }
  return Object.freeze({
    screenshotSha256,
    captureManifestSha256: sha256File(captureManifestPath, fsImpl),
  });
}

function number(value) {
  return Number(value.toFixed(6)).toString();
}

function cameraExpression(keyframes, key, fps) {
  const frames = keyframes.map((keyframe) => ({
    frame: Math.round(keyframe.atSeconds * fps),
    value: keyframe[key],
  }));
  let expression = number(frames.at(-1).value);
  for (let index = frames.length - 2; index >= 0; index -= 1) {
    const start = frames[index];
    const end = frames[index + 1];
    const span = end.frame - start.frame;
    if (span <= 0) continue;
    const progress = `(on-${start.frame})/${span}`;
    const eased = `(0.5-0.5*cos(PI*${progress}))`;
    const segment = `${number(start.value)}+(${number(end.value - start.value)})*${eased}`;
    expression = `if(lte(on,${end.frame}),${segment},${expression})`;
  }
  return expression;
}

function buildFfmpegFilter(profile, media) {
  const { fps } = profile;
  const zoom = cameraExpression(profile.camera.keyframes, 'zoom', fps);
  const centerX = cameraExpression(profile.camera.keyframes, 'centerX', fps);
  const centerY = cameraExpression(profile.camera.keyframes, 'centerY', fps);
  return [
    [
      `zoompan=z='${zoom}'`,
      `x='max(0,min(iw-iw/zoom,iw*(${centerX})-iw/zoom/2))'`,
      `y='max(0,min(ih-ih/zoom,ih*(${centerY})-ih/zoom/2))'`,
      'd=1',
      `s=${media.width}x${media.height}`,
      `fps=${fps}`,
    ].join(':'),
    `trim=duration=${number(profile.durationSeconds)}`,
    `setpts=N/(${fps}*TB)`,
    'format=yuv420p',
  ].join(',');
}

function defaultExec(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function assertRendererAvailable(exec = defaultExec) {
  let filters;
  let encoders;
  try {
    filters = String(exec('ffmpeg', ['-hide_banner', '-filters']));
    encoders = String(exec('ffmpeg', ['-hide_banner', '-encoders']));
  } catch {
    fail('RENDERER_UNAVAILABLE', 'ffmpeg capabilities could not be read');
  }
  if (!/\bzoompan\b/.test(filters) || !/\blibx264\b/.test(encoders)) {
    fail('RENDERER_UNAVAILABLE', 'ffmpeg requires zoompan and libx264');
  }
}

function ffmpegVersion(exec = defaultExec) {
  try {
    const value = String(exec('ffmpeg', ['-version'])).split(/\r?\n/, 1)[0];
    if (!/^ffmpeg version /.test(value)) fail('RENDERER_UNAVAILABLE', 'ffmpeg version is invalid');
    return value;
  } catch (error) {
    if (error instanceof PreparedStateError) throw error;
    fail('RENDERER_UNAVAILABLE', 'ffmpeg is unavailable');
  }
}

function runFfmpeg(inputPath, outputPath, filter, profile, exec = defaultExec) {
  assertRendererAvailable(exec);
  try {
    exec('ffmpeg', [
      '-v', 'error',
      '-nostdin',
      '-loop', '1',
      '-framerate', String(profile.fps),
      '-i', inputPath,
      '-vf', filter,
      '-frames:v', String(profile.durationSeconds * profile.fps),
      '-an',
      '-c:v', profile.output.encoder,
      '-preset', profile.output.preset,
      '-crf', String(profile.output.crf),
      '-pix_fmt', profile.output.pixelFormat,
      '-fps_mode', 'cfr',
      '-movflags', '+faststart',
      '-y',
      outputPath,
    ]);
  } catch {
    fail('PREPARED_RENDER_FAILED', 'ffmpeg could not render the prepared screenshot-state clip');
  }
  return { version: ffmpegVersion(exec) };
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
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function probeVideo(videoPath, exec = defaultExec) {
  let output;
  try {
    output = exec('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_name,codec_type,width,height,avg_frame_rate,duration,pix_fmt:format=duration',
      '-of', 'json',
      videoPath,
    ]);
  } catch {
    fail('PREPARED_OUTPUT_INVALID', 'ffprobe could not verify the prepared video');
  }
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    fail('PREPARED_OUTPUT_INVALID', 'ffprobe returned invalid JSON');
  }
  const stream = value?.streams?.find((item) => item.codec_type === 'video') || value?.streams?.[0];
  if (!stream) fail('PREPARED_OUTPUT_INVALID', 'prepared video has no video stream');
  return {
    codec: String(stream.codec_name || ''),
    width: Number(stream.width),
    height: Number(stream.height),
    durationSeconds: Number(stream.duration ?? value?.format?.duration),
    fps: parseRate(stream.avg_frame_rate),
    pixelFormat: String(stream.pix_fmt || ''),
    audioStreamCount: value.streams.filter((item) => item.codec_type === 'audio').length,
  };
}

function writeJsonExclusive(filePath, value, fsImpl = fs) {
  fsImpl.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

function buildPresentationPlan({ request, profile, capturePlan, source, media }) {
  const plan = {
    schemaVersion: 1,
    contractVersion: 2,
    requestId: request.requestId,
    operation: 'prepared-video',
    profile: {
      id: profile.id,
      version: profile.version,
      status: profile.status,
      canonicalSha256: canonicalDigest(profile),
    },
    target: {
      routeId: capturePlan.route.id,
      stockId: capturePlan.parameters.stockid,
      stockName: capturePlan.parameters.stockname,
      mode: request.mode,
    },
    source: {
      kind: 'screenshot',
      file: 'screenshot.png',
      sha256: source.screenshotSha256,
      captureManifest: {
        file: 'capture-manifest.json',
        sha256: source.captureManifestSha256,
      },
      width: media.width,
      height: media.height,
    },
    timeline: {
      durationSeconds: profile.durationSeconds,
      fps: profile.fps,
      frameCount: profile.durationSeconds * profile.fps,
    },
    presentation: {
      camera: profile.camera,
      interactions: [],
    },
    output: {
      codec: profile.output.codec,
      width: media.width,
      height: media.height,
      pixelFormat: profile.output.pixelFormat,
      audio: profile.output.audio,
    },
  };
  return Object.freeze({ ...plan, canonicalSha256: canonicalDigest(plan) });
}

async function renderPreparedScreenshot(input, deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  requireRegularFile(input.screenshot, 'screenshot', fsImpl);
  const captureManifest = readCaptureManifest(input.captureManifest, fsImpl);
  const source = validateCaptureManifest({
    manifest: captureManifest,
    screenshotPath: input.screenshot,
    captureManifestPath: input.captureManifest,
    capturePlan: input.capturePlan,
    catalogVersion: input.catalogVersion,
  }, fsImpl);
  const image = pngSize(input.screenshot);
  if (image.width >= image.height || image.width % 2 !== 0 || image.height % 2 !== 0) {
    fail('UNSUPPORTED_SOURCE_MEDIA', 'prepared screenshot must be an even-dimension portrait PNG');
  }
  const plan = buildPresentationPlan({
    request: input.request,
    profile: input.profile,
    capturePlan: input.capturePlan,
    source,
    media: image,
  });
  writeJsonExclusive(input.presentationPlan, plan, fsImpl);
  const filter = buildFfmpegFilter(input.profile, image);
  const renderer = await (deps.runFfmpeg || runFfmpeg)(
    input.screenshot,
    input.preparedVideo,
    filter,
    input.profile,
  );
  requireRegularFile(input.preparedVideo, 'prepared video', fsImpl);
  const output = await (deps.probeVideo || probeVideo)(input.preparedVideo);
  const frameTolerance = 1 / input.profile.fps;
  if (String(output.codec).toLowerCase() !== 'h264'
    || output.width !== image.width || output.height !== image.height
    || Math.abs(output.durationSeconds - input.profile.durationSeconds) > frameTolerance
    || Math.abs(output.fps - input.profile.fps) > 0.01
    || output.pixelFormat !== input.profile.output.pixelFormat
    || output.audioStreamCount !== 0) {
    fail('PREPARED_OUTPUT_INVALID', 'prepared video does not match codec, dimensions, duration, fps, pixel format, or audio policy');
  }
  const manifest = {
    schemaVersion: 1,
    contractVersion: 2,
    requestId: input.request.requestId,
    status: 'ready_to_place',
    generatedAt: new Date((deps.clock || Date.now)()).toISOString(),
    profile: plan.profile,
    source: plan.source,
    target: plan.target,
    presentationPlan: {
      file: path.basename(input.presentationPlan),
      sha256: sha256File(input.presentationPlan, fsImpl),
      canonicalSha256: plan.canonicalSha256,
    },
    output: {
      role: 'prepared-video',
      file: path.basename(input.preparedVideo),
      sha256: sha256File(input.preparedVideo, fsImpl),
      codec: 'h264',
      width: output.width,
      height: output.height,
      durationSeconds: output.durationSeconds,
      fps: output.fps,
      pixelFormat: output.pixelFormat,
      audio: output.audioStreamCount === 0 ? 'none' : 'present',
    },
    tool: {
      id: RENDERER_ID,
      version: RENDERER_VERSION,
      ffmpeg: renderer?.version || 'injected_test_renderer',
      filterSha256: sha256Buffer(filter),
    },
    publication: {
      strategy: 'staging_directory_atomic_rename',
      finalDirectory: 'ready-to-place',
    },
  };
  writeJsonExclusive(input.preparationManifest, manifest, fsImpl);
  return Object.freeze({ plan, manifest, media: output, filter });
}

module.exports = {
  PreparedStateError,
  RENDERER_ID,
  RENDERER_VERSION,
  buildFfmpegFilter,
  buildPresentationPlan,
  canonicalDigest,
  probeVideo,
  renderPreparedScreenshot,
  runFfmpeg,
  sha256File,
  validateCaptureManifest,
};
