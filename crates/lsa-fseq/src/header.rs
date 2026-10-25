//! The FSEQ v2 file header.
//!
//! Layout (little-endian):
//!
//! | Offset | Size | Field                                                     |
//! |--------|------|-----------------------------------------------------------|
//! | 0      | 4    | Magic `PSEQ`                                              |
//! | 4      | 2    | Offset of channel data                                    |
//! | 6      | 1    | Minor version                                             |
//! | 7      | 1    | Major version (2)                                         |
//! | 8      | 2    | Offset of the first variable header                       |
//! | 10     | 4    | Channels per frame                                        |
//! | 14     | 4    | Frame count                                               |
//! | 18     | 1    | Step time in milliseconds                                 |
//! | 19     | 1    | Flags (unused)                                            |
//! | 20     | 1    | Low 4 bits: compression; high 4 bits: block count bits 8-11 |
//! | 21     | 1    | Block count bits 0-7                                      |
//! | 22     | 1    | Sparse range count                                        |
//! | 23     | 1    | Flags (unused)                                            |
//! | 24     | 8    | Unique id                                                 |
//! | 32     | 8×n  | Compression blocks: frame number (u32), byte length (u32) |
//! | …      | 6×n  | Sparse ranges: start channel (u24), channel count (u24)   |
//! | …      | …    | Variable headers: length (u16), code (2 bytes), data      |

use core::time::Duration;

use crate::error::{FseqError, Result};

/// The four bytes every FSEQ v2 file starts with.
pub const MAGIC: [u8; 4] = *b"PSEQ";
/// Size of the fixed part of the header.
pub const FIXED_HEADER_LEN: usize = 32;

const BLOCK_ENTRY_LEN: usize = 8;
const SPARSE_RANGE_LEN: usize = 6;
const VARIABLE_HEADER_PREFIX_LEN: usize = 4;

/// File format version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Version {
    /// Major version, always 2 for supported files.
    pub major: u8,
    /// Minor version (Tesla has validated 2.0 and 2.2).
    pub minor: u8,
}

/// How the channel data is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Compression {
    /// Raw frames, one after another. Required by Tesla vehicles.
    None,
    /// Frames split into independently zstd-compressed blocks.
    Zstd,
    /// Frames split into zlib-compressed blocks (rare, not yet decoded).
    Zlib,
}

impl Compression {
    fn from_raw(raw: u8) -> Result<Self> {
        match raw {
            0 => Ok(Self::None),
            1 => Ok(Self::Zstd),
            2 => Ok(Self::Zlib),
            other => Err(FseqError::UnsupportedCompression(other)),
        }
    }

    pub(crate) fn to_raw(self) -> u8 {
        match self {
            Self::None => 0,
            Self::Zstd => 1,
            Self::Zlib => 2,
        }
    }
}

/// One entry of the compression block table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CompressionBlock {
    /// First frame stored in this block.
    pub first_frame: u32,
    /// Compressed size of the block in bytes.
    pub len: u32,
}

/// A run of output channels that the stored frames map onto.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SparseRange {
    /// First output channel of the range.
    pub start_channel: u32,
    /// Number of channels in the range.
    pub channel_count: u32,
}

/// A tagged metadata entry, such as `mf` (media file name) or `sp` (producer).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct VariableHeader {
    /// Two-letter code.
    pub code: [u8; 2],
    /// Raw payload.
    pub data: Vec<u8>,
}

impl VariableHeader {
    /// Payload as text, without trailing NUL bytes, if it is valid UTF-8.
    #[must_use]
    pub fn text(&self) -> Option<&str> {
        let end = self.data.iter().rposition(|&b| b != 0).map_or(0, |i| i + 1);
        core::str::from_utf8(&self.data[..end]).ok()
    }
}

/// Parsed FSEQ v2 header.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Header {
    /// File format version.
    pub version: Version,
    /// Byte offset where channel data begins.
    pub channel_data_offset: usize,
    /// Channels stored per frame.
    pub channel_count: u32,
    /// Number of frames.
    pub frame_count: u32,
    /// Time between frames in milliseconds.
    pub step_time_ms: u8,
    /// Storage format of the channel data.
    pub compression: Compression,
    /// Identifier written by the sequencer.
    pub unique_id: u64,
    /// Compression block table (empty for uncompressed files).
    pub blocks: Vec<CompressionBlock>,
    /// Sparse channel ranges (empty when frames cover channels `0..channel_count`).
    pub sparse_ranges: Vec<SparseRange>,
    /// Metadata entries.
    pub variable_headers: Vec<VariableHeader>,
}

impl Header {
    /// Parses the header from the start of an FSEQ file.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        require(bytes, FIXED_HEADER_LEN)?;
        if bytes[..4] != MAGIC {
            return Err(FseqError::BadMagic);
        }

