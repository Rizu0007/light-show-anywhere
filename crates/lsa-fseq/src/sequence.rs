use core::time::Duration;

use crate::error::{FseqError, Result};
use crate::header::{Compression, Header, require};

/// A fully decoded light-show sequence: the header plus every frame in memory.
///
/// Frames are stored back to back, so frame `i` is
/// `data[i * channel_count .. (i + 1) * channel_count]` and each byte is one channel's
/// brightness (0 = off, 255 = full).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sequence {
    header: Header,
    data: Vec<u8>,
}

impl Sequence {
    /// Parses and decodes a complete FSEQ v2 file.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let header = Header::parse(bytes)?;
        let data = decode_channel_data(&header, bytes)?;
        Ok(Self { header, data })
    }

    /// Builds an uncompressed sequence from raw frame data, for example one made by an editor.
    pub fn from_frames(channel_count: u32, step_time_ms: u8, data: Vec<u8>) -> Result<Self> {
        if channel_count == 0 {
            return Err(FseqError::InvalidHeader("channel count is zero"));
        }
        if step_time_ms == 0 {
            return Err(FseqError::InvalidHeader("step time is zero"));
        }
        let frame_len = channel_count as usize;
        if !data.len().is_multiple_of(frame_len) {
            return Err(FseqError::InvalidHeader(
                "data length is not a whole number of frames",
            ));
        }
        let frame_count = u32::try_from(data.len() / frame_len)
            .map_err(|_| FseqError::InvalidHeader("too many frames"))?;

        let header = Header {
            version: crate::header::Version { major: 2, minor: 0 },
            channel_data_offset: crate::header::FIXED_HEADER_LEN,
            channel_count,
            frame_count,
            step_time_ms,
            compression: Compression::None,
            unique_id: 0,
            blocks: Vec::new(),
            sparse_ranges: Vec::new(),
            variable_headers: Vec::new(),
        };
        Ok(Self { header, data })
    }

    /// The parsed header.
    #[must_use]
    pub fn header(&self) -> &Header {
        &self.header
    }

    /// Mutable access to the header, for example to set metadata before writing.
    pub fn header_mut(&mut self) -> &mut Header {
        &mut self.header
    }

    /// All decoded channel data, frame after frame.
    #[must_use]
    pub fn data(&self) -> &[u8] {
        &self.data
    }

    /// Number of frames.
    #[must_use]
    pub fn frame_count(&self) -> usize {
        self.header.frame_count as usize
    }

    /// Channels per frame.
    #[must_use]
    pub fn channel_count(&self) -> usize {
        self.header.frame_len()
    }

    /// Total playing time.
    #[must_use]
    pub fn duration(&self) -> Duration {
        self.header.duration()
    }

    /// Channel values of one frame.
    #[must_use]
    pub fn frame(&self, index: usize) -> Option<&[u8]> {
        let len = self.channel_count();
        let start = index.checked_mul(len)?;
        self.data.get(start..start.checked_add(len)?)
    }

    /// Index of the frame shown at `time`, or `None` after the show ends.
    #[must_use]
    pub fn frame_index_at(&self, time: Duration) -> Option<usize> {
        let index = time.as_millis() / u128::from(self.header.step_time_ms);
        let index = usize::try_from(index).ok()?;
        (index < self.frame_count()).then_some(index)
    }

    /// Channel values shown at `time`, or `None` after the show ends.
    #[must_use]
    pub fn frame_at(&self, time: Duration) -> Option<&[u8]> {
        self.frame(self.frame_index_at(time)?)
    }

    /// One channel's value in one frame.
    #[must_use]
    pub fn channel(&self, frame: usize, channel: usize) -> Option<u8> {
        if channel >= self.channel_count() {
            return None;
        }
        self.frame(frame).map(|values| values[channel])
    }

    /// Iterates over every frame in order.
    pub fn frames(&self) -> core::slice::ChunksExact<'_, u8> {
        self.data.chunks_exact(self.channel_count())
    }
}

fn decode_channel_data(header: &Header, bytes: &[u8]) -> Result<Vec<u8>> {
    let expected = header.data_len()?;
    let start = header.channel_data_offset;

    match header.compression {
        Compression::None => {
            let end = start
                .checked_add(expected)
                .ok_or(FseqError::InvalidHeader("channel data size overflows"))?;
            require(bytes, end)?;
            Ok(bytes[start..end].to_vec())
        }
        Compression::Zstd => decode_zstd(header, bytes, expected),
        Compression::Zlib => Err(FseqError::UnsupportedCompression(
            Compression::Zlib.to_raw(),
        )),
    }
}

#[cfg(feature = "zstd")]
fn decode_zstd(header: &Header, bytes: &[u8], expected: usize) -> Result<Vec<u8>> {
    use std::io::Read;

    // The header's size is untrusted: reserve only what the file could plausibly hold, and never
    // decompress past it (a small file can claim, or expand to, terabytes).
    let mut out = Vec::with_capacity(expected.min(bytes.len().saturating_mul(16)));
    let mut position = header.channel_data_offset;

    // Writers pad the block table with zero-length entries; skip them.
    for (index, block) in header.blocks.iter().enumerate().filter(|(_, b)| b.len > 0) {
        let end = position
            .checked_add(block.len as usize)
            .ok_or(FseqError::InvalidHeader("block size overflows"))?;
        require(bytes, end)?;

        let mut compressed = &bytes[position..end];
        let decoder = ruzstd::decoding::StreamingDecoder::new(&mut compressed)
            .map_err(|_| FseqError::Decompress { block: index })?;
        let remaining = (expected - out.len()) as u64;
        decoder
            .take(remaining)
            .read_to_end(&mut out)
            .map_err(|_| FseqError::Decompress { block: index })?;
        position = end;
    }

    if out.len() < expected {
        return Err(FseqError::DataLength {
            expected,
            actual: out.len(),
        });
    }
    Ok(out)
}

#[cfg(not(feature = "zstd"))]
fn decode_zstd(_header: &Header, _bytes: &[u8], _expected: usize) -> Result<Vec<u8>> {
    Err(FseqError::ZstdDisabled)
}
