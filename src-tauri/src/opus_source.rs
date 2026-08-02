/*!
 * Opus playback: symphonia demuxes, libopus decodes.
 *
 * symphonia has no Opus decoder — not a missing feature flag, the codec is simply absent from
 * 0.5 — and YouTube serves Opus-in-WebM for the large majority of tracks at `high` quality, and
 * as the *only* audio offered for many of them. So the container is read with symphonia, which
 * already handles Matroska and Ogg, and the packets inside go to libopus.
 *
 * Everything else — AAC, FLAC, MP3, ALAC, Vorbis, WAV — stays on `rodio::Decoder`, which does
 * have decoders for those. This module exists for exactly one codec.
 */

use std::collections::VecDeque;
use std::time::Duration;

use rodio::{ChannelCount, SampleRate, Source};
use symphonia::core::codecs::CODEC_TYPE_OPUS;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

/// Opus always decodes at 48 kHz, whatever the source was encoded from. Fixed by RFC 6716.
const OPUS_SAMPLE_RATE: u32 = 48_000;

/// Longest Opus frame is 120 ms, which at 48 kHz is 5760 samples per channel.
const MAX_FRAME_SAMPLES: usize = 5_760;

/// Whether a mime type names something only libopus can decode.
pub(crate) fn is_opus(mime_type: &str) -> bool {
    let lowered = mime_type.to_ascii_lowercase();
    /*
     * `audio/webm` on its own counts. YouTube labels the Opus tier
     * `audio/webm; codecs="opus"`, but a truncated or generic label still means Opus in
     * practice — WebM carries no other audio codec that symphonia would want instead, and
     * guessing wrong here costs one failed load rather than silence.
     */
    lowered.contains("opus") || lowered.contains("webm")
}

pub(crate) struct OpusSource {
    format: Box<dyn FormatReader>,
    decoder: opus::Decoder,
    track_id: u32,
    channels: ChannelCount,
    /// Decoded samples not yet handed to rodio, interleaved.
    pending: VecDeque<f32>,
    /// Reused across packets so decoding does not allocate per frame.
    scratch: Vec<f32>,
    total_duration: Option<Duration>,
    /// Samples the encoder asks to be thrown away — the codec's own warm-up, not audio.
    skip_samples: usize,
    exhausted: bool,
}

impl OpusSource {
    /**
     * Opens a reader as an Opus stream.
     *
     * Fails when the container holds no Opus track, which is the caller's cue that this was the
     * wrong path and rodio should have it instead.
     */
    pub(crate) fn new(
        source: Box<dyn MediaSource>,
        mime_type: &str,
    ) -> Result<Self, String> {
        let stream = MediaSourceStream::new(source, Default::default());

        let mut hint = Hint::new();
        // Helps the probe pick a reader without sniffing the whole header. Harmless when wrong:
        // the probe falls back to content detection.
        if mime_type.contains("webm") || mime_type.contains("matroska") {
            hint.with_extension("webm");
        } else if mime_type.contains("ogg") || mime_type.contains("opus") {
            hint.with_extension("ogg");
        }

        let probed = symphonia::default::get_probe()
            .format(
                &hint,
                stream,
                &FormatOptions { enable_gapless: true, ..Default::default() },
                &MetadataOptions::default(),
            )
            .map_err(|error| format!("opus container probe failed: {error}"))?;
        let format = probed.format;

        let track = format
            .tracks()
            .iter()
            .find(|track| track.codec_params.codec == CODEC_TYPE_OPUS)
            .ok_or_else(|| "container holds no Opus track".to_string())?;

        let params = &track.codec_params;
        let track_id = track.id;
        let channel_count = params.channels.map(|channels| channels.count()).unwrap_or(2).max(1);
        let channels = ChannelCount::new(channel_count as u16)
            .ok_or_else(|| "opus track declared zero channels".to_string())?;

        let opus_channels = match channel_count {
            1 => opus::Channels::Mono,
            2 => opus::Channels::Stereo,
            /*
             * libopus decodes only mono and stereo through this API; surround needs the
             * multistream decoder. YouTube Music does not serve surround, so this reports
             * rather than pretending.
             */
            other => return Err(format!("unsupported opus channel count: {other}")),
        };
        let decoder = opus::Decoder::new(OPUS_SAMPLE_RATE, opus_channels)
            .map_err(|error| format!("opus decoder init failed: {error}"))?;

        /*
         * Duration from the container's own frame count rather than from the file size — an
         * Opus stream is variable bitrate, so bytes say nothing useful about length.
         */
        let total_duration = params.n_frames.map(|frames| {
            Duration::from_secs_f64(frames as f64 / OPUS_SAMPLE_RATE as f64)
        });

        /*
         * Pre-skip. Every Opus stream begins with encoder warm-up that is not part of the
         * recording; OpusHead states how much, and playing it back is an audible tick at the
         * start of every single track.
         */
        let skip_samples = params.delay.unwrap_or(0) as usize * channel_count;

        Ok(Self {
            format,
            decoder,
            track_id,
            channels,
            pending: VecDeque::with_capacity(MAX_FRAME_SAMPLES * channel_count),
            scratch: vec![0.0; MAX_FRAME_SAMPLES * channel_count],
            total_duration,
            skip_samples,
            exhausted: false,
        })
    }

