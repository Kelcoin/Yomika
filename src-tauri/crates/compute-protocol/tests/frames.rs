//! 帧格式的红测试（docs/71 §12.1「协议纯测试」行）：prefix 宣称的大小在分配前
//! 就要被拒、短读/截断/非法 UTF-8 都要报错、干净 EOF 不算错。

use yomika_compute_protocol::frame::{read_frame, write_frame, FrameError, MAX_FRAME_BYTES};

#[test]
fn a_frame_round_trips_through_the_writer_and_the_reader() {
    let mut bytes = Vec::new();
    write_frame(&mut bytes, br#"{"type":"ping"}"#).expect("write");
    assert_eq!(&bytes[..4], &(15u32).to_le_bytes(), "长度前缀不含那 4 字节");
    let frame = read_frame(&mut &bytes[..]).expect("read").expect("one frame");
    assert_eq!(frame, br#"{"type":"ping"}"#);
    // 读完一帧之后是边界上的 EOF，不是错误。
    assert!(read_frame(&mut &bytes[bytes.len()..]).expect("eof").is_none());
}

#[test]
fn an_empty_stream_is_a_clean_eof() {
    assert!(read_frame(&mut &[][..]).expect("eof").is_none());
}

#[test]
fn a_prefix_cut_in_half_is_truncated() {
    let error = read_frame(&mut &[0x10u8, 0x00][..]).expect_err("half a prefix");
    assert!(matches!(error, FrameError::Truncated { .. }), "{error:?}");
}

#[test]
fn a_body_that_stops_early_is_truncated() {
    let mut bytes = 100u32.to_le_bytes().to_vec();
    bytes.extend_from_slice(&[b'{'; 10]);
    let error = read_frame(&mut &bytes[..]).expect_err("short body");
    assert_eq!(
        error,
        FrameError::Truncated {
            declared: 100,
            read: 10
        }
    );
}

#[test]
fn an_over_the_limit_prefix_is_rejected_before_the_body_is_read() {
    let declared = MAX_FRAME_BYTES as u32 + 1;
    let error = read_frame(&mut &declared.to_le_bytes()[..]).expect_err("over the limit");
    assert_eq!(error, FrameError::TooLarge { declared });
}

#[test]
fn a_four_gigabyte_claim_is_rejected() {
    // 这一条是 docs/71 §12.1 写明的「最小失败例」：前缀说 4 GiB、正文一个字节都没有。
    // 先看长度再分配，所以这里必须是 TooLarge 而不是读失败。
    let error = read_frame(&mut &u32::MAX.to_le_bytes()[..]).expect_err("4 GiB claim");
    assert_eq!(
        error,
        FrameError::TooLarge {
            declared: u32::MAX
        }
    );
}

#[test]
fn a_body_that_is_not_utf8_is_rejected() {
    let mut bytes = 2u32.to_le_bytes().to_vec();
    bytes.extend_from_slice(&[0xFF, 0xFE]);
    let error = read_frame(&mut &bytes[..]).expect_err("not utf8");
    assert_eq!(error, FrameError::NotUtf8);
}

#[test]
fn writing_a_body_over_the_limit_writes_nothing() {
    let mut bytes = Vec::new();
    let body = vec![b'x'; MAX_FRAME_BYTES + 1];
    let error = write_frame(&mut bytes, &body).expect_err("over the limit");
    assert_eq!(
        error,
        FrameError::TooLarge {
            declared: body.len() as u32
        }
    );
    assert!(bytes.is_empty(), "半帧比不写更糟：对端会读到前缀然后等正文");
}
