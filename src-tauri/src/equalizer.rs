/*!
 * Ten-band graphic equaliser.
 *
 * A cascade of peaking biquads between the decoder and the deck. This is only possible at all
 * because the Rust engine owns the samples: the IFrame player never exposes them, and the
 * `<audio>` path would need a second implementation in Web Audio.
 *
 * The settings are process-global rather than per-source. Two decks are live during a crossfade
 * and both have to sound the same, and a slider has to move the track *playing*, not the next
 * one — so a source reads shared state rather than capturing gains when it was built.
 */

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use rodio::{ChannelCount, SampleRate, Source};

/// ISO octave centres. The familiar ten sliders.
pub(crate) const BAND_HZ: [f32; 10] =
    [31.0, 62.0, 125.0, 250.0, 500.0, 1_000.0, 2_000.0, 4_000.0, 8_000.0, 16_000.0];
pub(crate) const BAND_COUNT: usize = BAND_HZ.len();

/**
 * Q for one-octave bands: `1 / (2 * sinh(ln2 / 2 * bandwidth))` with bandwidth 1.
 *
 * Wider (lower Q) and neighbouring sliders fight each other, so moving one visibly changes two;
 * narrower and a boost is a whistle rather than a tone control.
 */
const BAND_Q: f32 = 1.414_213_6;

/// Gains beyond this are not tone control any more, and the preamp cannot buy back the headroom.
const MAX_GAIN_DB: f32 = 12.0;

#[derive(Clone, Copy, PartialEq)]
pub(crate) struct EqualizerValues {
    pub(crate) preamp_db: f32,
    pub(crate) bands_db: [f32; BAND_COUNT],
}

impl EqualizerValues {
    pub(crate) const FLAT: Self = Self { preamp_db: 0.0, bands_db: [0.0; BAND_COUNT] };

    /// Nothing to do — the filters are bypassed entirely rather than run at unity.
    fn is_flat(&self) -> bool {
        self.preamp_db == 0.0 && self.bands_db.iter().all(|gain| *gain == 0.0)
    }

    fn clamped(mut self) -> Self {
        self.preamp_db = self.preamp_db.clamp(-MAX_GAIN_DB, MAX_GAIN_DB);
        for gain in &mut self.bands_db {
            *gain = gain.clamp(-MAX_GAIN_DB, MAX_GAIN_DB);
        }
        self
    }
}

struct EqualizerState {
    /**
     * Bumped on every change.
     *
     * A live source checks this per sample — one relaxed atomic load, a few nanoseconds — and
     * only takes the lock when it actually moved. Locking per sample on the mixing thread would
     * put a mutex in the audio path, which is the one place it must not be.
     */
    generation: AtomicU64,
    values: Mutex<EqualizerValues>,
}

static EQUALIZER: EqualizerState = EqualizerState {
    generation: AtomicU64::new(0),
    values: Mutex::new(EqualizerValues::FLAT),
};

pub(crate) fn set_values(values: EqualizerValues) {
    if let Ok(mut guard) = EQUALIZER.values.lock() {
        *guard = values.clamped();
    }
    // Published after the write, so a source that sees the new generation sees the new values.
    EQUALIZER.generation.fetch_add(1, Ordering::Release);
}

pub(crate) fn values() -> EqualizerValues {
    EQUALIZER
        .values
        .lock()
        .map(|guard| *guard)
        .unwrap_or(EqualizerValues::FLAT)
}

/**
 * One peaking filter, direct form I.
 *
 * The coefficients are the RBJ cookbook's peaking EQ. Direct form I rather than II because it
 * holds its state in the input and output history, which stays well behaved when the
 * coefficients change under it — and here they change every time a slider moves, mid-note.
 */
