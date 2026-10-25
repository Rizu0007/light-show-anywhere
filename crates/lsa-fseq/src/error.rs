/// Everything that can go wrong while reading or writing an FSEQ file.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum FseqError {
    /// The file ends before a required part.
    #[error("file is too short: need {needed} bytes, got {actual}")]
    Truncated {
        /// Bytes required to continue.
        needed: usize,
        /// Bytes actually available.
        actual: usize,
    },

    /// The first four bytes are not `PSEQ`.
    #[error("not an FSEQ v2 file (expected magic bytes \"PSEQ\")")]
    BadMagic,

    /// The file uses a major version other than 2.
    #[error("unsupported FSEQ version {major}.{minor} (only 2.x is supported)")]
    UnsupportedVersion {
        /// Major version found in the file.
        major: u8,
        /// Minor version found in the file.
        minor: u8,
    },

    /// A header field contradicts the rest of the file.
    #[error("invalid header: {0}")]
    InvalidHeader(&'static str),

    /// The compression type is unknown or not implemented.
    #[error("compression type {0} is not supported")]
    UnsupportedCompression(u8),

    /// The file is zstd-compressed but the `zstd` feature is disabled.
    #[error("file is zstd-compressed; enable the `zstd` feature to read it")]
    ZstdDisabled,

    /// A compressed block could not be decoded.
    #[error("failed to decompress block {block}")]
    Decompress {
        /// Index of the failing block.
        block: usize,
    },

    /// The decoded channel data does not match the header's frame and channel counts.
    #[error("channel data has {actual} bytes, expected {expected}")]
    DataLength {
        /// Bytes the header promises.
        expected: usize,
        /// Bytes actually found.
        actual: usize,
    },
}

/// Convenience alias used throughout the crate.
pub type Result<T, E = FseqError> = core::result::Result<T, E>;