        let version = Version {
            minor: bytes[6],
            major: bytes[7],
        };
        if version.major != 2 {
            return Err(FseqError::UnsupportedVersion {
                major: version.major,
                minor: version.minor,
            });
        }

        let channel_data_offset = usize::from(read_u16(bytes, 4));
        let variable_header_offset = usize::from(read_u16(bytes, 8));
        let channel_count = read_u32(bytes, 10);
        let frame_count = read_u32(bytes, 14);
        let step_time_ms = bytes[18];
        let compression = Compression::from_raw(bytes[20] & 0x0F)?;
        let block_count = usize::from(bytes[21]) | (usize::from(bytes[20] & 0xF0) << 4);
        let sparse_count = usize::from(bytes[22]);
        let unique_id = read_u64(bytes, 24);

        if channel_count == 0 {
            return Err(FseqError::InvalidHeader("channel count is zero"));
        }
        if step_time_ms == 0 {
            return Err(FseqError::InvalidHeader("step time is zero"));
        }

        let sparse_start = FIXED_HEADER_LEN + block_count * BLOCK_ENTRY_LEN;
        let sparse_end = sparse_start + sparse_count * SPARSE_RANGE_LEN;
        if sparse_end > variable_header_offset || variable_header_offset > channel_data_offset {
            return Err(FseqError::InvalidHeader("header tables overlap"));
        }
        require(bytes, channel_data_offset)?;

        let blocks = bytes[FIXED_HEADER_LEN..sparse_start]
            .as_chunks::<BLOCK_ENTRY_LEN>()
            .0
            .iter()
            .map(|entry| CompressionBlock {
                first_frame: read_u32(entry, 0),
                len: read_u32(entry, 4),
            })
            .collect();

        let sparse_ranges = bytes[sparse_start..sparse_end]
            .as_chunks::<SPARSE_RANGE_LEN>()
            .0
            .iter()
            .map(|entry| SparseRange {
                start_channel: read_u24(entry, 0),
                channel_count: read_u24(entry, 3),
            })
            .collect();

        let variable_headers =
            parse_variable_headers(&bytes[variable_header_offset..channel_data_offset]);

        let header = Self {
            version,
            channel_data_offset,
            channel_count,
            frame_count,
            step_time_ms,
            compression,
            unique_id,
            blocks,
            sparse_ranges,
            variable_headers,
        };
        header.data_len()?;
        Ok(header)
    }

    /// Bytes in one frame.
    #[must_use]
    pub fn frame_len(&self) -> usize {
        self.channel_count as usize
    }

    /// Bytes of decoded channel data for the whole sequence.
    pub fn data_len(&self) -> Result<usize> {
        (self.frame_count as usize)
            .checked_mul(self.frame_len())
            .ok_or(FseqError::InvalidHeader(
                "frame count × channel count overflows",
            ))
    }

    /// Time between two frames.
    #[must_use]
    pub fn step_time(&self) -> Duration {
        Duration::from_millis(u64::from(self.step_time_ms))
    }

    /// Total playing time.
    #[must_use]
    pub fn duration(&self) -> Duration {
        Duration::from_millis(u64::from(self.frame_count) * u64::from(self.step_time_ms))
    }

    /// Looks up a metadata entry by its two-letter code.
    #[must_use]
    pub fn variable_header(&self, code: [u8; 2]) -> Option<&VariableHeader> {
        self.variable_headers.iter().find(|h| h.code == code)
    }

    /// Name of the audio file the sequence was made for (`mf` entry).
    #[must_use]
    pub fn media_filename(&self) -> Option<&str> {
        self.variable_header(*b"mf").and_then(VariableHeader::text)
    }
}

fn parse_variable_headers(mut region: &[u8]) -> Vec<VariableHeader> {
    let mut headers = Vec::new();
    while region.len() >= VARIABLE_HEADER_PREFIX_LEN {
        let len = usize::from(read_u16(region, 0));
        if len < VARIABLE_HEADER_PREFIX_LEN || len > region.len() {
            // Padding or a malformed entry: stop instead of guessing.
            break;
        }
        headers.push(VariableHeader {
            code: [region[2], region[3]],
            data: region[VARIABLE_HEADER_PREFIX_LEN..len].to_vec(),
        });
        region = &region[len..];
    }
    headers
}

pub(crate) fn require(bytes: &[u8], needed: usize) -> Result<()> {
    if bytes.len() < needed {
        return Err(FseqError::Truncated {
            needed,
            actual: bytes.len(),
        });
    }
    Ok(())
}

fn read_u16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn read_u24(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], 0])
}

fn read_u32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn read_u64(bytes: &[u8], at: usize) -> u64 {
    let mut buf = [0; 8];
    buf.copy_from_slice(&bytes[at..at + 8]);
    u64::from_le_bytes(buf)
}
