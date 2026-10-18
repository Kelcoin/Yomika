use yomika_compute_core::resources::{mobile_page_pixel_limit, mobile_tile_edge_for_pixel_budget};

#[test]
fn mobile_frames_follow_shared_memory_with_a_hard_ceiling() {
    assert_eq!(mobile_page_pixel_limit(0), 4_000_000);
    let low = mobile_page_pixel_limit(1 << 30);
    let mid = mobile_page_pixel_limit(4 << 30);
    let high = mobile_page_pixel_limit(16 << 30);
    assert!(low < mid && mid < high);
    assert_eq!(high, 32_000_000);
    assert!(mid * 24 <= (4_u64 << 30) / 8);
    assert_eq!(mobile_page_pixel_limit(u64::MAX), 32_000_000);
}

#[test]
fn mobile_tiles_scale_conservatively_with_the_frame_budget() {
    assert_eq!(mobile_tile_edge_for_pixel_budget(0), 128);
    assert_eq!(mobile_tile_edge_for_pixel_budget(4_000_000), 128);
    assert_eq!(mobile_tile_edge_for_pixel_budget(16_000_000), 256);
    assert_eq!(mobile_tile_edge_for_pixel_budget(32_000_000), 384);
}
