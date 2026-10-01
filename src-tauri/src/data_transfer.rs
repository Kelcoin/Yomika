//! 数据迁移的条目词表（docs/30 重构后的形态）。
//!
//! 导出不再有「范围偏好」：要什么在导出/导入的弹层里当场勾。这里的词表只回答
//! 「条目名认不认识」——未知条目在命令入口就被丢掉，而不是被当成数据落地。
//!
//! 条目分两组：记录类（六个目录，与同步范围同名，因为它们命名的是同一批数据）
//! 与凭据类（三类，只在本机）。记录类的 id 与词表本体都在 `commands::sync` 的
//! `SYNC_SCOPE_CATEGORIES`，这里只引用，不再重复一份。
//!
//! `records` 是记录类的旧 id：旧文件与旧界面只有它，含义是「六个目录全都要」。
//! 它继续被接受，新导出则按目录逐个列清单——只导「阅读进度」这种选择才回得来。

use crate::commands::sync::SYNC_SCOPE_CATEGORIES;

/// 记录类的旧 id（整包）。
pub(crate) const DATA_RECORDS_ITEM: &str = "records";

/// 凭据类的三个条目。它们不进同步：凭据库按设备各存各的。
pub(crate) const DATA_CREDENTIAL_ITEMS: [&str; 3] = ["lrr_servers", "eh_account", "sync_accounts"];

pub(crate) fn is_known_item(item: &str) -> bool {
    item == DATA_RECORDS_ITEM
        || SYNC_SCOPE_CATEGORIES.contains(&item)
        || DATA_CREDENTIAL_ITEMS.contains(&item)
}

/// 未知条目直接丢掉（旧版本可能存着已经改名的 id）。
pub(crate) fn normalize_items(items: &[String]) -> Vec<String> {
    items
        .iter()
        .filter(|item| is_known_item(item))
        .cloned()
        .collect()
}

/// 勾选的记录类条目 → 这次要导出/导入的目录，按 `SYNC_SCOPE_CATEGORIES` 的固定
/// 顺序去重。`records` 展开成全部六个目录，所以旧文件照旧整包能用。
pub(crate) fn record_categories(items: &[String]) -> Vec<String> {
    if items.iter().any(|item| item == DATA_RECORDS_ITEM) {
        return SYNC_SCOPE_CATEGORIES
            .iter()
            .map(|category| category.to_string())
            .collect();
    }
    SYNC_SCOPE_CATEGORIES
        .iter()
        .filter(|category| items.iter().any(|item| item.as_str() == **category))
        .map(|category| category.to_string())
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
    fn every_category_and_credential_id_is_known() {
        let mut all: Vec<String> = SYNC_SCOPE_CATEGORIES
            .iter()
            .map(|category| category.to_string())
            .collect();
        all.extend(DATA_CREDENTIAL_ITEMS.iter().map(|item| item.to_string()));
        all.push(DATA_RECORDS_ITEM.to_string());
        assert_eq!(normalize_items(&all).len(), all.len());
    }

    #[test]
    fn records_expands_to_every_category_while_a_subset_stays_a_subset() {
        let every_category = SYNC_SCOPE_CATEGORIES
            .iter()
            .map(|category| category.to_string())
            .collect::<Vec<_>>();
        assert_eq!(record_categories(&[DATA_RECORDS_ITEM.to_string()]), every_category);
        assert_eq!(
            record_categories(&["history".to_string(), "progress".to_string()]),
            vec!["progress".to_string(), "history".to_string()],
            "按词表顺序，勾选顺序不留痕"
        );
        assert_eq!(
            record_categories(&["progress".to_string(), "progress".to_string()]),
            vec!["progress".to_string()],
            "重复的勾选只算一次"
        );
        assert!(
            record_categories(&["lrr_servers".to_string()]).is_empty(),
            "凭据类不是记录目录"
        );
        assert!(record_categories(&["retired".to_string()]).is_empty());
    }
}
