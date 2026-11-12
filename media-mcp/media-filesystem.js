import { constants } from 'node:fs';
import { open, readdir, realpath, stat, statfs, mkdtemp, link, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as z from 'zod/v4';

const inside = (root, value) => value === root || value.startsWith(root + path.sep);
const signature = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
const sha = value => createHash('sha256').update(value).digest('hex');
const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;
// Binary containers only: HLS, concat and playlist demuxers can open secondary
// network resources or unrelated local files, defeating exact-file scoping.
export const mediaFileInputOptions = Object.freeze(['-protocol_whitelist','file','-format_whitelist','matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,avi,mpegts,mpeg,asf,flv,ogg,wav,mp3,flac,aac']);

export function runMediaCommand(executable, args, _cwd, { timeoutMs = 30000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', error = '', bytes = 0, killTimer;
    const stop = reason => {
      if (error) return;
      error = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 200);
    };
    const timer = setTimeout(() => stop('Media command timed out'), timeoutMs);
    const collect = (chunk, target) => {
      bytes += chunk.length;
      if (bytes > 2*1024*1024) return stop('Media command exceeded the output limit');
      if (target === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', chunk => collect(chunk, 'stdout'));
    child.stderr.on('data', chunk => collect(chunk, 'stderr'));
    child.on('error', cause => { error = cause.message; });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(killTimer);
      resolve({ code: error ? null : code, stdout, stderr, error });
    });
  });
}

export function parseSrt(text) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const time = value => {
    const match = /^(\d{2,3}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(value);
    if (!match) throw new Error('Invalid SRT timestamp');
    return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]);
  };
  const cues = normalized.trim().split(/\n[ \t]*\n/).filter(Boolean).map(block => {
    const rows = block.split('\n');
    if (!/^\d+$/.test(rows.shift() || '')) throw new Error('Expected an SRT cue number');
    const match = /^(\S+)\s+-->\s+(\S+)([^\n]*)$/.exec(rows.shift() || '');
    if (!match || !rows.length) throw new Error('Invalid SRT cue');
    const startMs = time(match[1]), endMs = time(match[2]);
    if (endMs <= startMs) throw new Error('SRT cue ends before it starts');
    return { startMs, endMs, settings: match[3], text: rows.join('\n') };
  });
  if (!cues.length || cues.length > 20000) throw new Error('SRT must contain 1–20000 cues');
  return cues;
}