#[derive(Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    const PASSTHROUGH: Self = Self {
        b0: 1.0,
        b1: 0.0,
        b2: 0.0,
        a1: 0.0,
        a2: 0.0,
        x1: 0.0,
        x2: 0.0,
        y1: 0.0,
        y2: 0.0,
    };

    fn peaking(frequency: f32, sample_rate: f32, gain_db: f32) -> Self {
        // Above Nyquist there is nothing to boost, and the coefficients go to nonsense.
        if gain_db == 0.0 || frequency >= sample_rate / 2.0 {
            return Self::PASSTHROUGH;
        }

        let amplitude = 10f32.powf(gain_db / 40.0);
        let omega = std::f32::consts::TAU * frequency / sample_rate;
        let (sin, cos) = omega.sin_cos();
        let alpha = sin / (2.0 * BAND_Q);

        let a0 = 1.0 + alpha / amplitude;
        Self {
            b0: (1.0 + alpha * amplitude) / a0,
            b1: (-2.0 * cos) / a0,
            b2: (1.0 - alpha * amplitude) / a0,
            a1: (-2.0 * cos) / a0,
            a2: (1.0 - alpha / amplitude) / a0,
            // History is deliberately preserved by the caller; only the coefficients are new.
            ..Self::PASSTHROUGH
        }
    }

    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        let output = self.b0 * input + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = input;
        self.y2 = self.y1;
        self.y1 = output;
        output
    }

    /// Swaps in new coefficients without disturbing the sample history, so a slider moved during
    /// a note retunes the filter rather than restarting it with a click.
    fn retune(&mut self, next: Self) {
        self.b0 = next.b0;
        self.b1 = next.b1;
        self.b2 = next.b2;
        self.a1 = next.a1;
        self.a2 = next.a2;
    }
}

/// Wraps a decoded stream in the equaliser. Cheap when flat: the filters are skipped entirely.
pub(crate) struct EqualizedSource<S> {
    inner: S,
    sample_rate: f32,
    /// Per channel, because a biquad's history is per signal — sharing one across an interleaved
    /// stream filters left against right and produces a mess.
    filters: Vec<[Biquad; BAND_COUNT]>,
    channel_index: usize,
    preamp: f32,
    bypass: bool,
    generation: u64,
}

impl<S: Source> EqualizedSource<S> {
    pub(crate) fn new(inner: S) -> Self {
        let channels = inner.channels().get() as usize;
        let sample_rate = inner.sample_rate().get() as f32;
        let mut source = Self {
            inner,
            sample_rate,
            filters: vec![[Biquad::PASSTHROUGH; BAND_COUNT]; channels.max(1)],
            channel_index: 0,
            preamp: 1.0,
            bypass: true,
            // Not the live generation: starting one behind forces the first sample to load
            // whatever the user already had set before this track began.
            generation: u64::MAX,
        };
        source.reload();
        source
    }

    fn reload(&mut self) {
        self.generation = EQUALIZER.generation.load(Ordering::Acquire);
        let values = values();
        self.bypass = values.is_flat();
        if self.bypass {
            return;
        }

        self.preamp = 10f32.powf(values.preamp_db / 20.0);
        for channel in &mut self.filters {
            for (band, filter) in channel.iter_mut().enumerate() {
                filter.retune(Biquad::peaking(BAND_HZ[band], self.sample_rate, values.bands_db[band]));
            }
        }
    }
}

impl<S: Source> Iterator for EqualizedSource<S> {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        let sample = self.inner.next()?;

        if self.generation != EQUALIZER.generation.load(Ordering::Acquire) {
            self.reload();
        }
        if self.bypass {
            return Some(sample);
        }

        let channel = self.channel_index;
        self.channel_index = (self.channel_index + 1) % self.filters.len();

        let mut output = sample * self.preamp;
        for filter in &mut self.filters[channel] {
            output = filter.process(output);
        }
        Some(output)
    }

    #[inline]
    fn size_hint(&self) -> (usize, Option<usize>) {
        self.inner.size_hint()
    }
}

