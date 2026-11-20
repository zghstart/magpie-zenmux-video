import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { problem } from './common.mjs';

const day = 24 * 60 * 60 * 1000;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

async function save(folder, record) {
  const tmp = join(folder, 'state.tmp');
  await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
  await rename(tmp, join(folder, 'state.json'));
}

function running(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Interactions returns the entire film in its POST response. Write the MP4 before
// publishing completed, so another Magpie process can serve the content request.
export function omniJobs(directory) {
  const root = join(directory, 'zenmux-video-jobs');
  let nextSweep = 0;
  async function sweep() {
    if (nextSweep > Date.now()) return;
    nextSweep = Date.now() + day / 24;
    const cutoff = Date.now() - day;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
      const dir = join(root, entry.name);
      const info = await stat(dir).catch(() => null);
      if (info && info.mtimeMs < cutoff) await rm(dir, { force: true, recursive: true });
    }
  }
  return {
    async start(source, model, run) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await sweep();
      const id = randomUUID();
      const folder = join(root, id);
      await mkdir(folder, { mode: 0o700 });
      const record = { source, model, status: 'in_progress', pid: process.pid, started: Date.now() };
      await save(folder, record);
      // A disconnected caller can retrieve this job later. Re-submitting a POST
      // after losing an upstream reply could purchase a second video.
      void (async () => {
        const tmp = join(folder, 'video.part');
        try {
          const video = await run();
          if (!video.body) throw new Error('ZenMux returned an empty video');
          await pipeline(Readable.fromWeb(video.body), createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
          const { size } = await stat(tmp);
          if (!size) throw new Error('ZenMux returned an empty video');
          await rename(tmp, join(folder, 'video'));
          await save(folder, { ...record, status: 'completed', size, mime: video.headers.get('content-type') || 'video/mp4' });
        } catch (err) {
          await rm(tmp, { force: true });
          await save(folder, { ...record, status: 'failed', error: { message: String(err.message || err).slice(0, 1200) } });
        }
      })().catch((err) => console.error('ZenMux Video could not save job state:', err.code || err.name));
      return { id, status: 'queued' };
    },
    async read(source, model, id, content) {
      if (!uuid.test(id)) throw problem(404, 'Unknown local video task');
      const folder = join(root, id);
      let job;
      try { job = JSON.parse(await readFile(join(folder, 'state.json'), 'utf8')); }
      catch (err) { if (err.code === 'ENOENT') throw problem(404, 'The local video task has expired or does not exist'); throw err; }
      if (job.source !== source || job.model !== model) throw problem(404, 'Unknown local video task');
      if (job.status === 'in_progress' && (!running(job.pid) || Date.now() - job.started > 20 * 60 * 1000)) {
        job.status = 'failed';
        job.error = { message: 'The local Interactions request was interrupted before a video was saved. Check the job in ZenMux before submitting again.' };
      }
      if (!content) return { status: job.status, ...(job.error && { error: job.error }) };
      if (job.status !== 'completed') throw problem(409, job.error?.message || 'Video is still being generated');
      return new Response(Readable.toWeb(createReadStream(join(folder, 'video'))), {
        headers: { 'content-type': job.mime, 'content-length': String(job.size) },
      });
    },
  };
}
