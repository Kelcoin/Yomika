//! 取消牌的行为测试。
//!
//! 这些断言原先长在宿主 `src-tauri/src/inference/cancel.rs` 的 `mod tests` 里，
//! docs/71 §5.3 要求抽取时**迁移**它们而不是删掉：取消逻辑是纯的，所以它跟着
//! 实现一起搬进 `yomika-compute-core`，宿主只留一层到 `InferenceError` 的映射。

use yomika_compute_core::cancel::{
    begin, cancel, pending_count, CancelToken, Cancelled, MAX_PENDING_CANCELS,
};

#[test]
fn a_live_task_sees_its_cancellation() {
    let guard = begin(Some("page-1"));
    let token = guard.token();
    assert!(!token.cancelled());
    assert!(cancel("page-1"));
    assert!(token.cancelled());
    assert!(guard.cancelled());
}

#[test]
fn a_cancellation_that_arrives_first_still_counts() {
    // 前端 abort 之后请求才到（或者请求还堵在全局闸外面）：那次取消不能白丢，
    // 否则旧任务照样占着 GPU 跑完。
    assert!(cancel("page-late"));
    let guard = begin(Some("page-late"));
    assert!(guard.cancelled(), "迟到的取消必须在登记时就生效");
}

#[test]
fn every_task_gets_its_own_flag_and_is_forgotten_when_it_ends() {
    let first = begin(Some("page-a"));
    let second = begin(Some("page-b"));
    assert!(cancel("page-a"));
    assert!(first.cancelled());
    assert!(!second.cancelled(), "另一个任务号不能被连坐");

    let token = second.token();
    drop(second);
    // 已经结束的任务号不再是「正在跑」；取消它会记成待取消，留给下一次
    // 同号任务（同一页重跑）——那时它立刻看到取消。
    assert!(cancel("page-b"));
    assert!(!token.cancelled(), "任务结束之后旧牌不再有主人");
    let again = begin(Some("page-b"));
    assert!(again.cancelled());
}

#[test]
fn an_old_guard_does_not_unregister_a_newer_task_with_the_same_id() {
    // 同一页重跑时任务号会重复：旧 guard 的析构不能把新任务的牌摘掉，否则新任务
    // 从此对取消免疫。
    let first = begin(Some("page-again"));
    let second = begin(Some("page-again"));
    let newer = second.token();
    drop(first);
    assert!(cancel("page-again"));
    assert!(newer.cancelled(), "旧 guard 的析构不该摘掉新登记的牌");
}

#[test]
fn an_unnamed_task_can_never_be_cancelled() {
    let guard = begin(None);
    assert!(!guard.token().cancelled());
    assert!(!CancelToken::none().cancelled());
    assert!(!cancel(""));
}

#[test]
fn the_pending_table_stays_bounded() {
    for index in 0..(MAX_PENDING_CANCELS * 2) {
        cancel(&format!("never-runs-{index}"));
    }
    assert!(pending_count() <= MAX_PENDING_CANCELS);
}

#[test]
fn check_reports_the_shared_cancel_error() {
    let guard = begin(Some("page-check"));
    let token = guard.token();
    assert!(token.check().is_ok(), "还没取消就是 Ok");
    assert!(cancel("page-check"));
    assert_eq!(token.check().unwrap_err(), Cancelled);
    // 没有主人的牌永远不取消：这条路径上 `?` 不会提前返回。
    assert!(CancelToken::none().check().is_ok());
}