    /// Decodes the next packet belonging to our track. False means the stream ended.
    fn fill(&mut self) -> bool {
        while !self.exhausted {
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    self.exhausted = true;
                    return false;
                }
                Err(error) => {
                    eprintln!("[internal][tauri][warn] opus demux ended: {error}");
                    self.exhausted = true;
                    return false;
                }
            };
            // A WebM file interleaves streams; packets for the video track are not ours.
            if packet.track_id() != self.track_id {
                continue;
            }

            let frames = match self.decoder.decode_float(&packet.data, &mut self.scratch, false) {
                Ok(frames) => frames,
                Err(error) => {
                    /*
                     * One bad packet is not a dead track — a range that arrived torn will
                     * produce one, and dropping it costs a few milliseconds of audio where
                     * giving up costs the song.
                     */
                    eprintln!("[internal][tauri][warn] opus packet dropped: {error}");
                    continue;
                }
            };

            let sample_count = frames * self.channels.get() as usize;
            let mut decoded = &self.scratch[..sample_count.min(self.scratch.len())];
            if self.skip_samples > 0 {
                let skipped = self.skip_samples.min(decoded.len());
                self.skip_samples -= skipped;
                decoded = &decoded[skipped..];
            }
            if decoded.is_empty() {
                continue;
            }
            self.pending.extend(decoded.iter().copied());
            return true;
        }
        false
    }
}

impl Iterator for OpusSource {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        if let Some(sample) = self.pending.pop_front() {
            return Some(sample);
        }
        if !self.fill() {
            return None;
        }
        self.pending.pop_front()
    }
}

impl Source for OpusSource {
    #[inline]
    fn current_span_len(&self) -> Option<usize> {
        // Channel count and sample rate never change mid-stream for Opus, so there is only ever
        // one span and its end is the end of the track.
        None
    }

    #[inline]
    fn channels(&self) -> ChannelCount {
        self.channels
    }

    #[inline]
    fn sample_rate(&self) -> SampleRate {
        SampleRate::new(OPUS_SAMPLE_RATE).expect("48 kHz is not zero")
    }

    #[inline]
    fn total_duration(&self) -> Option<Duration> {
        self.total_duration
    }

    fn try_seek(&mut self, position: Duration) -> Result<(), rodio::source::SeekError> {
        self.format
            .seek(
                SeekMode::Coarse,
                SeekTo::Time {
                    time: Time::from(position.as_secs_f64()),
                    track_id: Some(self.track_id),
                },
            )
            .map_err(|error| {
                eprintln!("[internal][tauri][warn] opus seek failed: {error}");
                rodio::source::SeekError::NotSupported { underlying_source: "OpusSource" }
            })?;

        /*
         * Everything decoded before the seek belongs to where the track *was*. The decoder also
         * has to forget its inter-frame state, or the first frames after a jump are reconstructed
         * against samples from somewhere else entirely and arrive as a burst of noise.
         */
        self.pending.clear();
        self.exhausted = false;
        let _ = self.decoder.reset_state();
        Ok(())
    }
}
