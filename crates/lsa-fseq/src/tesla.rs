//! Checks that a sequence will play on a Tesla vehicle.
//!
//! Mirrors the rules of Tesla's official `validator.py`
//! (<https://github.com/teslamotors/light-show>).

use core::time::Duration;

use crate::header::{Compression, Header};

/// Channel count of the standard Tesla layout.
pub const STANDARD_CHANNELS: u32 = 48;
/// Channel count of the extended Tesla layout.
pub const EXTENDED_CHANNELS: u32 = 200;
/// Shortest step time Tesla accepts.
pub const MIN_STEP_TIME_MS: u8 = 15;
/// Longest show Tesla accepts.
pub const MAX_DURATION: Duration = Duration::from_hours(4);

/// Which Tesla channel layout a sequence uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChannelLayout {
    /// 48 channels.
    Standard,
    /// 200 channels.
    Extended,
}

/// A reason the vehicle would reject the file.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum TeslaIssue {
    /// The sequence has no frames.
    #[error("sequence has no frames")]
    Empty,
    /// The channel count is neither 48 nor 200.
    #[error("expected 48 or 200 channels, got {0}")]
    ChannelCount(u32),
    /// The file is compressed.
    #[error("file must be uncompressed FSEQ v2")]
    Compressed,
    /// Frames are closer together than 15 ms.
    #[error("step time is {0} ms, minimum is 15 ms")]
    StepTooShort(u8),
    /// The show is longer than four hours.
    #[error("show lasts {0:?}, maximum is 4 hours")]
    TooLong(Duration),
}

/// Something the vehicle may not handle, but that does not block playback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum TeslaWarning {
    /// Tesla has only validated versions 2.0 and 2.2.
    UntestedVersion {
        /// Major version.
        major: u8,
        /// Minor version.
        minor: u8,
    },
}

/// Result of a successful check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeslaReport {
    /// Detected channel layout.
    pub layout: ChannelLayout,
    /// Show length.
    pub duration: Duration,
    /// Non-blocking concerns.
    pub warnings: Vec<TeslaWarning>,
}

/// Checks a header against Tesla's rules.
pub fn check(header: &Header) -> Result<TeslaReport, TeslaIssue> {
    if header.frame_count == 0 {
        return Err(TeslaIssue::Empty);
    }
    let layout = match header.channel_count {
        STANDARD_CHANNELS => ChannelLayout::Standard,
        EXTENDED_CHANNELS => ChannelLayout::Extended,
        other => return Err(TeslaIssue::ChannelCount(other)),
    };
    if header.compression != Compression::None {
        return Err(TeslaIssue::Compressed);
    }
    if header.step_time_ms < MIN_STEP_TIME_MS {
        return Err(TeslaIssue::StepTooShort(header.step_time_ms));
    }
    let duration = header.duration();
    if duration > MAX_DURATION {
        return Err(TeslaIssue::TooLong(duration));
    }

    let mut warnings = Vec::new();
    let version = header.version;
    if version.major != 2 || !matches!(version.minor, 0 | 2) {
        warnings.push(TeslaWarning::UntestedVersion {
            major: version.major,
            minor: version.minor,
        });
    }

    Ok(TeslaReport {
        layout,
        duration,
        warnings,
    })
}