function srtTime(value) {
  const ms = Math.round(value);
  if (ms < 0 || ms >= 1000 * 3600000) throw new Error('Shift would put an SRT timestamp outside its supported range');
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

export function createMediaFilesystemTools(deps) {
  const roots = deps.roots;
  async function contained(candidate) {
    const target = await realpath(candidate);
    for (const root of roots) {
      const actual = await realpath(root).catch(() => null);
      if (actual && inside(actual, target)) return target;
    }
    throw new Error('Path resolves outside the configured media roots');
  }
  async function target(input) {
    const requested = input.path || await deps.plexFile(input);
    if (!requested) throw new Error('An exact path or Plex media ratingKey is required');
    const result = await deps.readTarget(requested);
    if (!result.path) throw new Error(result.blockers?.map(b => b.message).join('; ') || 'Media path is unavailable');
    const actual = await contained(result.path);
    const info = await stat(actual);
    if (!info.isFile()) throw new Error('Expected a regular media file');
    return { path: actual, info, sourceSignature: signature(info) };
  }
  async function unchanged(file) {
    if (await contained(file.path) !== file.path || signature(await stat(file.path)) !== file.sourceSignature) {
      throw new Error('Source changed since it was inspected; inspect again before applying');
    }
  }
  async function subtitle(input) {
    const file = await target(input);
    if (path.extname(file.path).toLowerCase() !== '.srt') throw new Error('Only exact SRT sidecar files are supported');
    if (file.info.size > MAX_SUBTITLE_BYTES) throw new Error('Subtitle exceeds the 2 MiB limit');
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (signature(info) !== file.sourceSignature) throw new Error('Subtitle changed during inspection');
      const bytes = Buffer.alloc(MAX_SUBTITLE_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_SUBTITLE_BYTES) throw new Error('Subtitle exceeds the 2 MiB limit');
      const content = bytes.subarray(0, bytesRead);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      return { ...file, content, hash: sha(content), cues: parseSrt(text) };
    } finally { await handle.close(); }
  }
  async function command(name, args, timeoutMs) {
    const executable = await deps.findExecutable([name]);
    if (!executable) throw new Error(`${name} is not available`);
    const result = await (deps.runCommand || runMediaCommand)(executable, args, undefined, { timeoutMs });
    return { ...result, error: String(result.error || result.stderr || '').slice(0, 4000) };
  }
  async function probe(file) {
    const result = await command('ffprobe', ['-v', 'error', ...mediaFileInputOptions, '-print_format', 'json', '-show_format', '-show_streams', file], deps.timeoutMs);
    if (result.code !== 0) throw new Error(`ffprobe failed: ${result.error}`);
    return JSON.parse(result.stdout);
  }
  return {
    async pathStatus(input) {
      const base = { configured: roots.length > 0, allowedRoots: roots, mappings: deps.pathMaps };
      return input.path ? { ...base, ...(await deps.readTarget(input.path)) } : base;
    },
    async listFiles(input) {
      const matches = [];
      for (const candidate of deps.readCandidates(input.path)) {
        const actual = await contained(candidate).catch(() => null);
        if (actual && (await stat(actual)).isDirectory() && !matches.includes(actual)) matches.push(actual);
      }
      if (matches.length !== 1) throw new Error(matches.length ? 'Directory mapping is ambiguous; use an exact mapped path' : 'No readable directory inside media roots');
      const records = [], queue = [{ directory: matches[0], depth: 0 }];
      let visited = 0, truncated = false;
      while (queue.length && !truncated) {
        const current = queue.shift();
        const entries = await readdir(await contained(current.directory), { withFileTypes: true });
        for (const entry of entries) {
          if (++visited > 3000 || records.length >= input.limit) { truncated = true; break; }
          if (entry.isSymbolicLink()) continue;
          const filePath = await contained(path.join(current.directory, entry.name));
          if (entry.isDirectory() && current.depth < input.depth) queue.push({ directory: filePath, depth: current.depth + 1 });
          else if (entry.isFile()) {
            const info = await stat(filePath);
            records.push({ path: filePath, relativePath: path.relative(matches[0], filePath), size: info.size, modifiedAt: info.mtime.toISOString() });
          }
        }
      }
      return { directory: matches[0], records, returned: records.length, truncated, maxDepth: input.depth };
    },
    async decode(input) {
      const file = await target(input);
      const metadata = await probe(file.path);
      const duration = Number(metadata.format?.duration);
      if (!Number.isFinite(duration) || input.startSeconds >= duration) throw new Error('Requested interval is outside a known media duration');
      const seconds = Math.min(input.durationSeconds, duration - input.startSeconds);
      const result = await command('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', ...mediaFileInputOptions, '-ss', String(input.startSeconds), '-i', file.path, '-t', String(seconds), '-map', '0:v?', '-map', '0:a?', '-f', 'null', '-'], deps.timeoutMs);
      await unchanged(file);
      return { path: file.path, startSeconds: input.startSeconds, durationSeconds: seconds, decoded: result.code === 0, exitCode: result.code, error: result.error || null, scope: 'Only this local audio/video interval was decoded; this does not verify playback on a particular client.' };
    },
    async subtitleSync(input) {
      const file = await subtitle(input);
      const cues = file.cues;
      const result = { path: file.path, sha256: file.hash, cueCount: cues.length, firstStartMs: cues[0].startMs, lastEndMs: Math.max(...cues.map(c => c.endMs)), cues: cues.slice(0, input.limit).map(({ startMs, endMs }) => ({ startMs, endMs })), truncated: cues.length > input.limit, synchronizationVerified: false, limitation: 'Cue timing alone cannot establish synchronization with spoken audio.' };
      if (input.referencePath) {
        const reference = await subtitle({ path: input.referencePath });
        const sameCount = cues.length === reference.cues.length;
        const deltas = cues.slice(0, reference.cues.length).map((cue, i) => cue.startMs - reference.cues[i].startMs).sort((a,b) => a-b);
        result.reference = { cueCount: reference.cues.length, sameCueCount: sameCount, medianStartOffsetMs: deltas[Math.floor(deltas.length/2)], timingsAligned: sameCount && cues.every((cue,i) => Math.abs(cue.startMs-reference.cues[i].startMs)<=input.toleranceMs && Math.abs(cue.endMs-reference.cues[i].endMs)<=input.toleranceMs) };
      }
      return result;
    },
    async retime(input) {
      const file = await subtitle(input);
      const shifted = file.cues.map((cue, i) => `${i+1}\n${srtTime(cue.startMs+input.offsetMs)} --> ${srtTime(cue.endMs+input.offsetMs)}${cue.settings}\n${cue.text}`).join('\n\n')+'\n';
      const output = input.replaceOriginal ? file.path : file.path.replace(/\.srt$/i, '.retimed.srt');
      const backup = `${file.path}.backup-${file.hash.slice(0,16)}`;
      const result = { dryRun: input.dryRun, path: file.path, outputPath: output, backupPath: input.replaceOriginal ? backup : null, sha256: file.hash, cueCount: file.cues.length, offsetMs: input.offsetMs, written: false };
      if (input.dryRun) return result;
      if (input.expectedSha256 !== file.hash) throw new Error('Apply requires expectedSha256 from the current subtitle inspection');
      await unchanged(file);
      const temporary = await mkdtemp(path.join(path.dirname(file.path), '.media-mcp-subtitle-'));
      try {
        const staging = path.join(temporary, 'retimed.srt');
        const handle = await open(staging, 'wx', file.info.mode & 0o777);
        try { await handle.writeFile(shifted); await handle.sync(); } finally { await handle.close(); }
        await unchanged(file);
        if (input.replaceOriginal) {
          // Exclusive backup creation; an earlier backup is never overwritten.
          const saved = await open(backup, 'wx', file.info.mode & 0o777);
          try { await saved.writeFile(file.content); await saved.sync(); } finally { await saved.close(); }
          await unchanged(file);
          await rename(staging, file.path);
        } else await link(staging, output); // Fails instead of overwriting an existing file.
        return { ...result, written: true, outputSha256: sha(shifted), synchronizationVerified: false };
      } finally { await rm(temporary, { recursive: true, force: true }); }
    },
    async remux(input) {
      const file = await target(input);
      const metadata = await probe(file.path);
      const streams = metadata.streams || [];
      const audio = streams.filter(s => s.codec_type === 'audio');
      const subtitles = streams.filter(s => s.codec_type === 'subtitle');
      if (input.audioStreamIndex !== undefined && !audio.some(s => s.index === input.audioStreamIndex)) throw new Error('Selected audio stream does not belong to this media file');
      if (input.subtitleStreamIndex !== undefined && !subtitles.some(s => s.index === input.subtitleStreamIndex)) throw new Error('Selected subtitle stream does not belong to this media file');
      if (!streams.some(s => s.codec_type === 'video')) throw new Error('A video media file is required');
      const output = path.join(path.dirname(file.path), path.parse(file.path).name + '.compatibility.mkv');
      if (output === file.path) throw new Error('Compatibility copy must differ from its source');
      const result = { dryRun: input.dryRun, path: file.path, outputPath: output, sourceSignature: file.sourceSignature, streams: streams.map(s => ({ index:s.index,type:s.codec_type,codec:s.codec_name,language:s.tags?.language,default:s.disposition?.default })), audioCodec: input.audioCodec, created: false };
      if (input.dryRun) return result;
      if (input.expectedSourceSignature !== file.sourceSignature) throw new Error('Apply requires expectedSourceSignature from a fresh dry-run');
      const space = await statfs(path.dirname(file.path));
      if (space.bavail * space.bsize < file.info.size * 1.1) throw new Error('Insufficient free space for a separate compatibility copy');
      await unchanged(file);
      const temporary = await mkdtemp(path.join(path.dirname(file.path), '.media-mcp-remux-'));
      try {
        const staging = path.join(temporary, 'copy.mkv');
        const args = ['-nostdin','-v','error','-n',...mediaFileInputOptions,'-i',file.path,'-map','0','-c','copy'];
        if (input.audioCodec !== 'copy') args.push('-c:a',input.audioCodec);
        if (input.audioStreamIndex !== undefined) audio.forEach((s,i) => args.push(`-disposition:a:${i}`,s.index===input.audioStreamIndex?'+default':'-default'));
        if (input.subtitleStreamIndex !== undefined) subtitles.forEach((s,i) => args.push(`-disposition:s:${i}`,s.index===input.subtitleStreamIndex?'+default':'-default'));
        const run = await command('ffmpeg',[...args,staging],input.timeoutSeconds*1000);
        if (run.code !== 0) throw new Error(`Compatibility copy failed: ${run.error}`);
        const outputMetadata = await probe(staging);
        const sourceDuration=Number(metadata.format?.duration), outputDuration=Number(outputMetadata.format?.duration);
        if (outputMetadata.streams?.length !== streams.length || !Number.isFinite(sourceDuration) || !Number.isFinite(outputDuration) || sourceDuration<=0 || outputDuration<=0 || Math.abs(outputDuration-sourceDuration)>2) throw new Error('Compatibility copy failed stream-count or duration verification');
        const copiedAudio=outputMetadata.streams.filter(s=>s.codec_type==='audio');
        const copiedSubtitles=outputMetadata.streams.filter(s=>s.codec_type==='subtitle');
        if (input.audioCodec!=='copy' && copiedAudio.some(s=>s.codec_name!==input.audioCodec)) throw new Error('Compatibility copy failed audio-codec verification');
        for(const [selected,original,copied] of [[input.audioStreamIndex,audio,copiedAudio],[input.subtitleStreamIndex,subtitles,copiedSubtitles]]) {
          if(selected!==undefined && (copied.length!==original.length || copied.some((s,i)=>Boolean(s.disposition?.default)!==(original[i].index===selected)))) throw new Error('Compatibility copy failed default-stream verification');
          if(copied.length!==original.length || original.some((stream,i)=>Object.entries(stream.disposition||{}).some(([flag,value])=>flag!=='default'&&Boolean(value)!==Boolean(copied[i].disposition?.[flag])))) throw new Error('Compatibility copy changed an unrelated stream disposition');
        }
        await unchanged(file);
        await link(staging,output);
        return { ...result, created:true, verified:{streamCount:outputMetadata.streams.length,durationSeconds:Number(outputMetadata.format.duration)}, playbackVerified:false };
      } finally { await rm(temporary,{recursive:true,force:true}); }
    }
  };
}

