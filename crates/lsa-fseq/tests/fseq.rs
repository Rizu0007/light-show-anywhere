//! Integration tests for reading and writing FSEQ files.

use core::time::Duration;

use lsa_fseq::tesla::{self, ChannelLayout, TeslaIssue};
use lsa_fseq::{Compression, FseqError, Sequence, SparseRange, VariableHeader};

/// A small 48-channel show: frame `i` has every channel set to `i * 10`.
fn ramp_show(frames: u8) -> Sequence {
    let data = (0..frames).flat_map(|i| vec![i * 10; 48]).collect();
    Sequence::from_frames(48, 20, data).unwrap()
}

#[test]
fn round_trip_keeps_frames_and_metadata() {
    let mut show = ramp_show(5);
    show.header_mut().variable_headers.push(VariableHeader {
        code: *b"mf",
        data: b"song.wav\0".to_vec(),
    });
    show.header_mut().sparse_ranges.push(SparseRange {
        start_channel: 100,
        channel_count: 48,
    });

    let loaded = Sequence::parse(&show.to_bytes().unwrap()).unwrap();

    assert_eq!(loaded.frame_count(), 5);
    assert_eq!(loaded.channel_count(), 48);
    assert_eq!(loaded.data(), show.data());
    assert_eq!(loaded.header().media_filename(), Some("song.wav"));
    assert_eq!(loaded.header().sparse_ranges, show.header().sparse_ranges);
    assert_eq!(loaded.duration(), Duration::from_millis(100));
}

#[test]
fn frame_lookup_by_time() {
    let show = ramp_show(5);

    assert_eq!(show.frame_index_at(Duration::ZERO), Some(0));
    assert_eq!(show.frame_index_at(Duration::from_millis(19)), Some(0));
    assert_eq!(show.frame_index_at(Duration::from_millis(20)), Some(1));
    assert_eq!(show.frame_at(Duration::from_millis(99)).unwrap()[0], 40);
    assert_eq!(show.frame_at(Duration::from_millis(100)), None);
    assert_eq!(show.channel(2, 47), Some(20));
    assert_eq!(show.channel(2, 48), None);
    assert_eq!(show.frames().len(), 5);
}

#[test]
fn tesla_accepts_standard_and_extended_layouts() {
    let report = tesla::check(ramp_show(3).header()).unwrap();
    assert_eq!(report.layout, ChannelLayout::Standard);
    assert_eq!(report.warnings, Vec::new());

    let extended = Sequence::from_frames(200, 20, vec![0; 400]).unwrap();
    assert_eq!(
        tesla::check(extended.header()).unwrap().layout,
        ChannelLayout::Extended
    );
}

#[test]
fn tesla_rejects_bad_files() {
    let wrong_channels = Sequence::from_frames(47, 20, vec![0; 47]).unwrap();
    assert_eq!(
        tesla::check(wrong_channels.header()),
        Err(TeslaIssue::ChannelCount(47))
    );

    let too_fast = Sequence::from_frames(48, 10, vec![0; 48]).unwrap();
    assert_eq!(
        tesla::check(too_fast.header()),
        Err(TeslaIssue::StepTooShort(10))
    );

    let empty = Sequence::from_frames(48, 20, Vec::new()).unwrap();
    assert_eq!(tesla::check(empty.header()), Err(TeslaIssue::Empty));
}

#[test]
fn rejects_broken_files() {
    let good = ramp_show(2).to_bytes().unwrap();

    let mut bad_magic = good.clone();
    bad_magic[0] = b'X';
    assert_eq!(Sequence::parse(&bad_magic), Err(FseqError::BadMagic));

    let mut v1 = good.clone();
    v1[7] = 1;
    assert_eq!(
        Sequence::parse(&v1),
        Err(FseqError::UnsupportedVersion { major: 1, minor: 0 })
    );

    assert!(matches!(
        Sequence::parse(&good[..good.len() - 1]),
        Err(FseqError::Truncated { .. })
    ));
    assert!(matches!(
        Sequence::parse(&good[..10]),
        Err(FseqError::Truncated { .. })
    ));

    let mut unknown_compression = good;
    unknown_compression[20] = 7;
    assert_eq!(
        Sequence::parse(&unknown_compression),
        Err(FseqError::UnsupportedCompression(7))
    );
}

#[test]
fn from_frames_validates_input() {
    assert!(Sequence::from_frames(0, 20, Vec::new()).is_err());
    assert!(Sequence::from_frames(48, 0, Vec::new()).is_err());
    assert!(Sequence::from_frames(48, 20, vec![0; 50]).is_err());
}

/// Builds a zstd-compressed FSEQ file by hand, the way xLights writes one.
#[cfg(feature = "zstd")]
fn zstd_file(frames: &[u8], channels: u32, blocks: &[&[u8]]) -> Vec<u8> {
    let compressed: Vec<Vec<u8>> = blocks
        .iter()
        .map(|block| {
            ruzstd::encoding::compress_to_vec(*block, ruzstd::encoding::CompressionLevel::Fastest)
        })
        .collect();

    let block_table_len = (blocks.len() + 1) * 8; // plus one zero-length padding entry
    let data_offset = 32 + block_table_len;
    let frame_count = frames.len() as u32 / channels;

    let mut out = Vec::new();
    out.extend_from_slice(b"PSEQ");
    out.extend_from_slice(&(data_offset as u16).to_le_bytes());
    out.extend_from_slice(&[2, 2]); // version 2.2
    out.extend_from_slice(&(data_offset as u16).to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&frame_count.to_le_bytes());
    out.extend_from_slice(&[25, 0, 1, (blocks.len() + 1) as u8, 0, 0]);
    out.extend_from_slice(&42u64.to_le_bytes());

    let mut first_frame = 0u32;
    for (block, data) in blocks.iter().zip(&compressed) {
        out.extend_from_slice(&first_frame.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        first_frame += block.len() as u32 / channels;
    }
    out.extend_from_slice(&[0; 8]);

    for data in &compressed {
        out.extend_from_slice(data);
    }
    out
}

#[cfg(feature = "zstd")]
#[test]
fn reads_zstd_compressed_blocks() {
    let frames: Vec<u8> = (0..=255u8).cycle().take(48 * 6).collect();
    let (first, second) = frames.split_at(48 * 4);
    let bytes = zstd_file(&frames, 48, &[first, second]);

    let show = Sequence::parse(&bytes).unwrap();

    assert_eq!(show.header().compression, Compression::Zstd);
    assert_eq!(show.header().unique_id, 42);
    assert_eq!(show.frame_count(), 6);
    assert_eq!(show.data(), frames.as_slice());
    assert_eq!(tesla::check(show.header()), Err(TeslaIssue::Compressed));

    // Writing always produces the uncompressed form Tesla needs.
    let rewritten = Sequence::parse(&show.to_bytes().unwrap()).unwrap();
    assert_eq!(rewritten.header().compression, Compression::None);
    assert!(tesla::check(rewritten.header()).is_ok());
}

#[cfg(feature = "zstd")]
#[test]
fn corrupt_zstd_block_is_an_error() {
    let frames = vec![9u8; 48 * 2];
    let mut bytes = zstd_file(&frames, 48, &[&frames]);
    let data_offset = usize::from(u16::from_le_bytes([bytes[4], bytes[5]]));
    bytes[data_offset] ^= 0xFF; // break the zstd magic number

    assert_eq!(
        Sequence::parse(&bytes),
        Err(FseqError::Decompress { block: 0 })
    );
}
