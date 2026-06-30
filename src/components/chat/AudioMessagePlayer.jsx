import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';

import { cn } from '@/lib/utils';
import ContactAvatar from './ContactAvatar';

const SPEED_OPTIONS = [1, 1.5, 2];
const waveformCache = new Map();
const waveformContext =
  typeof window !== 'undefined'
    ? new (window.AudioContext || window.webkitAudioContext || class {})()
    : null;

let activeAudioElement = null;
let sharedPlaybackRate = 1;
const playbackRateListeners = new Set();

const formatDuration = (value) => {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
};

const buildFallbackWaveform = (length = 36) =>
  Array.from({ length }, (_, index) => 0.2 + ((index * 17) % 9) / 12);

const resolveAudioDuration = (audioElement) => {
  if (!audioElement) return 0;

  if (Number.isFinite(audioElement.duration) && audioElement.duration > 0) {
    return audioElement.duration;
  }

  try {
    if (audioElement.seekable?.length) {
      const seekableDuration = audioElement.seekable.end(audioElement.seekable.length - 1);
      if (Number.isFinite(seekableDuration) && seekableDuration > 0) {
        return seekableDuration;
      }
    }
  } catch {}

  try {
    if (audioElement.buffered?.length) {
      const bufferedDuration = audioElement.buffered.end(audioElement.buffered.length - 1);
      if (Number.isFinite(bufferedDuration) && bufferedDuration > 0) {
        return bufferedDuration;
      }
    }
  } catch {}

  return 0;
};

const computeWaveformPeaks = async (src) => {
  if (!src) return buildFallbackWaveform();
  if (waveformCache.has(src)) return waveformCache.get(src);

  try {
    const response = await fetch(src);
    const arrayBuffer = await response.arrayBuffer();
    if (!waveformContext?.decodeAudioData) {
      const fallback = buildFallbackWaveform();
      waveformCache.set(src, fallback);
      return fallback;
    }

    const audioBuffer = await waveformContext.decodeAudioData(arrayBuffer.slice(0));
    const channelData = audioBuffer.getChannelData(0);
    const sampleSize = Math.max(1, Math.floor(channelData.length / 36));
    const peaks = [];

    for (let index = 0; index < 36; index += 1) {
      const start = index * sampleSize;
      const end = Math.min(channelData.length, start + sampleSize);
      let peak = 0;
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        peak = Math.max(peak, Math.abs(channelData[sampleIndex]));
      }
      peaks.push(Math.max(0.18, Math.min(1, peak || 0)));
    }

    waveformCache.set(src, peaks);
    return peaks;
  } catch {
    const fallback = buildFallbackWaveform();
    waveformCache.set(src, fallback);
    return fallback;
  }
};

const setSharedPlaybackSpeed = (nextRate) => {
  sharedPlaybackRate = nextRate;
  playbackRateListeners.forEach((listener) => listener(nextRate));
};

const subscribePlaybackRate = (listener) => {
  playbackRateListeners.add(listener);
  return () => playbackRateListeners.delete(listener);
};

const pauseActiveAudio = (nextAudioElement) => {
  if (activeAudioElement && activeAudioElement !== nextAudioElement) {
    activeAudioElement.pause();
  }
  activeAudioElement = nextAudioElement || null;
};