export function registerMediaFilesystemTools(server,deps) {
  const tools=createMediaFilesystemTools(deps);
  const selected={path:z.string().min(1).optional(),ratingKey:z.union([z.string(),z.number()]).optional(),partIndex:z.number().int().min(0).default(0)};
  const register=(name,description,inputSchema,fn,mutating=false)=>server.registerTool(name,{description,annotations:mutating?{destructiveHint:true,idempotentHint:false}:{readOnlyHint:true},inputSchema},async input=>deps.jsonText(await fn(input)));
  register('media_path_map_status','Inspect configured media path mappings and diagnose one exact readable file path without changing files.',{path:z.string().min(1).optional()},tools.pathStatus);
  register('media_list_series_files','List bounded files below one exact series directory inside configured media roots. Symlinks are not traversed.',{path:z.string().min(1),limit:z.number().int().min(1).max(300).default(100),depth:z.number().int().min(0).max(3).default(1)},tools.listFiles);
  register('media_probe_decode_interval','Decode a bounded interval of an exact mapped media file or Plex part locally, reporting corruption errors without claiming client playback verification.',{...selected,startSeconds:z.number().nonnegative(),durationSeconds:z.number().min(1).max(60).default(15)},tools.decode);
  register('media_verify_subtitle_sync','Inspect SRT cue timestamps and compare with a known-good SRT reference. Timing comparisons do not prove spoken-audio synchronization.',{path:z.string().min(1),referencePath:z.string().min(1).optional(),limit:z.number().int().min(1).max(200).default(20),toleranceMs:z.number().int().min(0).max(5000).default(100)},tools.subtitleSync);
  register('media_retime_subtitle_sidecar','Dry-run an exact SRT offset; apply with inspected SHA256. Writes a separate retimed copy by default; optional replacement creates an exclusive original backup.',{path:z.string().min(1),offsetMs:z.number().int().min(-3600000).max(3600000),replaceOriginal:z.boolean().default(false),expectedSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),dryRun:z.boolean().default(true)},tools.retime,true);
  register('media_remux_compatibility_copy','Dry-run a separate MKV compatibility copy; optionally select default audio/subtitle streams or encode audio as AAC/AC3. Apply requires the dry-run source signature. Never overwrites or deletes the original.',{...selected,audioStreamIndex:z.number().int().nonnegative().optional(),subtitleStreamIndex:z.number().int().nonnegative().optional(),audioCodec:z.enum(['copy','aac','ac3']).default('copy'),timeoutSeconds:z.number().int().min(1).max(300).default(120),expectedSourceSignature:z.string().min(1).optional(),dryRun:z.boolean().default(true)},tools.remux,true);
}