impl<S: Source> Source for EqualizedSource<S> {
    #[inline]
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }

    #[inline]
    fn channels(&self) -> ChannelCount {
        self.inner.channels()
    }

    #[inline]
    fn sample_rate(&self) -> SampleRate {
        self.inner.sample_rate()
    }

    #[inline]
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }

    fn try_seek(&mut self, position: Duration) -> Result<(), rodio::source::SeekError> {
        self.inner.try_seek(position)?;
        /*
         * The filter history describes audio from before the jump. Carrying it across is a
         * transient built from samples that are no longer adjacent — a thump on every seek.
         */
        for channel in &mut self.filters {
            for filter in channel.iter_mut() {
                filter.x1 = 0.0;
                filter.x2 = 0.0;
                filter.y1 = 0.0;
                filter.y2 = 0.0;
            }
        }
        self.channel_index = 0;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{Biquad, EqualizerValues, BAND_COUNT, BAND_HZ, MAX_GAIN_DB};

    /// Runs a sine through a filter and returns its amplitude once the state has settled.
    fn response_at(mut filter: Biquad, frequency: f32, sample_rate: f32) -> f32 {
        let step = std::f32::consts::TAU * frequency / sample_rate;
        // Long enough for the transient to decay before anything is measured.
        for n in 0..4_000 {
            filter.process((n as f32 * step).sin());
        }
        let mut peak = 0.0f32;
        for n in 4_000..8_000 {
            peak = peak.max(filter.process((n as f32 * step).sin()).abs());
        }
        peak
    }

    /**
     * A band boosts its own centre and leaves the far end of the spectrum alone.
     *
     * The arithmetic is easy to get subtly wrong — a swapped sign or a missed `a0` division
     * produces a filter that still runs and still makes sound, just the wrong sound, which is
     * exactly the kind of bug that survives to a release.
     */
    #[test]
    fn a_band_boosts_its_own_centre_and_leaves_the_rest_alone() {
        let sample_rate = 48_000.0;
        let boosted = Biquad::peaking(1_000.0, sample_rate, 12.0);

        let at_centre = response_at(boosted, 1_000.0, sample_rate);
        // +12 dB is a gain of about 4. Generous bounds: this is checking the shape, not the ripple.
        assert!(
            at_centre > 3.5 && at_centre < 4.5,
            "+12 dB at the centre should be roughly 4x, got {at_centre}",
        );

        let far_below = response_at(boosted, 60.0, sample_rate);
        let far_above = response_at(boosted, 16_000.0, sample_rate);
        assert!(far_below < 1.2, "a 1 kHz band must not lift 60 Hz: {far_below}");
        assert!(far_above < 1.2, "a 1 kHz band must not lift 16 kHz: {far_above}");

        // A cut is the same filter with the gain the other way.
        let cut = response_at(Biquad::peaking(1_000.0, sample_rate, -12.0), 1_000.0, sample_rate);
        assert!(cut > 0.2 && cut < 0.3, "-12 dB should be roughly a quarter, got {cut}");
    }

    /// Zero gain must be exactly transparent, and a band above Nyquist must not produce garbage.
    #[test]
    fn nothing_to_do_means_nothing_is_done() {
        let flat = Biquad::peaking(1_000.0, 48_000.0, 0.0);
        assert_eq!(flat.b0, 1.0);
        assert_eq!(flat.b1, 0.0);
        assert_eq!(flat.a1, 0.0);

        // 16 kHz has no meaning at an 8 kHz sample rate; the coefficients would be nonsense.
        let above_nyquist = Biquad::peaking(16_000.0, 8_000.0, 12.0);
        assert_eq!(above_nyquist.b0, 1.0);
        let passed = response_at(above_nyquist, 1_000.0, 8_000.0);
        assert!((passed - 1.0).abs() < 0.01, "a disabled band is unity gain, got {passed}");
    }

    #[test]
    fn gains_are_clamped_and_flat_is_recognised() {
        assert!(EqualizerValues::FLAT.is_flat());
        assert_eq!(BAND_HZ.len(), BAND_COUNT);

        let mut shouted = EqualizerValues::FLAT;
        shouted.preamp_db = 99.0;
        shouted.bands_db[3] = -99.0;
        let clamped = shouted.clamped();
        assert_eq!(clamped.preamp_db, MAX_GAIN_DB);
        assert_eq!(clamped.bands_db[3], -MAX_GAIN_DB);
        assert!(!clamped.is_flat(), "a clamped setting is still a setting");

        // The preamp alone counts: a pure volume trim must not be optimised away as "flat".
        let mut trimmed = EqualizerValues::FLAT;
        trimmed.preamp_db = -3.0;
        assert!(!trimmed.is_flat());
    }
}
