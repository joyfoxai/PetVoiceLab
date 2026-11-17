/**
 * Portrait clip export: MediaRecorder over a canvas stream plus the audio graph's tap. The clip
 * is recorded live (it takes as long as it lasts), so picture and sound are the same performance.
 */
import type { PetAudio } from "../audio/audio.ts";
import type { VoiceTrack } from "../params/protocol.ts";

export interface VideoClock {
  /** seconds since the recording started */
  t: number;
  total: number;
  /** 0..1 progress through the person's clip, or −1 when it is not playing */
  human: number;
  /** which repeat of the pet's call is playing (0-based), or −1 */
  petTake: number;
}

export function pickMime(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === "undefined") return null;
  const options: [string, string][] = [
    // H.264/AAC MP4 plays everywhere (Safari, and Chrome builds with the encoder); otherwise WebM.
    // A bare "video/mp4" comes last: without H.264 it means VP9 in MP4, which phones often refuse.
    ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "mp4"],
    ["video/webm;codecs=vp9,opus", "webm"],
    ["video/webm;codecs=vp8,opus", "webm"],
    ["video/webm", "webm"],
    ["video/mp4", "mp4"],
  ];
  for (const [mime, ext] of options) if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  return null;
}

export interface VideoJob {
  audio: PetAudio;
  canvas: HTMLCanvasElement;
  human: AudioBuffer | null;
  track: VoiceTrack;
  /** aim for about this many seconds by repeating the pet's call */
  targetSeconds?: number;
  draw: (clock: VideoClock) => void;
}

export async function recordVideo(job: VideoJob): Promise<{ blob: Blob; ext: string; seconds: number }> {
  const fmt = pickMime();
  if (!fmt || !job.canvas.captureStream) throw new Error("这个浏览器不支持录制视频（MediaRecorder / captureStream）");
  await job.audio.start();
  const tap = job.audio.recordingStream();
  if (!tap) throw new Error("音频还没有启动");
  const target = job.targetSeconds ?? 10;
  const lead = 0.5;
  const humanLen = job.human ? Math.min(8, job.human.duration) : 0;
  const gap = 0.6;
  const petLen = job.track.duration;
  const petStart = lead + (job.human ? humanLen + gap : 0);
  const takes = Math.max(1, Math.min(4, Math.round((target - petStart - 0.6) / (petLen + gap))));
  const total = petStart + takes * (petLen + gap) + 0.4;

  // draw one frame before capture starts so the first video frame is not blank
  job.draw({ t: 0, total, human: -1, petTake: -1 });
  const video = job.canvas.captureStream(30);
  const stream = new MediaStream([...video.getVideoTracks(), ...tap.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 128_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((resolve, reject) => {
    rec.onstop = () => resolve();
    rec.onerror = () => reject(new Error("录制失败"));
  });

  const ctx = job.audio.ctx!;
  job.audio.immediate = true;
  job.audio.stop();
  rec.start(250);
  const t0 = ctx.currentTime;
  let humanSrc: AudioBufferSourceNode | null = null;
  if (job.human) {
    humanSrc = job.audio.playBuffer(job.human, lead);
    humanSrc?.stop(t0 + lead + humanLen);
  }
  let take = -1;
  await new Promise<void>((resolve) => {
    const tick = () => {
      const t = ctx.currentTime - t0;
      const due = Math.floor((t - petStart) / (petLen + gap));
      if (t >= petStart && due > take && due < takes) {
        take = due;
        job.audio.play(job.track);
      }
      const inTake = take >= 0 && t - (petStart + take * (petLen + gap)) < petLen + 0.15;
      job.draw({ t, total, human: job.human && t >= lead && t < lead + humanLen ? (t - lead) / humanLen : -1, petTake: inTake ? take : -1 });
      if (t >= total) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  rec.stop();
  await done;
  job.audio.immediate = false;
  video.getTracks().forEach((t) => t.stop());
  return { blob: new Blob(chunks, { type: fmt.mime.split(";")[0] }), ext: fmt.ext, seconds: total };
}
