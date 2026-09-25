//! 导入导出范围：一份与同步范围**无关**的勾选，决定文件里装什么。
//!
//! 两者分开是有意的：同步范围管「哪些数据在设备之间自动流动」，导入导出范围管「我
//! 手动带走哪些数据」。同步永远不带凭据（同步密钥由账户口令派生，写进远端文档等于
//! 把钥匙一起交出去），而导入导出本来就是「换台机器」的手段——凭据由使用者自己勾、
//! 自己设口令，所以凭据类是这里的可选项，在那里连类别都没有。
//!
//! 记录类的 id 与同步范围同名，因为它们命名的是同一批数据；但这是**两份清单**：
//! 一份决定推拉什么，一份决定文件里装什么。下面的测试盯着它们保持一致——新增一类
//! 记录时两处都该动。

/// 记录与设置：随同步文档走（`export_scoped_data` / `import_scoped_data`）。
pub(crate) const TRANSFER_RECORD_CATEGORIES: [&str; 6] = [
    "progress",
    "history",
    "watchlist",
    "search_presets",
    "dedup",
    "app_settings",
];

/// 凭据：随口令加密的凭据文件走（`export_credentials` / `import_credentials`）。
/// 三类各自对应文件里的一组条目：服务器条目 + API Key、E-H 账户 + Cookie、
/// 同步账户 + 口令。
pub(crate) const TRANSFER_CREDENTIAL_CATEGORIES: [&str; 3] = [
    "lrr_servers",
    "eh_account",
    "sync_accounts",
];

/// 默认勾选：记录与设置全勾，凭据不勾。带凭据的文件要额外设口令，所以它该是一次
/// 明确的选择，而不是默认就发生在「导出」按钮上。
pub(crate) fn default_transfer_scope() -> Vec<String> {
    TRANSFER_RECORD_CATEGORIES
        .iter()
        .map(|item| item.to_string())
        .collect()
}

fn is_known(category: &str) -> bool {
    TRANSFER_RECORD_CATEGORIES.contains(&category)
        || TRANSFER_CREDENTIAL_CATEGORIES.contains(&category)
}

/// 归类用的判据：这一类是不是凭据类（决定它进哪个文件、要不要口令）。
pub(crate) fn is_credential_category(category: &str) -> bool {
    TRANSFER_CREDENTIAL_CATEGORIES.contains(&category)
}

/// 记录与设置那一半（喂 `export_scoped_data` / `import_scoped_data`）。
///
/// 与同步范围那边的 `parse_sync_scope` 有一处关键差别：**空就是空**，不回落默认。
/// 「一类都不勾」是明确的选择；回落成默认会让「只带凭据」变成「什么都带」。
pub(crate) fn record_transfer_scope(values: &[String]) -> Vec<String> {
    normalize_transfer_scope(values)
        .into_iter()
        .filter(|item| !is_credential_category(item))
        .collect()
}

/// 未知条目直接丢掉（旧版本可能存着已经改名的 id），其余原样保留。空结果**不**回落
/// 默认：「一类都不勾」是使用者明确的选择，回落会让他在下次保存时看到勾又回来了。
pub(crate) fn normalize_transfer_scope(values: &[String]) -> Vec<String> {
    values
        .iter()
        .filter(|item| is_known(item))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sync::SYNC_SCOPE_CATEGORIES;

    #[test]
    fn the_record_classes_are_the_same_data_classes_sync_knows() {
        // 两份清单分开是为了让「同步」与「导入导出」能各自演化，但它们命名的记录类
        // 是同一批：新增一类记录时两处都得动，这条断言就是那个提醒。
        let mut transfer = TRANSFER_RECORD_CATEGORIES.to_vec();
        let mut sync = SYNC_SCOPE_CATEGORIES.to_vec();
        transfer.sort_unstable();
        sync.sort_unstable();
        assert_eq!(transfer, sync);
    }

    #[test]
    fn defaults_leave_the_credential_classes_out() {
        let defaults = default_transfer_scope();
        assert_eq!(defaults.len(), TRANSFER_RECORD_CATEGORIES.len());
        for category in TRANSFER_CREDENTIAL_CATEGORIES {
            assert!(!defaults.iter().any(|item| item == category));
            assert!(is_credential_category(category));
        }
        assert!(!is_credential_category("history"));
    }

    #[test]
    fn the_record_half_is_strict_about_an_empty_choice() {
        // 与同步范围那边的 `parse_sync_scope` 有一处关键差别：空**不**回落默认。
        // 「只带凭据」是明确的选择，回落会把它变成「什么都带」。
        let records = record_transfer_scope(&[
            "history".to_string(),
            "lrr_servers".to_string(),
            "nonsense".to_string(),
        ]);
        assert_eq!(records, vec!["history".to_string()]);
        assert!(record_transfer_scope(&[]).is_empty());
        assert!(record_transfer_scope(&["lrr_servers".to_string()]).is_empty());
    }

    #[test]
    fn unknown_categories_are_dropped_and_an_empty_choice_stays_empty() {
        let normalized = normalize_transfer_scope(&[
            "history".to_string(),
            "favorites".to_string(),
            "credentials".to_string(),
            "lrr_servers".to_string(),
        ]);
        assert_eq!(normalized, vec!["history".to_string(), "lrr_servers".to_string()]);
        assert!(normalize_transfer_scope(&[]).is_empty());
        assert!(normalize_transfer_scope(&["nonsense".to_string()]).is_empty());
    }
}
