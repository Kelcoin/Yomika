//! 数据迁移的条目词表（docs/30 重构后的形态）。
//!
//! 导出不再有「范围偏好」：要什么在导出/导入的弹层里当场勾。这里的词表只回答
//! 「条目名认不认识」——未知条目在命令入口就被丢掉，而不是被当成数据落地。
//!
//! 记录类的 id 与同步范围同名，因为它们命名的是同一批数据；词表本体在
//! `commands::sync` 的 `SYNC_SCOPE_CATEGORIES`，这里不再重复一份。

/// 导出/导入弹层里的四个条目：记录与设置 + 三类凭据。
pub(crate) const DATA_EXPORT_ITEMS: [&str; 4] = [
    "records",
    "lrr_servers",
    "eh_account",
    "sync_accounts",
];

pub(crate) fn is_known_item(item: &str) -> bool {
    DATA_EXPORT_ITEMS.contains(&item)
}

/// 未知条目直接丢掉（旧版本可能存着已经改名的 id）。
pub(crate) fn normalize_items(items: &[String]) -> Vec<String> {
    items
        .iter()
        .filter(|item| is_known_item(item))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_items_are_dropped() {
        let items = normalize_items(&[
            "records".to_string(),
            "lrr_servers".to_string(),
            "retired".to_string(),
        ]);
        assert_eq!(items, vec!["records".to_string(), "lrr_servers".to_string()]);
    }

    #[test]
    fn every_item_is_known() {
        let all = DATA_EXPORT_ITEMS
            .iter()
            .map(|item| item.to_string())
            .collect::<Vec<_>>();
        assert_eq!(normalize_items(&all).len(), DATA_EXPORT_ITEMS.len());
    }
}