export default function AudioMessagePlayer({
  src,
  mimeType = 'audio/ogg',
  className,
  showSpeed = true,
  size = 'chat',
  autoPlay = false,
  onError,
  avatarSrc,
  avatarName,
}) {
  const audioRef = useRef(null);
  const waveformRef = useRef(null);
  const onErrorRef = useRef(onError);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(sharedPlaybackRate);
  const [waveform, setWaveform] = useState(() => buildFallbackWaveform());

  useEffect(() => subscribePlaybackRate(setPlaybackRate), []);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const ensureAudioSource = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !src) return null;

    if (audio.dataset.loadedSrc !== src) {
      audio.pause();
      audio.src = src;
      audio.load();
      audio.dataset.loadedSrc = src;
      setCurrentTime(0);
      setDuration(0);
      setIsPlaying(false);
    }

    return audio;
  }, [src]);

  useEffect(() => {
    let mounted = true;
    if (!String(src || '').startsWith('data:')) {
      setWaveform(buildFallbackWaveform());
      return () => {
        mounted = false;
      };
    }
    void computeWaveformPeaks(src).then((peaks) => {
      if (mounted) {
        setWaveform(peaks);
      }
    });
    return () => {
      mounted = false;
    };
  }, [src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;

    const syncDuration = () => {
      const nextDuration = resolveAudioDuration(audio);
      if (nextDuration > 0) {
        setDuration(nextDuration);
      }
    };

    const handleLoadedMetadata = () => {
      syncDuration();
    };
    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime || 0);
      syncDuration();
    };
    const handlePlay = () => {
      pauseActiveAudio(audio);
      setIsPlaying(true);
    };
    const handlePause = () => {
      if (activeAudioElement === audio) {
        activeAudioElement = null;
      }
      setIsPlaying(false);
    };
    const handleEnded = () => {
      audio.currentTime = 0;
      setCurrentTime(0);
      setIsPlaying(false);
      if (activeAudioElement === audio) {
        activeAudioElement = null;
      }
    };
    const handleError = () => {
      setIsPlaying(false);
      onErrorRef.current?.();
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('loadeddata', handleLoadedMetadata);
    audio.addEventListener('canplay', handleLoadedMetadata);
    audio.addEventListener('durationchange', handleLoadedMetadata);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);

    if (autoPlay) {
      const loadedAudio = ensureAudioSource();
      void loadedAudio?.play().catch(() => undefined);
    }

    return () => {
      if (activeAudioElement === audio) {
        activeAudioElement = null;
      }
      audio.pause();
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('loadeddata', handleLoadedMetadata);
      audio.removeEventListener('canplay', handleLoadedMetadata);
      audio.removeEventListener('durationchange', handleLoadedMetadata);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
    };
  }, [autoPlay, ensureAudioSource, src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.dataset.loadedSrc || audio.dataset.loadedSrc === src) return;

    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    delete audio.dataset.loadedSrc;
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [src]);

  useEffect(() => {
    const audio = ensureAudioSource();
    if (!audio) return;
    audio.playbackRate = playbackRate;
  }, [playbackRate]);

  const progress = duration > 0 ? currentTime / duration : 0;
  const activeBars = useMemo(() => Math.round(progress * waveform.length), [progress, waveform.length]);

  const handleTogglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      return;
    }

    pauseActiveAudio(audio);
    audio.playbackRate = playbackRate;
    try {
      await audio.play();
    } catch {
      setIsPlaying(false);
    }
  };

  const handleSeek = (event) => {
    const audio = audioRef.current;
    const element = waveformRef.current;
    if (!audio || !element || !duration) return;

    const bounds = element.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    audio.currentTime = duration * ratio;
    setCurrentTime(audio.currentTime);
  };

  const handleChangeSpeed = () => {
    const currentIndex = SPEED_OPTIONS.indexOf(playbackRate);
    const nextRate = SPEED_OPTIONS[(currentIndex + 1) % SPEED_OPTIONS.length];
    setSharedPlaybackSpeed(nextRate);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextRate;
    }
  };

  if (size === 'chat') {
    return (
      <div
        className={cn(
          'flex min-w-[290px] max-w-[420px] items-center gap-3 rounded-2xl border border-border/60 bg-[hsl(var(--wa-input))] px-3 py-2 text-foreground shadow-sm',
          className
        )}
      >
        <audio ref={audioRef} preload="none" data-mime-type={mimeType} />

        <button
          type="button"
          onClick={() => void handleTogglePlayback()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground/8 text-foreground transition-colors hover:bg-foreground/12"
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-[1px] fill-current" />}
        </button>

        <div className="min-w-0 flex-1">
          <button
            ref={waveformRef}
            type="button"
            onClick={handleSeek}
            className="flex h-8 w-full min-w-0 items-center gap-[2px]"
          >
            {waveform.map((value, index) => (
              <span
                key={`${src}-${index}`}
                className={cn(
                  'block w-[3px] rounded-full transition-colors',
                  index <= activeBars ? 'bg-primary' : 'bg-muted-foreground/45'
                )}
                style={{ height: `${Math.max(8, Math.round(value * 22))}px` }}
              />
            ))}
          </button>

          <div className="mt-1 flex items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
            <span>{formatDuration(currentTime)}</span>
            <div className="flex items-center gap-2">
              {showSpeed ? (
                <button
                  type="button"
                  onClick={handleChangeSpeed}
                  className="rounded-full px-1.5 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
                >
                  {playbackRate}x
                </button>
              ) : null}
              <span>{formatDuration(duration)}</span>
            </div>
          </div>
        </div>

        <ContactAvatar
          src={avatarSrc}
          name={avatarName || 'Contato'}
          className="h-11 w-11 shrink-0"
          textClassName="text-[11px]"
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-3',
        size === 'preview' ? 'rounded-2xl bg-white/6 px-3 py-2' : '',
        className
      )}
    >
      <audio ref={audioRef} preload="none" data-mime-type={mimeType} />

      <button
        type="button"
        onClick={() => void handleTogglePlayback()}
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full transition-colors',
          size === 'preview'
            ? 'h-10 w-10 bg-primary text-primary-foreground hover:bg-primary/90'
            : 'h-9 w-9 bg-white/10 text-white hover:bg-white/15'
        )}
      >
        {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-[1px]" />}
      </button>

      <button
        ref={waveformRef}
        type="button"
        onClick={handleSeek}
        className="flex min-w-0 flex-1 items-center gap-[3px]"
      >
        {waveform.map((value, index) => (
          <span
            key={`${src}-${index}`}
            className={cn(
              'block w-1 rounded-full transition-colors',
              index <= activeBars
                ? size === 'preview'
                  ? 'bg-primary'
                  : 'bg-white'
                : size === 'preview'
                  ? 'bg-white/20'
                  : 'bg-white/25'
            )}
            style={{ height: `${Math.max(8, Math.round(value * (size === 'preview' ? 34 : 28)))}px` }}
          />
        ))}
      </button>

      <div className={cn('shrink-0 text-xs tabular-nums', size === 'preview' ? 'text-white/75' : 'text-white/70')}>
        {formatDuration(currentTime)} / {formatDuration(duration)}
      </div>

      {showSpeed ? (
        <button
          type="button"
          onClick={handleChangeSpeed}
          className="shrink-0 rounded-full px-2 py-1 text-xs font-medium text-white/85 transition-colors hover:bg-white/10"
        >
          {playbackRate}x
        </button>
      ) : null}
    </div>
  );
}
