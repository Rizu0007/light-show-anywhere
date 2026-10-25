//! Reader and writer for FSEQ v2 light-show sequences.
//!
//! FSEQ is the file format xLights exports and Tesla vehicles play. A sequence is a list of
//! frames; each frame holds one brightness byte per channel (light), shown for a fixed step
//! time.
//!
//! ```
//! use core::time::Duration;
//! use lsa_fseq::{Sequence, tesla};
//!
//! // Two frames of the 48-channel Tesla layout, 20 ms apart: all off, then all on.
//! let mut data = vec![0u8; 48];
//! data.extend(vec![255u8; 48]);
//! let show = Sequence::from_frames(48, 20, data)?;
//!
//! let bytes = show.to_bytes()?;
//! let loaded = Sequence::parse(&bytes)?;
//!
//! assert_eq!(loaded.frame_at(Duration::from_millis(25)).unwrap()[0], 255);
//! assert!(tesla::check(loaded.header()).is_ok());
//! # Ok::<(), lsa_fseq::FseqError>(())
//! ```

mod error;
mod header;
mod sequence;
pub mod tesla;
mod write;

pub use error::{FseqError, Result};
pub use header::{
    Compression, CompressionBlock, FIXED_HEADER_LEN, Header, MAGIC, SparseRange, VariableHeader,
    Version,
};
pub use sequence::Sequence;
