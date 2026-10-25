use crate::error::{FseqError, Result};
use crate::header::{Compression, FIXED_HEADER_LEN, MAGIC};
use crate::sequence::Sequence;

impl Sequence {
    /// Encodes the sequence as an uncompressed FSEQ v2.0 file, the format Tesla vehicles accept.
    ///
    /// Sparse ranges and metadata entries are kept; compression is always removed.
    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        let header = self.header();

        let sparse_len = header.sparse_ranges.len() * 6;
        let variable_len: usize = header
            .variable_headers
            .iter()
            .map(|h| h.data.len() + 4)
            .sum();
        let variable_offset = FIXED_HEADER_LEN + sparse_len;
        let data_offset = variable_offset + variable_len;

        let variable_offset = u16::try_from(variable_offset)
            .map_err(|_| FseqError::InvalidHeader("too many sparse ranges"))?;
        let data_offset = u16::try_from(data_offset)
            .map_err(|_| FseqError::InvalidHeader("metadata is too large"))?;
        let sparse_count = u8::try_from(header.sparse_ranges.len())
            .map_err(|_| FseqError::InvalidHeader("too many sparse ranges"))?;

        let mut out = Vec::with_capacity(usize::from(data_offset) + self.data().len());
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&data_offset.to_le_bytes());
        out.push(0); // minor version
        out.push(2); // major version
        out.extend_from_slice(&variable_offset.to_le_bytes());
        out.extend_from_slice(&header.channel_count.to_le_bytes());
        out.extend_from_slice(&header.frame_count.to_le_bytes());
        out.push(header.step_time_ms);
        out.push(0); // flags
        out.push(Compression::None.to_raw());
        out.push(0); // compression block count
        out.push(sparse_count);
        out.push(0); // flags
        out.extend_from_slice(&header.unique_id.to_le_bytes());

        for range in &header.sparse_ranges {
            out.extend_from_slice(&range.start_channel.to_le_bytes()[..3]);
            out.extend_from_slice(&range.channel_count.to_le_bytes()[..3]);
        }
        for entry in &header.variable_headers {
            let len = u16::try_from(entry.data.len() + 4)
                .map_err(|_| FseqError::InvalidHeader("metadata entry is too large"))?;
            out.extend_from_slice(&len.to_le_bytes());
            out.extend_from_slice(&entry.code);
            out.extend_from_slice(&entry.data);
        }

        out.extend_from_slice(self.data());
        Ok(out)
    }
}
