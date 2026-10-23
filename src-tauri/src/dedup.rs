#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn exact_hash_uses_blake3_and_is_deterministic() {
        assert_eq!(
            exact_hash(b"hello"),
            "ea8f163db38682925e4491c5e58d4bb3506ef8c14eb78a86e908c5624a67200f"
        );
    }

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);")
            .expect("migration ledger");
        // 非重复标记会顺手写一条同步日志：夹具需要 settings（设备 id）与 sync_journal。
        connection
            .execute_batch(
                "CREATE TABLE settings (
                    key TEXT PRIMARY KEY NOT NULL,
                    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );",
            )
            .expect("settings schema");
        connection
            .execute_batch(include_str!("../migrations/0003_sync_journal.sql"))
            .expect("sync journal schema");
        connection
            .execute_batch(include_str!("../migrations/0008_dedup_features.sql"))
            .expect("dedup feature schema");
        connection
            .execute_batch(include_str!("../migrations/0015_dedup_sessions.sql"))
            .expect("dedup session schema");
        connection.execute_batch(include_str!("../migrations/0032_dedup_manual_save.sql")).unwrap();
        // 同步日志的落地/写入要比对逻辑时钟，那一列由 0021 加进这张表。
        connection
            .execute_batch(include_str!("../migrations/0021_sync_pull_state.sql"))
            .expect("dedup clock column");
        connection
    }

    #[tokio::test]
    async fn slow_cover_does_not_block_following_covers() {
        use futures_util::StreamExt;
        let jobs = (0..12).map(|index| async move {
            if index == 0 { std::future::pending::<()>().await; }
            index
        }).collect();
        let mut pool = cover_scan_pool(jobs);
        let mut completed = Vec::new();
        for _ in 0..11 {
            completed.push(tokio::time::timeout(std::time::Duration::from_secs(1), pool.next()).await.unwrap().unwrap());
        }
        completed.sort_unstable();
        assert_eq!(completed, (1..12).collect::<Vec<_>>());
    }

    #[test]
    fn scan_checkpoint_does_not_skip_deferred_covers() {
        let mut cursor = CoverScanCheckpoint::new(10);
        for index in 11..80 { cursor.complete(index); }
        assert_eq!(cursor.checkpoint, 10);
        cursor.complete(10);
        assert_eq!(cursor.checkpoint, 80);
        cursor.complete(80);
        assert_eq!(cursor.checkpoint, 81);
    }

    /// Opt-in live profiling: credentials stay in the system store; all writes
    /// go to a temporary database/cache, never the application's data directory.
    #[tokio::test]
    #[ignore = "requires YOMIKA_COVER_PROFILE_DATA and configured LANraragi access"]
    async fn profile_cover_scan_chain() {
        use futures_util::StreamExt;
        use crate::commands::library::{load_scan_thumbnail, CoverThumbnail};
        use crate::domain::result::CommandResult;
        let source_dir = std::path::PathBuf::from(std::env::var("YOMIKA_COVER_PROFILE_DATA").unwrap());
        let source = Connection::open_with_flags(source_dir.join("yomika.sqlite3"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let copy_path = temporary.path().join("profile.sqlite3");
        source.backup(rusqlite::DatabaseName::Main, &copy_path, None).unwrap();
        let connection = Connection::open(copy_path).unwrap();
        connection.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        if version < 31 {
            connection.execute_batch(include_str!("../migrations/0031_cache_quota_covering_index.sql")).unwrap();
        }
        let (server_id, scope): (String, String) = connection.query_row("SELECT id,scope_id FROM servers LIMIT 1", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        let archives = enumerate_scan_archives(&connection, &server_id, i64::MIN / 2, i64::MAX / 2, 0, 64).unwrap();
        let database = crate::db::Database { connection: std::sync::Mutex::new(connection) };
        let start = std::time::Instant::now();
        let jobs = archives.into_iter().map(|archive| {
            let database = &database;
            let server_id = &server_id;
            let scope = &scope;
            let data = temporary.path();
            async move {
                let fetch_start = std::time::Instant::now();
                let result = load_scan_thumbnail(server_id, &archive.archive_id, database, data, None).await.unwrap();
                let fetch_ms = fetch_start.elapsed().as_millis();
                match result {
                    CommandResult::Success { value: CoverThumbnail::Ready(bytes), .. } => {
                        let feature_start = std::time::Instant::now();
                        compute_scan_feature(database, scope, &archive, "readoshi-v3", &bytes).unwrap();
                        (true, fetch_ms, feature_start.elapsed().as_millis())
                    }
                    CommandResult::Success { value: CoverThumbnail::Queued(_), .. } => (false, fetch_ms, 0),
                    CommandResult::Failure { error, .. } => panic!("cover profile failed: {}", error.code),
                }
            }
        }).collect();
        let results: Vec<_> = cover_scan_pool(jobs).collect().await;
        eprintln!("profile covers={} ready={} queued={} elapsed_ms={} network_cache_total_ms={} feature_total_ms={}",
            results.len(), results.iter().filter(|r| r.0).count(), results.iter().filter(|r| !r.0).count(), start.elapsed().as_millis(),
            results.iter().map(|r| r.1).sum::<u128>(), results.iter().map(|r| r.2).sum::<u128>());
    }

    #[test]
    fn deferred_cover_snapshots_remain_resumable_until_the_gap_finishes() {
        let mut connection = connection();
        start_scan(&mut connection, scan_input("v1")).unwrap();
        let mut cursor = CoverScanCheckpoint::new(0);
        cursor.complete(1);
        cursor.complete(2);
        let snapshots = ["a", "b", "c"].into_iter().map(|id| DedupArchiveSnapshotInput {
            archive_id: id.into(), path: id.into(), title: None, page_count: None, size: None,
            feature_version: "v1".into(),
        }).collect();
        let persist = |connection: &mut Connection, checkpoint, archives| scan_chunk(connection, DedupScanChunkInput {
            session_id: "scan-1".into(), algorithm_version: "v1".into(), checkpoint,
            archives, pairs: vec![], selected_archive_ids: vec![],
        }).unwrap();
        let state = persist(&mut connection, cursor.checkpoint, snapshots);
        assert_eq!((state.status.as_str(), state.checkpoint), ("running", 0));
        cancel_scan(&mut connection, "scan-1".into()).unwrap();
        assert_eq!(start_scan(&mut connection, scan_input("v1")).unwrap().checkpoint, 0);
        cursor.complete(0);
        let state = persist(&mut connection, cursor.checkpoint, vec![]);
        assert_eq!((state.status.as_str(), state.checkpoint), ("completed", 3));
        let count: i64 = connection.query_row("SELECT COUNT(*) FROM dedup_archive_snapshots", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn scan_feature_reuses_matching_bytes_and_replaces_changed_version() {
        let database = crate::db::Database { connection: std::sync::Mutex::new(connection()) };
        let archive = DedupScanArchive {
            archive_id: "a".into(), path: "a".into(), title: None,
            filename: "a".into(), page_count: None, size: None,
        };
        let bytes = test_png();
        compute_scan_feature(&database, "scope", &archive, "v1", &bytes).unwrap();
        // A sentinel signature proves that matching bytes skip decoding/write.
        database.connection.lock().unwrap().execute("UPDATE dedup_features SET dhash='sentinel'", []).unwrap();
        compute_scan_feature(&database, "scope", &archive, "v1", &bytes).unwrap();
        let read = || database.connection.lock().unwrap().query_row("SELECT dhash FROM dedup_features", [], |row| row.get::<_, String>(0)).unwrap();
        assert_eq!(read(), "sentinel");
        compute_scan_feature(&database, "scope", &archive, "v2", &bytes).unwrap();
        assert_ne!(read(), "sentinel");
        database.connection.lock().unwrap().execute("UPDATE dedup_features SET dhash='sentinel'", []).unwrap();
        let mut changed = bytes;
        changed.push(0);
        compute_scan_feature(&database, "scope", &archive, "v2", &changed).unwrap();
        assert_ne!(read(), "sentinel");
    }

    fn scan_input(version: &str) -> DedupStartScanInput {
        DedupStartScanInput {
            session_id: "scan-1".into(),
            scope_id: "server-a".into(),
            algorithm_version: version.into(),
            archive_count: 3,
        }
    }

    #[test]
    fn scan_chunk_rolls_back_snapshot_pair_and_checkpoint_together() {
        let mut connection = connection();
        start_scan(&mut connection, scan_input("v1")).expect("start scan");

        let error = scan_chunk(
            &mut connection,
            DedupScanChunkInput {
                session_id: "scan-1".into(),
                algorithm_version: "v1".into(),
                checkpoint: 1,
                archives: vec![DedupArchiveSnapshotInput {
                    archive_id: "a".into(),
                    path: "/a.cbz".into(),
                    title: None,
                    page_count: None,
                    size: None,
                    feature_version: "v1".into(),
                }],
                pairs: vec![DedupPairInput {
                    left_archive_id: "a".into(),
                    right_archive_id: "a".into(),
                    source: "image".into(),
                    diagnostics: None,
                }],
                selected_archive_ids: vec![],
            },
        )
        .expect_err("invalid self pair must fail the complete chunk");
        assert_eq!(error, "Invalid dedup pair");

        let checkpoint: i64 = connection
            .query_row(
                "SELECT checkpoint FROM dedup_sessions WHERE id='scan-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let snapshots: i64 = connection
            .query_row("SELECT COUNT(*) FROM dedup_archive_snapshots", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!((checkpoint, snapshots), (0, 0));
    }

    #[test]
    fn new_algorithm_version_discards_incompatible_progress() {
        let mut connection = connection();
        start_scan(&mut connection, scan_input("v1")).unwrap();
        scan_chunk(
            &mut connection,
            DedupScanChunkInput {
                session_id: "scan-1".into(),
                algorithm_version: "v1".into(),
                checkpoint: 1,
                archives: vec![DedupArchiveSnapshotInput {
                    archive_id: "a".into(),
                    path: "/a.cbz".into(),
                    title: None,
                    page_count: None,
                    size: None,
                    feature_version: "v1".into(),
                }],
                pairs: vec![],
                selected_archive_ids: vec!["a".into()],
            },
        )
        .unwrap();

        start_scan(&mut connection, scan_input("v2")).expect("restart with new algorithm");
        let state: (String, i64, i64) = connection.query_row(
            "SELECT algorithm_version, checkpoint, (SELECT COUNT(*) FROM dedup_archive_snapshots) FROM dedup_sessions WHERE id='scan-1'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(state, ("v2".into(), 0, 0));
    }

    #[test]
    fn non_duplicate_pairs_are_normalized_scoped_and_tombstoned() {
        let mut connection = connection();
        save_non_duplicate(
            &mut connection,
            DedupNonDuplicateInput {
                scope_id: "server-a".into(),
                left_archive_id: "b".into(),
                right_archive_id: "a".into(),
            },
        )
        .unwrap();
        save_non_duplicate(
            &mut connection,
            DedupNonDuplicateInput {
                scope_id: "server-b".into(),
                left_archive_id: "a".into(),
                right_archive_id: "b".into(),
            },
        )
        .unwrap();
        remove_non_duplicate(
            &mut connection,
            DedupNonDuplicateInput {
                scope_id: "server-a".into(),
                left_archive_id: "a".into(),
                right_archive_id: "b".into(),
            },
        )
        .unwrap();

        let relations: Vec<(String, String, i64)> = connection
            .prepare(
                "SELECT scope_id, pair_key, tombstoned FROM dedup_non_duplicates ORDER BY scope_id",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            relations,
            vec![
                ("server-a".into(), "a|b".into(), 1),
                ("server-b".into(), "a|b".into(), 0)
            ]
        );
    }

    #[test]
    fn deletion_revalidation_keeps_one_member_of_each_connected_component() {
        let mut connection = connection();
        start_scan(&mut connection, scan_input("v1")).unwrap();
        scan_chunk(
            &mut connection,
            DedupScanChunkInput {
                session_id: "scan-1".into(),
                algorithm_version: "v1".into(),
                checkpoint: 3,
                archives: vec![
                    DedupArchiveSnapshotInput {
                        archive_id: "a".into(),
                        path: "/a".into(),
                        title: None,
                        page_count: None,
                        size: None,
                        feature_version: "v1".into(),
                    },
                    DedupArchiveSnapshotInput {
                        archive_id: "b".into(),
                        path: "/b".into(),
                        title: None,
                        page_count: None,
                        size: None,
                        feature_version: "v1".into(),
                    },
                    DedupArchiveSnapshotInput {
                        archive_id: "c".into(),
                        path: "/c".into(),
                        title: None,
                        page_count: None,
                        size: None,
                        feature_version: "v1".into(),
                    },
                ],
                pairs: vec![
                    DedupPairInput {
                        left_archive_id: "a".into(),
                        right_archive_id: "b".into(),
                        source: "image".into(),
                        diagnostics: None,
                    },
                    DedupPairInput {
                        left_archive_id: "b".into(),
                        right_archive_id: "c".into(),
                        source: "image".into(),
                        diagnostics: None,
                    },
                ],
                selected_archive_ids: vec!["a".into(), "b".into(), "c".into()],
            },
        )
        .unwrap();

        let result = delete_selected(
            &mut connection,
            DedupDeleteSelectedInput {
                session_id: "scan-1".into(),
                outcomes: vec![],
            },
        )
        .unwrap();
        assert_eq!(result.rejected_archive_ids, vec!["a", "b", "c"]);
        let outcomes: i64 = connection
            .query_row("SELECT COUNT(*) FROM dedup_deletion_outcomes", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(outcomes, 0);
    }

    #[test]
    fn partial_delete_records_each_injected_outcome() {
        let mut connection = connection();
        let mut input = scan_input("v1");
        input.archive_count = 2;
        start_scan(&mut connection, input).unwrap();
        scan_chunk(
            &mut connection,
            DedupScanChunkInput {
                session_id: "scan-1".into(),
                algorithm_version: "v1".into(),
                checkpoint: 2,
                archives: vec![
                    DedupArchiveSnapshotInput {
                        archive_id: "a".into(),
                        path: "/a".into(),
                        title: None,
                        page_count: None,
                        size: None,
                        feature_version: "v1".into(),
                    },
                    DedupArchiveSnapshotInput {
                        archive_id: "b".into(),
                        path: "/b".into(),
                        title: None,
                        page_count: None,
                        size: None,
                        feature_version: "v1".into(),
                    },
                ],
                pairs: vec![DedupPairInput {
                    left_archive_id: "a".into(),
                    right_archive_id: "b".into(),
                    source: "image".into(),
                    diagnostics: None,
                }],
                selected_archive_ids: vec!["a".into()],
            },
        )
        .unwrap();

        let result = delete_selected(
            &mut connection,
            DedupDeleteSelectedInput {
                session_id: "scan-1".into(),
                outcomes: vec![DedupDeletionOutcomeInput {
                    archive_id: "a".into(),
                    deleted: false,
                    message: Some("server refused".into()),
                }],
            },
        )
        .unwrap();
        assert_eq!(
            result.outcomes,
            vec![DedupDeletionOutcome {
                archive_id: "a".into(),
                deleted: false,
                message: Some("server refused".into())
            }]
        );
    }

    #[test]
    fn repeated_import_has_one_active_normalized_relation() {
        let mut connection = connection();
        let input = DedupImportInput {
            scope_id: "server-a".into(),
            pairs: vec![DedupPairInput {
                left_archive_id: "b".into(),
                right_archive_id: "a".into(),
                source: "import".into(),
                diagnostics: None,
            }],
        };
        import_readoshi(&mut connection, input.clone()).unwrap();
        import_readoshi(&mut connection, input).unwrap();
        let count: i64 = connection.query_row("SELECT COUNT(*) FROM dedup_non_duplicates WHERE scope_id='server-a' AND pair_key='a|b' AND tombstoned=0", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn changing_scope_restarts_a_session_even_when_the_algorithm_is_unchanged() {
        let mut connection = connection();
        start_scan(&mut connection, scan_input("v1")).unwrap();
        scan_chunk(
            &mut connection,
            DedupScanChunkInput {
                session_id: "scan-1".into(),
                algorithm_version: "v1".into(),
                checkpoint: 1,
                archives: vec![DedupArchiveSnapshotInput {
                    archive_id: "a".into(),
                    path: "/a".into(),
                    title: None,
                    page_count: None,
                    size: None,
                    feature_version: "v1".into(),
                }],
                pairs: vec![],
                selected_archive_ids: vec!["a".into()],
            },
        )
        .unwrap();
        let mut restarted = scan_input("v1");
        restarted.scope_id = "server-b".into();
        start_scan(&mut connection, restarted).unwrap();
        let state: (String, i64, i64) = connection.query_row("SELECT scope_id, checkpoint, (SELECT COUNT(*) FROM dedup_archive_snapshots) FROM dedup_sessions WHERE id='scan-1'", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap();
        assert_eq!(state, ("server-b".into(), 0, 0));
    }

    #[test]
    fn deletion_requires_a_completed_scan_with_a_monotonic_checkpoint() {
        let mut connection = connection();
        start_scan(&mut connection, scan_input("v1")).unwrap();
        scan_chunk(
            &mut connection,
            DedupScanChunkInput {
                session_id: "scan-1".into(),
                algorithm_version: "v1".into(),
                checkpoint: 2,
                archives: vec![
                    DedupArchiveSnapshotInput {
                        archive_id: "a".into(),
                        path: "/a".into(),
                        title: None,
                        page_count: None,
                        size: None,
                        feature_version: "v1".into(),
                    },
                    DedupArchiveSnapshotInput {
                        archive_id: "b".into(),
                        path: "/b".into(),
                        title: None,
                        page_count: None,
                        size: None,
                        feature_version: "v1".into(),
                    },
                ],
                pairs: vec![DedupPairInput {
                    left_archive_id: "a".into(),
                    right_archive_id: "b".into(),
                    source: "image".into(),
                    diagnostics: None,
                }],
                selected_archive_ids: vec!["a".into()],
            },
        )
        .unwrap();
        assert_eq!(
            scan_chunk(
                &mut connection,
                DedupScanChunkInput {
                    session_id: "scan-1".into(),
                    algorithm_version: "v1".into(),
                    checkpoint: 1,
                    archives: vec![],
                    pairs: vec![],
                    selected_archive_ids: vec!["a".into()]
                }
            )
            .unwrap_err(),
            "Dedup checkpoint regressed"
        );

        let mut incomplete = scan_input("v1");
        incomplete.session_id = "scan-2".into();
        incomplete.archive_count = 2;
        start_scan(&mut connection, incomplete).unwrap();
        scan_chunk(
            &mut connection,
            DedupScanChunkInput {
                session_id: "scan-2".into(),
                algorithm_version: "v1".into(),
                checkpoint: 1,
                archives: vec![DedupArchiveSnapshotInput {
                    archive_id: "c".into(),
                    path: "/c".into(),
                    title: None,
                    page_count: None,
                    size: None,
                    feature_version: "v1".into(),
                }],
                pairs: vec![],
                selected_archive_ids: vec!["c".into()],
            },
        )
        .unwrap();
        assert_eq!(
            delete_selected(
                &mut connection,
                DedupDeleteSelectedInput {
                    session_id: "scan-2".into(),
                    outcomes: vec![]
                }
            )
            .unwrap_err(),
            "Dedup scan is not complete"
        );
    }

    #[test]
    fn chunks_reject_incompatible_features_and_phantom_pairs() {
        let mut connection = connection();
        start_scan(&mut connection, scan_input("v2")).unwrap();
        assert_eq!(
            scan_chunk(
                &mut connection,
                DedupScanChunkInput {
                    session_id: "scan-1".into(),
                    algorithm_version: "v2".into(),
                    checkpoint: 1,
                    archives: vec![DedupArchiveSnapshotInput {
                        archive_id: "a".into(),
                        path: "/a".into(),
                        title: None,
                        page_count: None,
                        size: None,
                        feature_version: "v1".into()
                    }],
                    pairs: vec![],
                    selected_archive_ids: vec![]
                }
            )
            .unwrap_err(),
            "Dedup feature version changed"
        );
        assert_eq!(
            scan_chunk(
                &mut connection,
                DedupScanChunkInput {
                    session_id: "scan-1".into(),
                    algorithm_version: "v2".into(),
                    checkpoint: 1,
                    archives: vec![DedupArchiveSnapshotInput {
                        archive_id: "a".into(),
                        path: "/a".into(),
                        title: None,
                        page_count: None,
                        size: None,
                        feature_version: "v2".into()
                    }],
                    pairs: vec![DedupPairInput {
                        left_archive_id: "a".into(),
                        right_archive_id: "b".into(),
                        source: "image".into(),
                        diagnostics: None
                    }],
                    selected_archive_ids: vec![]
                }
            )
            .unwrap_err(),
            "Dedup pair references an absent archive"
        );
    }

    #[test]
    fn successful_deletions_are_excluded_from_later_component_revalidation() {
        let mut connection = connection();
        let mut input = scan_input("v1");
        input.archive_count = 2;
        start_scan(&mut connection, input).unwrap();
        scan_chunk(
            &mut connection,
            DedupScanChunkInput {
                session_id: "scan-1".into(),
                algorithm_version: "v1".into(),
                checkpoint: 2,
                archives: vec![
                    DedupArchiveSnapshotInput {
                        archive_id: "a".into(),
                        path: "/a".into(),
                        title: None,
                        page_count: None,
                        size: None,
                        feature_version: "v1".into(),
                    },
                    DedupArchiveSnapshotInput {
                        archive_id: "b".into(),
                        path: "/b".into(),
                        title: None,
                        page_count: None,
                        size: None,
                        feature_version: "v1".into(),
                    },
                ],
                pairs: vec![DedupPairInput {
                    left_archive_id: "a".into(),
                    right_archive_id: "b".into(),
                    source: "image".into(),
                    diagnostics: None,
                }],
                selected_archive_ids: vec!["a".into()],
            },
        )
        .unwrap();
        delete_selected(
            &mut connection,
            DedupDeleteSelectedInput {
                session_id: "scan-1".into(),
                outcomes: vec![DedupDeletionOutcomeInput {
                    archive_id: "a".into(),
                    deleted: true,
                    message: None,
                }],
            },
        )
        .unwrap();
        connection
            .execute("DELETE FROM dedup_selection WHERE session_id='scan-1'", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO dedup_selection (session_id,archive_id) VALUES ('scan-1','b')",
                [],
            )
            .unwrap();
        let result = delete_selected(
            &mut connection,
            DedupDeleteSelectedInput {
                session_id: "scan-1".into(),
                outcomes: vec![],
            },
        )
        .unwrap();
        assert_eq!(result.rejected_archive_ids, vec!["b"]);
    }

    struct FakeCovers {
        cached: BTreeMap<String, Vec<u8>>,
        downloaded: BTreeMap<String, Vec<u8>>,
        fetches: Vec<String>,
    }

    impl DedupCoverSource for FakeCovers {
        fn cached_cover(&mut self, archive_id: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self.cached.get(archive_id).cloned())
        }
        fn download_cover(&mut self, archive_id: &str) -> Result<Vec<u8>, String> {
            self.fetches.push(archive_id.to_string());
            self.downloaded
                .get(archive_id)
                .cloned()
                .ok_or_else(|| "missing".into())
        }
    }

    fn test_png() -> Vec<u8> {
        use image::ImageEncoder;
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&[0, 255, 128, 64], 2, 2, image::ExtendedColorType::L8)
            .expect("encode png");
        bytes
    }

    #[test]
    fn cached_cover_scan_is_bounded_and_repeated_scan_has_zero_fetches() {
        let archives = vec![
            DedupScanArchive {
                archive_id: "a".into(),
                path: "a.cbz".into(),
                title: Some("A".into()),
                filename: "same.cbz".into(),
                page_count: Some(1),
                size: Some(1),
            },
            DedupScanArchive {
                archive_id: "b".into(),
                path: "b.cbz".into(),
                title: Some("B".into()),
                filename: "same.cbz".into(),
                page_count: Some(1),
                size: Some(1),
            },
        ];
        let image = test_png();
        let mut source = FakeCovers {
            cached: BTreeMap::from([("a".into(), image.clone()), ("b".into(), image)]),
            downloaded: BTreeMap::new(),
            fetches: vec![],
        };
        let first = execute_cached_cover_scan("scope-a", "v1", &archives, 1, &mut source, || false);
        assert_eq!(
            (
                first.processed,
                first.total,
                first.cache_hits,
                first.downloads,
                first.pair_count
            ),
            (2, 2, 2, 0, 1)
        );
        let second =
            execute_cached_cover_scan("scope-a", "v1", &archives, 1, &mut source, || false);
        assert_eq!(second.cache_hits, 2);
        assert!(source.fetches.is_empty());
        assert_eq!(first.pairs[0].source, "image");
    }

    #[test]
    fn missing_and_corrupt_covers_degrade_without_aborting_and_cancel_preserves_checkpoint() {
        let archives = vec![
            DedupScanArchive {
                archive_id: "a".into(),
                path: "a.cbz".into(),
                title: None,
                filename: "a.cbz".into(),
                page_count: None,
                size: None,
            },
            DedupScanArchive {
                archive_id: "b".into(),
                path: "b.cbz".into(),
                title: None,
                filename: "b.cbz".into(),
                page_count: None,
                size: None,
            },
            DedupScanArchive {
                archive_id: "c".into(),
                path: "c.cbz".into(),
                title: None,
                filename: "c.cbz".into(),
                page_count: None,
                size: None,
            },
        ];
        let mut source = FakeCovers {
            cached: BTreeMap::new(),
            downloaded: BTreeMap::from([("a".into(), b"".to_vec())]),
            fetches: vec![],
        };
        let mut calls = 0;
        let result = execute_cached_cover_scan("scope-a", "v1", &archives, 2, &mut source, || {
            calls += 1;
            calls > 1
        });
        assert_eq!(result.status, "cancelled");
        assert_eq!(result.checkpoint, 2);
        assert!(result.degraded);
        assert!(result.missing_covers + result.invalid_covers > 0);
    }

    #[test]
    fn decoded_cover_signature_rejects_invalid_bytes() {
        assert!(decoded_cover_signature(b"not an image").is_err());
    }

    #[test]
    fn decoded_cover_signature_rejects_low_information_images() {
        use image::ImageEncoder;
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&[128; 4], 2, 2, image::ExtendedColorType::L8)
            .unwrap();
        assert!(decoded_cover_signature(&bytes).is_err());
    }

    #[test]
    fn persisted_feature_reuses_only_matching_version_and_content_hash() {
        let connection = connection();
        let archive = DedupScanArchive {
            archive_id: "a".into(),
            path: "a".into(),
            title: None,
            filename: "a".into(),
            page_count: None,
            size: None,
        };
        let bytes = test_png();
        assert!(
            !load_or_compute_feature(&connection, "scope", &archive, "v1", &bytes)
                .unwrap()
                .1
        );
        assert!(
            load_or_compute_feature(&connection, "scope", &archive, "v1", &bytes)
                .unwrap()
                .1
        );
        assert!(
            !load_or_compute_feature(&connection, "scope", &archive, "v2", &bytes)
                .unwrap()
                .1
        );
        let mut changed = bytes;
        changed.push(0);
        assert!(
            !load_or_compute_feature(&connection, "scope", &archive, "v2", &changed)
                .unwrap()
                .1
        );
    }

    #[test]
    fn non_duplicate_marks_write_a_sync_journal_entry() {
        // 标记与取消都要能跨设备：写一条 dedup_non_duplicate 日志，时钟取表里那一行，
        // 取消时 tombstoned=true。以前这两处一笔都不记，结论只留在本机。
        let mut connection = connection();
        save_non_duplicate(
            &mut connection,
            DedupNonDuplicateInput {
                scope_id: "server-a".into(),
                left_archive_id: "a".into(),
                right_archive_id: "b".into(),
            },
        )
        .unwrap();
        let (object_type, tombstoned, clock): (String, i64, i64) = connection
            .query_row(
                "SELECT sj.object_type,
                        CASE WHEN dnd.tombstoned = 1 THEN 1 ELSE 0 END,
                        sj.logical_clock
                 FROM sync_journal sj
                 JOIN dedup_non_duplicates dnd
                   ON dnd.scope_id = sj.scope_id AND sj.object_id = dnd.scope_id || '/' || dnd.pair_key
                 ORDER BY sj.sequence DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("journal row");
        assert_eq!(object_type, "dedup_non_duplicate");
        assert_eq!(tombstoned, 0);
        assert_eq!(clock, 1);

        remove_non_duplicate(
            &mut connection,
            DedupNonDuplicateInput {
                scope_id: "server-a".into(),
                left_archive_id: "a".into(),
                right_archive_id: "b".into(),
            },
        )
        .unwrap();
        let (tombstoned, clock): (i64, i64) = connection
            .query_row(
                "SELECT CASE WHEN dnd.tombstoned = 1 THEN 1 ELSE 0 END, sj.logical_clock
                 FROM sync_journal sj
                 JOIN dedup_non_duplicates dnd
                   ON dnd.scope_id = sj.scope_id AND sj.object_id = dnd.scope_id || '/' || dnd.pair_key
                 ORDER BY sj.sequence DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("removal journal row");
        assert_eq!(tombstoned, 1);
        assert_eq!(clock, 2, "改动一次时钟 +1，远端抢占比较才有依据");
    }

    #[test]
    fn bounded_pair_builder_filters_persisted_non_duplicates() {
        let mut connection = connection();
        let mut input = scan_input("v1");
        input.archive_count = 2;
        start_scan(&mut connection, input).unwrap();
        let image = test_png();
        for archive_id in ["a", "b"] {
            let archive = DedupScanArchive {
                archive_id: archive_id.into(),
                path: archive_id.into(),
                title: Some("same".into()),
                filename: "same".into(),
                page_count: Some(1),
                size: Some(4),
            };
            load_or_compute_feature(&connection, "server-a", &archive, "v1", &image).unwrap();
        }
        scan_chunk(
            &mut connection,
            DedupScanChunkInput {
                session_id: "scan-1".into(),
                algorithm_version: "v1".into(),
                checkpoint: 2,
                archives: ["a", "b"]
                    .into_iter()
                    .map(|archive_id| DedupArchiveSnapshotInput {
                        archive_id: archive_id.into(),
                        path: archive_id.into(),
                        title: Some("same".into()),
                        page_count: Some(1),
                        size: Some(4),
                        feature_version: "v1".into(),
                    })
                    .collect(),
                pairs: vec![],
                selected_archive_ids: vec![],
            },
        )
        .unwrap();
        assert_eq!(
            build_pairs_bounded(&mut connection, "scan-1", "server-a", "v1")
                .unwrap()
                .len(),
            1
        );
        save_non_duplicate(
            &mut connection,
            DedupNonDuplicateInput {
                scope_id: "server-a".into(),
                left_archive_id: "a".into(),
                right_archive_id: "b".into(),
            },
        )
        .unwrap();
        assert!(
            build_pairs_bounded(&mut connection, "scan-1", "server-a", "v1")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn date_bounds_are_inclusive_and_reject_invalid_dates() {
        assert_eq!(date_to_epoch(Some("1970-01-01"), false).unwrap(), Some(0));
        assert_eq!(
            date_to_epoch(Some("1970-01-01"), true).unwrap(),
            Some(86_399)
        );
        assert!(date_to_epoch(Some("2026/01/01"), false).is_err());
    }

    #[test]
    fn archive_enumeration_resolves_scope_and_pages_non_deleted_ids_stably() {
        let connection = connection();
        connection.execute_batch(
            "CREATE TABLE servers (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL);
             CREATE TABLE archives (server_id TEXT, archive_id TEXT, title TEXT, page_count INTEGER, file_size INTEGER, metadata_revision INTEGER, tags_json TEXT, is_deleted INTEGER);
             INSERT INTO servers VALUES ('server-row','scope-a');
             INSERT INTO archives VALUES
               ('server-row','b','B',1,2,1,'[]',0),
               ('server-row','a','A',1,2,1,'[]',0),
               ('server-row','gone','Gone',1,2,1,'[]',1);",
        ).unwrap();
        assert_eq!(
            resolve_scan_scope(&connection, "scope-a").unwrap(),
            ("server-row".into(), "scope-a".into())
        );
        assert_eq!(
            count_scan_archives(&connection, "server-row", i64::MIN / 2, i64::MAX / 2).unwrap(),
            2
        );
        assert_eq!(
            enumerate_scan_archives(&connection, "server-row", i64::MIN / 2, i64::MAX / 2, 0, 1)
                .unwrap()[0]
                .archive_id,
            "a"
        );
        assert_eq!(
            enumerate_scan_archives(&connection, "server-row", i64::MIN / 2, i64::MAX / 2, 1, 1)
                .unwrap()[0]
                .archive_id,
            "b"
        );
    }

    #[test]
    fn normalized_filename_matches_readoshi_semantics() {
        // 发布标记、语言括号、重复导入后缀全部剥掉。
        assert_eq!(normalized_filename("[中国翻訳] Grotesque (chinese)_g12.ZIP"), normalized_filename("grotesque"));
        assert_eq!(normalized_filename("[DL版][無修正] Foo"), normalized_filename("foo"));
        assert_eq!(normalized_filename("[Uncensored] Bar"), normalized_filename("bar"));
        // NFKC：全角拉丁与半角等同。
        assert_eq!(normalized_filename("Ｆｏｏ　Ｂａｒ"), normalized_filename("foobar"));
        // 实体反转义。
        assert_eq!(normalized_filename("a &amp; b"), normalized_filename("ab"));
        // 不匹配的括号内容保留。
        assert_eq!(normalized_filename("[同人] title"), normalized_filename("同人title"));
    }

    #[test]
    fn filename_similarity_only_judges_inside_the_gates() {
        let long_a = "grotesque-combination-2026".to_string();
        let long_b = "grotesque-combination-2027".to_string();
        // 26 字符、单字符差 → 相似度远超 0.92。
        assert!(filename_similarity(&long_a, &long_b) >= 0.92);
        // 短于 16 字符不参与相似判定。
        assert_eq!(filename_similarity("short-name", "short-name2"), 0.0);
        // 前后缀都不同直接 0。
        assert_eq!(filename_similarity("completely-different-alpha", "other-kind-of-title-x"), 0.0);
    }

    fn signature_with_luminance(luminance: Vec<u8>, dominant_fraction: f64) -> StoredImageSignature {
        let mean = luminance.iter().map(|value| f64::from(*value)).sum::<f64>()
            / luminance.len().max(1) as f64;
        let standard_deviation = (luminance
            .iter()
            .map(|value| (f64::from(*value) - mean).powi(2))
            .sum::<f64>()
            / luminance.len().max(1) as f64)
            .sqrt();
        StoredImageSignature {
            ratio: 1.0,
            luminance,
            mean,
            standard_deviation,
            dominant_fraction,
            perceptual_hash: vec![0_u8; 8],
        }
    }

    fn solid_signature(mean: u8) -> StoredImageSignature {
        signature_with_luminance(vec![mean; SIGNATURE_GRID * SIGNATURE_GRID], 1.0)
    }

    /// 带少量结构（非均匀）的主导色封面：dominant ≥0.75 触发主导色门，但不触发均匀门。
    fn dominant_signature() -> StoredImageSignature {
        let mut luminance = vec![64_u8; SIGNATURE_GRID * SIGNATURE_GRID];
        // 每 8 个像素放一个亮点：标准差 > 4 且非均匀（dominant < 0.98）。
        for (index, value) in luminance.iter_mut().enumerate() {
            if index % 8 == 0 {
                *value = 200;
            }
        }
        signature_with_luminance(luminance, 0.9)
    }

    /// 确定性纹理（伪随机但可复现）：块与块之间差异充分，避免夹具退化成
    /// 「纯色可平均」的退化形态。
    fn texture_luminance(seed: u32) -> Vec<u8> {
        let seed = seed as usize;
        (0..(SIGNATURE_GRID * SIGNATURE_GRID))
            .map(|index| {
                let mixed = index
                    .wrapping_mul(37)
                    .wrapping_add(seed.wrapping_mul(263))
                    .wrapping_mul(7);
                (mixed % 251) as u8
            })
            .collect()
    }

    /// 测试辅助：从 32×32 网格下采样出 9×8 缩略亮度，再求梯度 dhash
    /// （真实路径里由 decoded_cover_signature 用 image crate 缩放完成）。
    fn downsample_dhash(luminance: &[u8]) -> [u8; 8] {
        let thumbnail: Vec<u8> = (0..8)
            .flat_map(|row| {
                (0..9).map(move |column| luminance[row * 4 * SIGNATURE_GRID + (column * 32 / 9)])
            })
            .collect();
        gradient_dhash(&thumbnail)
    }

    #[test]
    fn label_variant_still_duplicates_where_a_global_ratio_would_miss() {
        // 左：纹理封面。右：同一封面底部 8 行（25%）被一条实色翻译标签覆盖。
        // 全局 changed_ratio = 0.25 ≥ 0.2 的旧算法会漏掉；块级证据只有 2 排
        // 区块被污染，48/64 匹配 → Wilson 下界仍过阈 → 判重。
        let left_luminance = texture_luminance(7);
        let mut right_luminance = left_luminance.clone();
        let label_start = SIGNATURE_GRID * (SIGNATURE_GRID - 8);
        for value in &mut right_luminance[label_start..] {
            *value = 255;
        }
        let mut left = signature_with_luminance(left_luminance, 0.2);
        left.perceptual_hash = downsample_dhash(&left.luminance).to_vec();
        let mut right = signature_with_luminance(right_luminance, 0.2);
        right.perceptual_hash = downsample_dhash(&right.luminance).to_vec();
        let hash_distance: u32 = left
            .perceptual_hash
            .iter()
            .zip(&right.perceptual_hash)
            .map(|(left, right)| u32::from((left ^ right).count_ones()))
            .sum();
        assert!(hash_distance <= DHASH_PRESCREEN_HAMMING, "标签变体应通过 dhash 预筛");
        assert!(
            are_signatures_duplicate(&left, &right, (Some(10), Some(100)), (Some(10), Some(100)), &SignatureComparisonOptions::default()).is_some(),
            "25% 翻译标签不应让重复封面被漏掉"
        );
    }

    #[test]
    fn small_crop_variant_still_matches_through_the_offset_search() {
        // 右图顶部裁掉 1 行后重新缩放回 32×32（内容整体上移 1 行）：±1 对齐
        // 搜索找回匹配。
        let left_luminance = texture_luminance(11);
        let right_luminance = {
            let mut shifted = left_luminance.clone();
            shifted.copy_within(SIGNATURE_GRID.., 0);
            shifted
        };
        let mut left = signature_with_luminance(left_luminance, 0.2);
        left.perceptual_hash = downsample_dhash(&left.luminance).to_vec();
        let mut right = signature_with_luminance(right_luminance, 0.2);
        right.perceptual_hash = downsample_dhash(&right.luminance).to_vec();
        assert!(
            are_signatures_duplicate(&left, &right, (Some(10), Some(100)), (Some(10), Some(100)), &SignatureComparisonOptions::default()).is_some(),
            "1 行小裁剪应通过对齐搜索判重"
        );
    }

    #[test]
    fn same_series_different_volume_is_not_matched() {
        // 同系列不同卷：构图骨架相近但内容差异贯穿大多数区块 → 匹配块不足半数
        // 且 Wilson 下界过低 → 不判重。
        let left = signature_with_luminance(texture_luminance(7), 0.3);
        let right = signature_with_luminance(texture_luminance(89), 0.3);
        assert_eq!(
            are_signatures_duplicate(&left, &right, (Some(10), Some(100)), (Some(10), Some(100)), &SignatureComparisonOptions::default()),
            None
        );
    }

    #[test]
    fn gradient_dhash_encodes_row_wise_luminance_ramp() {
        // 9×8 的左暗右亮梯度：每行 8 位全为 1；反转则全为 0。
        let ascending: Vec<u8> = (0..8)
            .flat_map(|row| (0..9).map(move |column| (column * 28) as u8))
            .collect();
        assert_eq!(gradient_dhash(&ascending), [0xff_u8; 8]);
        let descending: Vec<u8> = ascending.iter().rev().copied().collect();
        assert_eq!(gradient_dhash(&descending), [0x00_u8; 8]);
    }

    #[test]
    fn dhash_prescreen_rejects_unrelated_covers_before_the_expensive_pass() {
        // 亮度完全不同的两张封面：形状/纹理门都放行，但梯度哈希汉明距离远超
        // 预筛阈值 → 不进入块级精评。
        let mut left = signature_with_luminance(texture_luminance(21), 0.3);
        left.perceptual_hash = vec![0x00; 8];
        let mut right = signature_with_luminance(texture_luminance(77), 0.3);
        right.perceptual_hash = vec![0xff; 8];
        let entry = |signature: StoredImageSignature| {
            ScanEntry::new(
                "a".into(),
                String::new(),
                Some(10),
                Some(100),
                None,
                Some(signature),
            )
        };
        assert_eq!(
            pair_image_match(&entry(left), &entry(right), FilenameEvidence::None, 0, &SignatureComparisonOptions::default()),
            None
        );
    }


    #[test]
    fn shape_mismatch_gates_reject_page_and_size_outliers() {
        let left = dominant_signature();
        let right = dominant_signature();
        let widened = image_comparison_options(FilenameEvidence::Exact, 2, &SignatureComparisonOptions::default());
        // 相同封面但页数失配（10 对 20：比 2.0 > 1.65、差 10 ≥ 8）→ 拒绝。
        assert_eq!(
            are_signatures_duplicate(&left, &right, (Some(10), Some(100)), (Some(20), Some(100)), &widened),
            None
        );
        // 体积失配（1MB 对 3MB）同样拒绝。
        assert_eq!(
            are_signatures_duplicate(&left, &right, (Some(10), Some(1_000_000)), (Some(10), Some(3_000_000)), &widened),
            None
        );
        // 形状一致时判重。
        assert!(are_signatures_duplicate(&left, &right, (Some(10), Some(100)), (Some(10), Some(100)), &widened).is_some());
    }

    #[test]
    fn filename_evidence_only_relaxes_the_low_information_gate() {
        let options = image_comparison_options(FilenameEvidence::Similar, 1, &SignatureComparisonOptions::default());
        assert!(options.allow_low_information_match);
        assert!(!SignatureComparisonOptions::default().allow_low_information_match);
    }

    #[test]
    fn exact_filename_pairs_require_at_most_two_copies() {
        let name = "grotesque-combination-2026";
        let snapshot = |archive_id: &str| DedupArchiveSnapshotInput {
            archive_id: archive_id.into(),
            path: archive_id.into(),
            title: Some(name.into()),
            page_count: Some(10),
            size: Some(1_000_000),
            feature_version: "v1".into(),
        };
        // 场景一：三个同名档案，模板名防互配门不产生任何文件名配对。
        let mut connection = connection();
        let mut input = scan_input("v1");
        input.archive_count = 3;
        start_scan(&mut connection, input).unwrap();
        scan_chunk(
            &mut connection,
            DedupScanChunkInput {
                session_id: "scan-1".into(),
                algorithm_version: "v1".into(),
                checkpoint: 3,
                archives: vec![snapshot("a"), snapshot("b"), snapshot("c")],
                pairs: vec![],
                selected_archive_ids: vec![],
            },
        )
        .unwrap();
        let pairs = build_pairs_bounded(&mut connection, "scan-1", "server-a", "v1")
            .expect("pairs");
        assert!(pairs.is_empty());
        // 场景二：两个同名档案 → 一个文件名配对（独立会话）。
        let mut input = scan_input("v1");
        input.session_id = "scan-2".into();
        input.archive_count = 2;
        start_scan(&mut connection, input).unwrap();
        scan_chunk(
            &mut connection,
            DedupScanChunkInput {
                session_id: "scan-2".into(),
                algorithm_version: "v1".into(),
                checkpoint: 2,
                archives: vec![snapshot("a"), snapshot("b")],
                pairs: vec![],
                selected_archive_ids: vec![],
            },
        )
        .unwrap();
        let pairs = build_pairs_bounded(&mut connection, "scan-2", "server-a", "v1")
            .expect("pairs");
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].source, "filename");
    }

    /// 4k 档案 = 8 百万对。旧实现每对都跑一遍 normalized_filename 与
    /// Levenshtein，比较阶段实际跑不完（还要攥着连接锁，界面一起卡死）；
    /// 预筛前置后同样规模应在秒级完成。断言留了很宽的上限，它要拦住的是
    /// 「又退回每对都算字符串相似度」这种回归。
    #[test]
    fn comparing_four_thousand_archives_stays_fast() {
        // 真实的 dhash 之间汉明距离接近随机（64 位里 ~32 位不同），预筛会
        // 淘汰绝大多数组合——用伪随机哈希复刻这个分布，别让测试落在「几乎
        // 每对都过预筛」的人造最坏情况上。
        let hashes: Vec<u8> = (0..4_000 * 8)
            .scan(0x9E37_79B9_7F4A_7C15_u64, |state, _| {
                *state ^= *state << 13;
                *state ^= *state >> 7;
                *state ^= *state << 17;
                Some((*state & 0xff) as u8)
            })
            .collect();
        let entries: Vec<ScanEntry> = (0..4_000)
            .map(|index| {
                let mut signature = solid_signature(30);
                signature.perceptual_hash = hashes[index * 8..index * 8 + 8].to_vec();
                ScanEntry::new(
                    format!("archive-{index:05}"),
                    format!("collection {index:05} — a distinctly titled volume, part {}", index % 97),
                    Some(24),
                    Some(1_000_000),
                    None,
                    Some(signature),
                )
            })
            .collect();
        let started = std::time::Instant::now();
        let pairs = compare_scan_entries(
            &entries,
            &std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
            "v1",
            0,
            |_, _| {},
        )
        .expect("comparison");
        let elapsed = started.elapsed();
        assert!(pairs.is_empty(), "unrelated covers must not pair");
        assert!(
            elapsed < std::time::Duration::from_secs(30),
            "comparison took {elapsed:?}; the per-pair filename similarity is back in the hot path"
        );
    }

    /// 同一张封面挂在页数/体积互相矛盾的档案上 = LRR 的占位图（缩略图还没
    /// 生成时它回的 `no_thumbnail.png`）：这些档案不能因为「封面一模一样」被判
    /// 重复，真重复不会同时相差 354 页和几百 MB。
    #[test]
    fn shared_cover_across_incompatible_shapes_is_treated_as_a_placeholder() {
        let entry = |id: &str, pages: i64, size: i64| {
            ScanEntry::new(
                id.into(),
                format!("{id} title"),
                Some(pages),
                Some(size),
                Some("placeholder-hash".into()),
                Some(solid_signature(30)),
            )
        };
        let mut entries = vec![
            entry("a", 354, 351_502_318),
            entry("b", 39, 25_355_075),
            entry("c", 60, 30_000_000),
        ];
        distrust_placeholder_covers(&mut entries);
        // 整张图都不可信：同一张占位图的所有持有者一起退出封面比较。
        assert!(entries.iter().all(|entry| !entry.cover_trusted));
        assert!(compare_scan_entries(
            &entries,
            &std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
            "v1",
            0,
            |_, _| {},
        )
        .expect("comparison")
        .is_empty());

        // 形状一致时共用封面是真重复，照样判重。
        let mut twins = vec![entry("x", 24, 1_000_000), entry("y", 24, 1_000_000)];
        distrust_placeholder_covers(&mut twins);
        assert!(twins.iter().all(|entry| entry.cover_trusted));
        assert_eq!(
            compare_scan_entries(
                &twins,
                &std::collections::HashMap::new(),
                &std::collections::HashSet::new(),
                "v1",
                0,
                |_, _| {},
            )
            .expect("comparison")
            .len(),
            1
        );
    }

    #[test]
    fn comparison_reports_progress_every_batch() {
        let entries: Vec<ScanEntry> = (0..20)
            .map(|index| {
                ScanEntry::new(
                    format!("archive-{index:02}"),
                    format!("title {index:02} with a long distinct name"),
                    Some(10),
                    Some(1000),
                    None,
                    None,
                )
            })
            .collect();
        let mut seen = Vec::new();
        compare_scan_entries(
            &entries,
            &std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
            "v1",
            5,
            |processed, total| seen.push((processed, total)),
        )
        .expect("comparison");
        // 每批一次，收尾再补一次 (20,20)：批次回调按批走，最后一批往往不满，
        // 少了这次收尾进度条就停在 97% 之类的数字上。
        assert_eq!(seen, vec![(5, 20), (10, 20), (15, 20), (20, 20), (20, 20)]);
    }

    /// 选择集必须能改已完成的会话：载入扫描结果后再勾选，以前会走
    /// scan_chunk 的「运行中」门禁，界面只报一句 not running。
    #[test]
    fn selection_can_be_edited_after_the_session_completed() {
        let mut connection = connection();
        let mut input = scan_input("v1");
        input.archive_count = 2;
        start_scan(&mut connection, input).unwrap();
        let snapshot = |archive_id: &str| DedupArchiveSnapshotInput {
            archive_id: archive_id.into(),
            path: format!("{archive_id}.cbz"),
            title: Some(archive_id.into()),
            page_count: Some(10),
            size: Some(1_000_000),
            feature_version: "v1".into(),
        };
        scan_chunk(
            &mut connection,
            DedupScanChunkInput {
                session_id: "scan-1".into(),
                algorithm_version: "v1".into(),
                checkpoint: 2,
                archives: vec![snapshot("a"), snapshot("b")],
                pairs: vec![],
                selected_archive_ids: vec![],
            },
        )
        .unwrap();
        let status: String = connection
            .query_row("SELECT status FROM dedup_sessions WHERE id='scan-1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(status, "completed");
        // 已完成的会话照样能改选择。
        save_selection(&mut connection, "scan-1", &["b".into()]).expect("selection saved");
        let selected = load_result(&connection, "scan-1").unwrap().selected_archive_ids;
        assert_eq!(selected, vec!["b".to_string()]);
        // 不在快照里的档案（已删除）拒绝写入。
        assert_eq!(
            save_selection(&mut connection, "scan-1", &["ghost".into()]).unwrap_err(),
            "Selected archive is absent from the persisted scan",
        );
        assert_eq!(
            save_selection(&mut connection, "scan-2", &[]).unwrap_err(),
            "Dedup session not found",
        );
    }

    #[test]
    fn sessions_are_listed_per_scope_and_deleted_with_their_rows() {
        let mut connection = connection();
        start_scan(&mut connection, scan_input("v1")).unwrap();
        let snapshot = |archive_id: &str| DedupArchiveSnapshotInput {
            archive_id: archive_id.into(),
            path: format!("{archive_id}.cbz"),
            title: Some(archive_id.into()),
            page_count: Some(10),
            size: Some(1_000_000),
            feature_version: "v1".into(),
        };
        scan_chunk(
            &mut connection,
            DedupScanChunkInput {
                session_id: "scan-1".into(),
                algorithm_version: "v1".into(),
                checkpoint: 2,
                archives: vec![snapshot("a"), snapshot("b")],
                pairs: vec![DedupPairInput {
                    left_archive_id: "a".into(),
                    right_archive_id: "b".into(),
                    source: "image".into(),
                    diagnostics: None,
                }],
                selected_archive_ids: vec![],
            },
        )
        .unwrap();
        let sessions = list_sessions(&connection, "server-a", 10).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "scan-1");
        assert_eq!((sessions[0].archive_count, sessions[0].pair_count), (3, 1));
        assert!(list_sessions(&connection, "server-b", 10).unwrap().is_empty());
        assert!(!sessions[0].saved, "completed scans must remain working sessions until explicitly saved");
        assert!(list_sessions_filtered(&connection, "server-a", 1, true).unwrap().is_empty());
        assert!(save_session(&connection, "scan-1").is_err(), "a running session cannot be saved");
        connection.execute("UPDATE dedup_sessions SET status='cancelled' WHERE id='scan-1'", []).unwrap();
        save_session(&connection, "scan-1").unwrap();
        assert!(list_sessions(&connection, "server-a", 10).unwrap()[0].saved);
        connection.execute("INSERT INTO dedup_sessions (id,scope_id,algorithm_version,status,saved) VALUES ('zzz','server-a','v1','completed',0)", []).unwrap();
        assert_eq!(list_sessions_filtered(&connection, "server-a", 1, true).unwrap()[0].session_id, "scan-1");
        delete_session(&connection, "zzz").unwrap();
        assert!(save_session(&connection, "missing").is_err());

        delete_session(&connection, "scan-1").unwrap();
        let rows: (i64, i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM dedup_sessions),(SELECT COUNT(*) FROM dedup_pairs),(SELECT COUNT(*) FROM dedup_archive_snapshots)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(rows, (0, 0, 0));
        assert_eq!(delete_session(&connection, "scan-1").unwrap_err(), "Dedup session not found");
    }

    #[test]
    fn scan_progress_registry_keeps_the_latest_snapshot_without_diagnostics() {
        let registry = DedupScanRegistry::default();
        let mut progress = DedupScanProgress {
            session_id: "scan-1".into(),
            scope_id: "server-a".into(),
            status: "running".into(),
            stage: "covers".into(),
            processed: 4,
            total: 10,
            cache_hits: 0,
            downloads: 0,
            missing_covers: 0,
            invalid_covers: 0,
            pair_count: 0,
            degraded: false,
            checkpoint: 4,
            diagnostics: vec!["a: cover missing".into()],
            pairs: vec![],
        };
        registry.publish(&progress);
        progress.processed = 9;
        registry.publish(&progress);
        let seen = registry.read("scan-1").expect("registered session");
        assert_eq!((seen.processed, seen.total), (9, 10));
        // 进度播报每批都发：诊断只留在最终返回值里，避免每批克隆一遍。
        assert!(seen.diagnostics.is_empty());
        assert!(registry.read("scan-2").is_none());
    }

    #[test]
    fn scan_progress_registry_drops_the_oldest_session_instead_of_growing() {
        let registry = DedupScanRegistry::default();
        let progress = |session: usize| DedupScanProgress {
            session_id: format!("scan-{session}"),
            scope_id: "server-a".into(),
            status: "running".into(),
            stage: "covers".into(),
            processed: session as i64,
            total: 100,
            cache_hits: 0,
            downloads: 0,
            missing_covers: 0,
            invalid_covers: 0,
            pair_count: 0,
            degraded: false,
            checkpoint: 0,
            diagnostics: vec![],
            pairs: vec![],
        };
        for session in 0..MAX_TRACKED_SCANS + 8 {
            registry.publish(&progress(session));
        }
        // 会话号是前端给的：表不能只插不删，否则跑过的每个会话都留一条到进程退出。
        assert!(registry.read("scan-0").is_none());
        assert!(registry.read("scan-71").is_some());
        {
            let entries = registry.entries.lock().unwrap();
            assert_eq!(entries.by_session.len(), MAX_TRACKED_SCANS);
            assert_eq!(entries.order.len(), MAX_TRACKED_SCANS);
        }
        // 同一个会话每批都播报：重复发布不该重复占位，也不该把自己顶成新的队首。
        registry.publish(&progress(MAX_TRACKED_SCANS + 7));
        let entries = registry.entries.lock().unwrap();
        assert_eq!(entries.order.len(), MAX_TRACKED_SCANS);
        assert_eq!(entries.order.back().map(String::as_str), Some("scan-71"));
    }
}

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use rusqlite::{params, Connection, OptionalExtension};

#[derive(Clone, Debug)]
pub struct DedupScanArchive {
    pub archive_id: String,
    pub path: String,
    pub title: Option<String>,
    #[cfg(test)]
    pub filename: String,
    pub page_count: Option<i64>,
    pub size: Option<i64>,
}

#[derive(Clone, Debug)]
struct CoverFeature {
    content_hash: String,
    signature: String,
}

#[cfg(test)]
pub trait DedupCoverSource {
    fn cached_cover(&mut self, archive_id: &str) -> Result<Option<Vec<u8>>, String>;
    fn download_cover(&mut self, archive_id: &str) -> Result<Vec<u8>, String>;
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupScanProgress {
    pub session_id: String,
    pub scope_id: String,
    pub status: String,
    pub stage: String,
    pub processed: i64,
    pub total: i64,
    pub cache_hits: i64,
    pub downloads: i64,
    pub missing_covers: i64,
    pub invalid_covers: i64,
    pub pair_count: i64,
    pub degraded: bool,
    pub checkpoint: i64,
    pub diagnostics: Vec<String>,
    pub pairs: Vec<DedupPairInput>,
}

/// 运行中的扫描进度：`dedup_scan` 边跑边更新，前端用 `dedup_scan_progress`
/// 轮询它画进度条。它是运行期状态，不进数据库——数据库里只留会话检查点，
/// 因此进程重启后进度线消失而会话仍可恢复。
///
/// 会话号由前端给，而这张表原先只插不删：每跑完一个会话就留一条进度快照
/// （含标签与检查点）直到进程退出，长时间不重启的机器上只涨不落。这里照
/// `inference::cancel` 的既有范式加一个 FIFO 上限——没有哪台机器会同时轮询
/// 六十几个扫描，超出的按最早发布的先丢，`dedup_scan_progress` 顶多报「没有
/// 这个会话」，前端本来也要处理这种情况（重启就会遇到）。
const MAX_TRACKED_SCANS: usize = 64;

#[derive(Default)]
pub struct DedupScanRegistry {
    entries: std::sync::Mutex<DedupScanEntries>,
}

#[derive(Default)]
struct DedupScanEntries {
    by_session: std::collections::HashMap<String, DedupScanProgress>,
    /// 发布顺序，超限时逐出队首。与 `by_session` 的键集合始终一致。
    order: VecDeque<String>,
}

impl DedupScanRegistry {
    /// 诊断详情与命中对只留在最终返回值里：进度每批都会播报，带上它们等于
    /// 每批克隆一遍可能上千行的列表。
    fn publish(&self, progress: &DedupScanProgress) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        let mut snapshot = progress.clone();
        snapshot.diagnostics = Vec::new();
        snapshot.pairs = Vec::new();
        if !entries.by_session.contains_key(&snapshot.session_id) {
            entries.order.push_back(snapshot.session_id.clone());
        }
        entries.by_session.insert(snapshot.session_id.clone(), snapshot);
        while entries.order.len() > MAX_TRACKED_SCANS {
            if let Some(oldest) = entries.order.pop_front() {
                entries.by_session.remove(&oldest);
            }
        }
    }

    fn read(&self, session_id: &str) -> Option<DedupScanProgress> {
        self.entries.lock().ok()?.by_session.get(session_id).cloned()
    }
}

/// 会话列表行：保存过的扫描结果从数据库读回，供「扫描结果」对话框载入。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupSessionSummary {
    pub session_id: String,
    pub scope_id: String,
    pub status: String,
    pub archive_count: i64,
    pub pair_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub saved: bool,
}

pub fn list_sessions(
    connection: &Connection,
    scope_id: &str,
    limit: i64,
) -> Result<Vec<DedupSessionSummary>, String> {
    list_sessions_filtered(connection, scope_id, limit, false)
}

fn list_sessions_filtered(
    connection: &Connection,
    scope_id: &str,
    limit: i64,
    saved_only: bool,
) -> Result<Vec<DedupSessionSummary>, String> {
    required_text(scope_id)?;
    let mut statement = connection
        .prepare(
            "SELECT s.id,s.scope_id,s.status,s.archive_count,
                    (SELECT COUNT(*) FROM dedup_pairs p WHERE p.session_id=s.id),
                    s.created_at,s.updated_at,s.saved
             FROM dedup_sessions s WHERE s.scope_id=?1 AND (?3=0 OR s.saved=1)
             ORDER BY s.updated_at DESC, s.id DESC LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![scope_id, limit.clamp(1, 200), saved_only], |row| {
            Ok(DedupSessionSummary {
                session_id: row.get(0)?,
                scope_id: row.get(1)?,
                status: row.get(2)?,
                archive_count: row.get(3)?,
                pair_count: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                saved: row.get(7)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

/// 删除一个会话：快照、命中对、选择与删除记录随外键级联一起清掉。
pub fn delete_session(connection: &Connection, session_id: &str) -> Result<(), String> {
    required_text(session_id)?;
    let removed = connection
        .execute("DELETE FROM dedup_sessions WHERE id=?1", [session_id])
        .map_err(|error| error.to_string())?;
    if removed == 0 {
        return Err("Dedup session not found".into());
    }
    Ok(())
}

pub fn save_session(connection: &Connection, session_id: &str) -> Result<(), String> {
    required_text(session_id)?;
    let changed = connection.execute(
        "UPDATE dedup_sessions SET saved=1 WHERE id=?1 AND status != 'running'",
        [session_id],
    ).map_err(|error| error.to_string())?;
    if changed == 0 { return Err("扫描尚未完成或结果不存在".into()); }
    Ok(())
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupScanInput {
    pub session_id: String,
    pub scope_id: String,
    pub algorithm_version: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub chunk_size: Option<usize>,
}

fn resolve_scan_scope(
    connection: &Connection,
    requested: &str,
) -> Result<(String, String), String> {
    connection.query_row(
        "SELECT id,scope_id FROM servers WHERE id=?1 OR scope_id=?1 ORDER BY CASE WHEN id=?1 THEN 0 ELSE 1 END LIMIT 1",
        [requested], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(|error| error.to_string())?.ok_or_else(|| "Dedup server scope not found".into())
}

fn date_to_epoch(value: Option<&str>, end: bool) -> Result<Option<i64>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let mut parts = value.split('-').map(str::parse::<i64>);
    let (year, month, day) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(Ok(year)), Some(Ok(month)), Some(Ok(day)), None)
            if (1..=12).contains(&month) && (1..=31).contains(&day) =>
        {
            (year, month, day)
        }
        _ => return Err("Invalid dedup date range".into()),
    };
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * shifted_month + 2) / 5 + day - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    Ok(Some(days * 86_400 + if end { 86_399 } else { 0 }))
}

const ARCHIVE_DATE_FILTER: &str = "AND (NOT EXISTS (SELECT 1 FROM json_each(a.tags_json) WHERE value LIKE 'date_added:%') OR EXISTS (SELECT 1 FROM json_each(a.tags_json) WHERE value LIKE 'date_added:%' AND CAST(substr(value,12) AS INTEGER)>=?2 AND CAST(substr(value,12) AS INTEGER)<=?3))";

fn count_scan_archives(
    connection: &Connection,
    server_id: &str,
    start: i64,
    end: i64,
) -> Result<i64, String> {
    connection.query_row(&format!("SELECT COUNT(*) FROM archives a WHERE a.server_id=?1 AND a.is_deleted=0 {ARCHIVE_DATE_FILTER}"), params![server_id,start,end], |row| row.get(0)).map_err(|error| error.to_string())
}

fn enumerate_scan_archives(
    connection: &Connection,
    server_id: &str,
    start: i64,
    end: i64,
    offset: i64,
    limit: i64,
) -> Result<Vec<DedupScanArchive>, String> {
    let sql = format!("SELECT a.archive_id,a.title,a.page_count,a.file_size FROM archives a WHERE a.server_id=?1 AND a.is_deleted=0 {ARCHIVE_DATE_FILTER} ORDER BY a.archive_id LIMIT ?4 OFFSET ?5");
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![server_id, start, end, limit, offset], |row| {
            let archive_id: String = row.get(0)?;
            let title: String = row.get(1)?;
            Ok(DedupScanArchive {
                archive_id: archive_id.clone(),
                path: archive_id.clone(),
                #[cfg(test)]
                filename: title.clone(),
                title: Some(title),
                page_count: row.get(2)?,
                size: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

/// 文件名归一化，与 Readoshi 的 normalizeDedupeFilename 逐步对齐：
/// HTML 实体反转义 → NFKC → 小写 → 去压缩扩展名 → 去发布标记（[中国翻訳]/[DL版]/
/// [無修正]/[uncensored] 等）→ 去语言括号 → 去 `_g<数字>` 后缀 → 只留字母数字。
fn normalized_filename(value: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let unescaped = unescape_html_entities(value);
    let normalized: String = unescaped
        .chars()
        .nfkc()
        .collect::<String>()
        .to_lowercase();
    let without_ext = strip_archive_extension(&normalized);
    let without_markers = strip_bracketed_markers(&without_ext, '[', ']');
    let without_language = strip_bracketed_markers(&without_markers, '(', ')');
    let without_revision = strip_gallery_revision_suffix(&without_language);
    without_revision
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect::<String>()
        .trim()
        .to_string()
}

/// `&amp;` 与 `&#38;`/`&#x26;` 家族（大小写与前导零变体）的反转义。
fn unescape_html_entities(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let lower = value.to_lowercase();
    let mut index = 0;
    while index < value.len() {
        if value.as_bytes()[index] == b'&' {
            let lower_rest = &lower[index..];
            let matched = ["&amp;", "&#038;", "&#38;", "&#x26;"]
                .iter()
                .find_map(|entity| lower_rest.starts_with(entity).then_some(entity.len()));
            if let Some(length) = matched {
                output.push('&');
                index += length;
                continue;
            }
        }
        let character = value[index..].chars().next().expect("char boundary");
        output.push(character);
        index += character.len_utf8();
    }
    output
}

fn strip_archive_extension(value: &str) -> &str {
    const EXTENSIONS: [&str; 5] = [".zip", ".rar", ".7z", ".cbz", ".cbr"];
    EXTENSIONS
        .iter()
        .find_map(|extension| value.strip_suffix(extension))
        .unwrap_or(value)
}

/// 去掉内容为发布标记/语言标注的成对括号段；内容不匹配则原样保留。
fn strip_bracketed_markers(value: &str, open: char, close: char) -> String {
    const MARKERS: [&str; 13] = [
        "中国翻訳", "中国翻译", "中国語", "chinese", "中文", "dl版", "dl", "digital", "無修正",
        "无修正", "uncensored", "翻訳", "翻译",
    ];
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(open_offset) = rest.find(open) {
        let Some(close_offset) = rest[open_offset..].find(close) else {
            output.push_str(rest);
            rest = "";
            break;
        };
        let content = &rest[open_offset + open.len_utf8()..open_offset + close_offset];
        let matched = MARKERS
            .iter()
            .any(|marker| content.to_lowercase() == marker.to_lowercase());
        let end = open_offset + close_offset + close.len_utf8();
        // 括号前的文本总是保留；括号段本身只在内容不匹配时保留。
        output.push_str(&rest[..open_offset]);
        if !matched {
            output.push_str(&rest[open_offset..end]);
        }
        rest = &rest[end..];
    }
    output.push_str(rest);
    output
}

/// 去掉结尾的 `_g<数字>`（LANraragi 重复导入的后缀）。
fn strip_gallery_revision_suffix(value: &str) -> &str {
    let trimmed_digits = value.trim_end_matches(|character: char| character.is_ascii_digit());
    if trimmed_digits.len() < value.len() && trimmed_digits.ends_with("_g") {
        &value[..trimmed_digits.len() - 2]
    } else {
        value
    }
}

/// Readoshi 的 filenameSimilarity：门限之外直接 0；门限内按 Levenshtein 给相似度。
fn filename_similarity(left: &str, right: &str) -> f64 {
    let left: Vec<char> = left.chars().collect();
    let right: Vec<char> = right.chars().collect();
    if left.is_empty() || right.is_empty() || left.len() < 16 || right.len() < 16 {
        return 0.0;
    }
    let max_length = left.len().max(right.len());
    if (left.len() as i64 - right.len() as i64).unsigned_abs() as f64 / max_length as f64 > 0.2
        || max_length > 180
    {
        return 0.0;
    }
    let shared_prefix = left[..4] == right[..4];
    let shared_suffix = left[left.len() - 4..] == right[right.len() - 4..];
    if !shared_prefix && !shared_suffix {
        return 0.0;
    }
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    for left_index in 1..=left.len() {
        let mut diagonal = previous[0];
        previous[0] = left_index;
        for right_index in 1..=right.len() {
            let above = previous[right_index];
            previous[right_index] = (previous[right_index] + 1)
                .min(previous[right_index - 1] + 1)
                .min(diagonal + usize::from(left[left_index - 1] != right[right_index - 1]));
            diagonal = above;
        }
    }
    1.0 - previous[right.len()] as f64 / max_length as f64
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum FilenameEvidence {
    /// 完全同名且足够长（≥12）：除了直接判重复，还放宽比较参数。
    Exact,
    /// 相似度 ≥0.92：只放宽图像比较参数。
    Similar,
    None,
}

/// 名字证据只吃装载时算好的归一化名：同名判定是一次字符串比较，相似度
/// （Levenshtein）才是贵的那一步，所以调用点先过 dhash 预筛再调它。
fn filename_evidence(left: &ScanEntry, right: &ScanEntry) -> FilenameEvidence {
    if !left.normalized_name.is_empty() && left.normalized_name == right.normalized_name {
        return if left.name_chars >= 12 {
            FilenameEvidence::Exact
        } else {
            FilenameEvidence::None
        };
    }
    if names_may_be_similar(&left.normalized_name, &right.normalized_name)
        && filename_similarity(&left.normalized_name, &right.normalized_name) >= 0.92
    {
        FilenameEvidence::Similar
    } else {
        FilenameEvidence::None
    }
}

/// `filename_similarity` 的前置门，跑在它分配字符向量之前：相似度本身要求
/// 前四个或后四个字符相同，字节级判断是同一条件的必要条件（相同字符的
/// UTF-8 编码相同），所以这里拒绝掉的组合，相似度一定也是 0。
fn names_may_be_similar(left: &str, right: &str) -> bool {
    if left.len() < 16 || right.len() < 16 {
        return false;
    }
    let (left_bytes, right_bytes) = (left.as_bytes(), right.as_bytes());
    left_bytes[..4] == right_bytes[..4]
        || left_bytes[left_bytes.len() - 4..] == right_bytes[right_bytes.len() - 4..]
}

/// dhash 预筛：只有两侧都有签名且汉明距离在阈值内，这一对才可能判重。
/// 预计算好的名字与哈希让它在循环里只做异或与位计数。
fn signature_prescreen_passes(left: &ScanEntry, right: &ScanEntry) -> bool {
    if !left.cover_trusted || !right.cover_trusted {
        return false;
    }
    let (Some(left_signature), Some(right_signature)) = (left.signature.as_ref(), right.signature.as_ref()) else {
        return false;
    };
    let hash_distance: u32 = left_signature
        .perceptual_hash
        .iter()
        .zip(&right_signature.perceptual_hash)
        .map(|(left, right)| u32::from((left ^ right).count_ones()))
        .sum();
    hash_distance <= DHASH_PRESCREEN_HAMMING
}

/// 页数/体积失配门槛（Readoshi 的 archiveShapeMismatch）：页数比 > limit 且
/// 差 ≥ delta 视为形状不一致，不能算重复；体积同理。
fn archive_shape_mismatch(
    left: (Option<i64>, Option<i64>),
    right: (Option<i64>, Option<i64>),
    page_count_ratio_limit: f64,
    minimum_page_count_delta: i64,
    file_size_ratio_limit: f64,
    minimum_file_size_delta: i64,
) -> bool {
    let (left_pages, left_size) = left;
    let (right_pages, right_size) = right;
    if let (Some(left_pages), Some(right_pages)) = (left_pages, right_pages) {
        if left_pages > 0 && right_pages > 0 {
            let smaller = left_pages.min(right_pages);
            let larger = left_pages.max(right_pages);
            if larger - smaller >= minimum_page_count_delta
                && larger as f64 / smaller as f64 > page_count_ratio_limit
            {
                return true;
            }
        }
    }
    if let (Some(left_size), Some(right_size)) = (left_size, right_size) {
        if left_size > 0 && right_size > 0 {
            let smaller = left_size.min(right_size);
            let larger = left_size.max(right_size);
            if larger - smaller >= minimum_file_size_delta
                && larger as f64 / smaller as f64 > file_size_ratio_limit
            {
                return true;
            }
        }
    }
    false
}

/// 比较参数（Readoshi 的默认值）。块级逐像素阈值/区块匹配率/Wilson 判重阈值
/// 是常量（见块级证据节），证据只放宽低信息门。
#[derive(Debug, Clone, Copy, PartialEq)]
struct SignatureComparisonOptions {
    aspect_ratio_limit: f64,
    low_texture_std_dev: f64,
    high_texture_std_dev: f64,
    dominant_color_fraction: f64,
    dominant_layout_distance: f64,
    uniform_color_fraction: f64,
    uniform_layout_distance: f64,
    uniform_std_dev: f64,
    allow_low_information_match: bool,
    mean_luminance_limit: f64,
}

impl Default for SignatureComparisonOptions {
    fn default() -> Self {
        Self {
            aspect_ratio_limit: 0.1,
            low_texture_std_dev: 12.0,
            high_texture_std_dev: 32.0,
            dominant_color_fraction: 0.75,
            dominant_layout_distance: 0.08,
            uniform_color_fraction: 0.98,
            uniform_layout_distance: 0.03,
            uniform_std_dev: 4.0,
            allow_low_information_match: false,
            mean_luminance_limit: 96.0,
        }
    }
}

/// 签名 v3：32×32 亮度矩阵 + 内嵌 9×8 梯度 dhash（imsearch `d_hash` 同构）。
/// 亮度替代原 RGB 像素（信息量 ×4、存储减半），梯度哈希供比较前的廉价预筛。
#[derive(serde::Serialize, serde::Deserialize)]
struct StoredImageSignature {
    ratio: f64,
    luminance: Vec<u8>,
    mean: f64,
    standard_deviation: f64,
    dominant_fraction: f64,
    perceptual_hash: Vec<u8>,
}

const SIGNATURE_GRID: usize = 32;
/// 32×32 切 8×8 = 64 个区块，每块 4×4 像素。
const BLOCK_GRID: usize = 8;
const BLOCK_PIXELS: usize = SIGNATURE_GRID / BLOCK_GRID;
/// 单块逐像素差 > 该阈值算"变化像素"（Readoshi 一致的 30）。
const BLOCK_PIXEL_THRESHOLD: u8 = 30;
/// 区块内变化像素占比 ≤ 该值算"匹配证据"（imsearch 的 distance ≤64/256 对应物）。
const BLOCK_MATCH_RATIO: f64 = 0.25;
/// 块级证据双门之一：64 个区块中至少一半（32）算匹配——纯 Wilson 下界在
/// 「匹配块少但质量高」的边界过紧，50% 大标签的封面会被误拒。
const BLOCK_MIN_MATCHED: usize = (BLOCK_GRID * BLOCK_GRID) / 2;
/// 匹配证据的 Wilson 下界 ≥ 该值判重（imsearch 的 score 阈值对应物）。
const WILSON_MATCH_THRESHOLD: f64 = 0.82;
/// dhash 预筛：汉明距离 ≤ 该值（64 位里 ≤20 位不同）才进入精评。
const DHASH_PRESCREEN_HAMMING: u32 = 20;

/// 9×8 灰度梯度哈希（imsearch `d_hash` 的移植）：逐行左右比较，8 行 × 8 位。
fn gradient_dhash(luminance_9x8: &[u8]) -> [u8; 8] {
    let mut hash = [0_u8; 8];
    for (row, chunk) in luminance_9x8.chunks_exact(9).enumerate() {
        let mut byte = 0_u8;
        for column in 0..8 {
            byte <<= 1;
            byte |= u8::from(chunk[column] < chunk[column + 1]);
        }
        hash[row] = byte;
    }
    hash
}

/// Wilson score 下界（imsearch `utils::wilson_score` 移植，98% 置信）。
/// 证据稀少或方差大时显著下压——这是误报低于简单均值的关键。
fn wilson_score(scores: &[f64]) -> f64 {
    let count = scores.len() as f64;
    if count == 0.0 {
        return 0.0;
    }
    let mean = scores.iter().sum::<f64>() / count;
    let variance = scores.iter().map(|value| (mean - value).powi(2)).sum::<f64>() / count;
    let z = 2.326_f64;
    (mean + z.powi(2) / (2.0 * count)
        - ((z / (2.0 * count)) * (4.0 * count * variance + z.powi(2)).sqrt()))
        / (1.0 + z.powi(2) / count)
}

/// 给定对齐偏移，计算 64 个区块的 `1-ratio` 证据分数。
fn aligned_block_evidence(
    left: &StoredImageSignature,
    right: &StoredImageSignature,
    offset_x: i64,
    offset_y: i64,
) -> Vec<f64> {
    let width = SIGNATURE_GRID;
    let mut evidence = Vec::with_capacity(BLOCK_GRID * BLOCK_GRID);
    for block_y in 0..BLOCK_GRID {
        for block_x in 0..BLOCK_GRID {
            let mut changed = 0usize;
            let mut total = 0usize;
            for pixel_y in 0..(SIGNATURE_GRID / BLOCK_GRID) {
                let left_y = (block_y * (SIGNATURE_GRID / BLOCK_GRID) + pixel_y) as i64;
                let right_y = left_y + offset_y;
                if right_y < 0 || right_y >= width as i64 {
                    continue;
                }
                for pixel_x in 0..(SIGNATURE_GRID / BLOCK_GRID) {
                    let left_x = (block_x * (SIGNATURE_GRID / BLOCK_GRID) + pixel_x) as i64;
                    let right_x = left_x + offset_x;
                    if right_x < 0 || right_x >= width as i64 {
                        continue;
                    }
                    total += 1;
                    let difference =
                        left.luminance[(left_y * width as i64 + left_x) as usize]
                            .abs_diff(right.luminance[(right_y * width as i64 + right_x) as usize]);
                    if difference > BLOCK_PIXEL_THRESHOLD {
                        changed += 1;
                    }
                }
            }
            let ratio = if total == 0 {
                1.0
            } else {
                changed as f64 / total as f64
            };
            evidence.push(1.0 - ratio.min(1.0));
        }
    }
    evidence
}

/// 块级证据判定：尝试 3×3 个 ±1 像素对齐，取最佳结果。证据只取「匹配块」
/// （ratio ≤ 0.25 的区块，imsearch 语义：不匹配的特征不计入评分集），双门 =
/// 匹配块 ≥ 半数 且 Wilson 下界 ≥ 0.82。返回 `Some(score)` 判重；`None` 不判重。
fn block_evidence_duplicate(
    left: &StoredImageSignature,
    right: &StoredImageSignature,
) -> Option<f64> {
    let matched_minimum = 1.0 - BLOCK_MATCH_RATIO;
    let mut best: Option<f64> = None;
    for offset_y in [-1_i64, 0, 1] {
        for offset_x in [-1_i64, 0, 1] {
            let matched: Vec<f64> = aligned_block_evidence(left, right, offset_x, offset_y)
                .into_iter()
                .filter(|score| *score >= matched_minimum)
                .collect();
            if matched.len() < BLOCK_MIN_MATCHED {
                continue;
            }
            let score = wilson_score(&matched);
            if best.is_none_or(|current| score > current) {
                best = Some(score);
            }
        }
    }
    let score = best?;
    (score >= WILSON_MATCH_THRESHOLD).then_some(score)
}

fn decoded_cover_signature(bytes: &[u8]) -> Result<String, String> {
    use image::imageops::FilterType;
    let image = image::load_from_memory(bytes).map_err(|error| error.to_string())?;
    let ratio = image.width() as f64 / image.height().max(1) as f64;
    let grayscale = image::DynamicImage::ImageLuma8(image::imageops::grayscale(&image));
    let grid = grayscale
        .resize_exact(SIGNATURE_GRID as u32, SIGNATURE_GRID as u32, FilterType::Triangle)
        .to_luma8();
    let luminance = grid.into_raw();
    let mean = luminance.iter().map(|value| f64::from(*value)).sum::<f64>()
        / luminance.len().max(1) as f64;
    let standard_deviation = (luminance
        .iter()
        .map(|value| (f64::from(*value) - mean).powi(2))
        .sum::<f64>()
        / luminance.len().max(1) as f64)
        .sqrt();
    let mut bins = [0usize; 16];
    for value in &luminance {
        bins[(*value as usize / 16).min(15)] += 1;
    }
    let dominant_fraction =
        bins.into_iter().max().unwrap_or_default() as f64 / luminance.len().max(1) as f64;
    if dominant_fraction >= 0.98 && standard_deviation <= 4.0 {
        return Err("low-information cover".into());
    }
    let thumbnail = grayscale
        .resize_exact(9, 8, FilterType::Triangle)
        .to_luma8()
        .into_raw();
    let perceptual_hash = gradient_dhash(&thumbnail).to_vec();
    serde_json::to_string(&StoredImageSignature {
        ratio,
        luminance,
        mean,
        standard_deviation,
        dominant_fraction,
        perceptual_hash,
    })
    .map_err(|error| error.to_string())
}

/// 判定两张封面签名是否疑似重复（块级证据 + Wilson 聚合，imsearch 的
/// 「多特征匹配 → 按图聚合 → Wilson 下界」思想）。返回 `Some(score)` 表示
/// 判重（score 为最佳对齐的 Wilson 下界），`None` 不判重。形状/纹理/低信息
/// 门是判重前的「拒绝」证据，不进 Wilson。
fn are_signatures_duplicate(
    left: &StoredImageSignature,
    right: &StoredImageSignature,
    left_shape: (Option<i64>, Option<i64>),
    right_shape: (Option<i64>, Option<i64>),
    options: &SignatureComparisonOptions,
) -> Option<f64> {
    if (left.ratio - right.ratio).abs() > options.aspect_ratio_limit {
        return None;
    }
    // 形状失配（页数 1.65/8 + 体积 2.25/1MB）：判重前的硬门槛。
    if archive_shape_mismatch(left_shape, right_shape, 1.65, 8, 2.25, 1_000_000) {
        return None;
    }
    if (left.standard_deviation <= options.low_texture_std_dev
        && right.standard_deviation >= options.high_texture_std_dev)
        || (right.standard_deviation <= options.low_texture_std_dev
            && left.standard_deviation >= options.high_texture_std_dev)
    {
        return None;
    }
    if !options.allow_low_information_match
        && left.dominant_fraction >= options.dominant_color_fraction
        && right.dominant_fraction >= options.dominant_color_fraction
    {
        return None;
    }
    if low_information_pair(left, right, options) {
        return None;
    }
    block_evidence_duplicate(left, right)
}

/// 布局距离：逐像素亮度的平均差（Readoshi 的 getLayoutDistance）。
fn layout_distance(left: &StoredImageSignature, right: &StoredImageSignature) -> f64 {
    let size = left.luminance.len().min(right.luminance.len());
    if size == 0 {
        return 1.0;
    }
    let total: f64 = left.luminance[..size]
        .iter()
        .zip(&right.luminance[..size])
        .map(|(left, right)| f64::from(left.abs_diff(*right)))
        .sum();
    total / size as f64 / 255.0
}

/// 低信息配对跳过（Readoshi 的 shouldSkipLowInformationPair）。
fn low_information_pair(
    left: &StoredImageSignature,
    right: &StoredImageSignature,
    options: &SignatureComparisonOptions,
) -> bool {
    if left.dominant_fraction < options.dominant_color_fraction
        || right.dominant_fraction < options.dominant_color_fraction
    {
        return false;
    }
    let distance = layout_distance(left, right);
    if distance > options.dominant_layout_distance {
        return true;
    }
    left.dominant_fraction >= options.uniform_color_fraction
        && right.dominant_fraction >= options.uniform_color_fraction
        && left.standard_deviation <= options.uniform_std_dev
        && right.standard_deviation <= options.uniform_std_dev
        && distance <= options.uniform_layout_distance
}

/// 证据化比较参数（Readoshi 的 getImageComparisonOptions）：证据只放宽
/// 低信息门——块级 Wilson 的判定阈值是常量，没有需要放宽的自由度。
fn image_comparison_options(
    evidence: FilenameEvidence,
    name_count: i64,
    options: &SignatureComparisonOptions,
) -> SignatureComparisonOptions {
    let mut adjusted = *options;
    if (evidence == FilenameEvidence::Exact && name_count <= 2)
        || evidence == FilenameEvidence::Similar
    {
        adjusted.allow_low_information_match = true;
    }
    adjusted
}

/// 廉价跳过（Readoshi 的 shouldSkipCheapPair）：非证据对先用页数失配（1.15/2）
/// 与平均亮度差（96）拦截，避免完整像素比较。
fn should_skip_cheap_pair(
    left: &StoredImageSignature,
    right: &StoredImageSignature,
    evidence: FilenameEvidence,
    left_shape: (Option<i64>, Option<i64>),
    right_shape: (Option<i64>, Option<i64>),
    options: &SignatureComparisonOptions,
) -> bool {
    if evidence == FilenameEvidence::Exact {
        return false;
    }
    if evidence != FilenameEvidence::Similar
        && archive_shape_mismatch(left_shape, right_shape, 1.15, 2, f64::INFINITY, i64::MAX)
    {
        return true;
    }
    if evidence != FilenameEvidence::Similar
        && (left.mean - right.mean).abs() > options.mean_luminance_limit
    {
        return true;
    }
    low_information_pair(left, right, options)
}

fn compute_scan_feature(
    database: &crate::db::Database,
    scope_id: &str,
    archive: &DedupScanArchive,
    algorithm_version: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let content_hash = exact_hash(bytes);
    let exists: bool = database.connection.lock()
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())?
        .query_row("SELECT EXISTS(SELECT 1 FROM dedup_features WHERE scope_id=?1 AND path=?2 AND exact_hash=?3 AND algorithm_version=?4 AND dhash IS NOT NULL)",
            params![scope_id, archive.archive_id, content_hash, algorithm_version], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if exists { return Ok(()); }
    // This expensive decode deliberately runs with no database lock held.
    let signature = match decoded_cover_signature(bytes) {
        Ok(value) => value,
        Err(error) if error == "low-information cover" => String::new(),
        Err(error) => return Err(error),
    };
    database.connection.lock().map_err(|_| crate::cache::LOCK_FAILED.to_string())?
        .execute("INSERT INTO dedup_features (scope_id,path,exact_hash,dhash,algorithm_version,size) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(scope_id,path) DO UPDATE SET exact_hash=excluded.exact_hash,dhash=excluded.dhash,algorithm_version=excluded.algorithm_version,size=excluded.size,updated_at=CURRENT_TIMESTAMP",
            params![scope_id, archive.archive_id, content_hash, signature, algorithm_version, bytes.len() as i64])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_or_compute_feature(
    connection: &Connection,
    scope_id: &str,
    archive: &DedupScanArchive,
    algorithm_version: &str,
    bytes: &[u8],
) -> Result<(CoverFeature, bool), String> {
    let content_hash = exact_hash(bytes);
    let reused: Option<String> = connection
        .query_row(
            "SELECT dhash FROM dedup_features WHERE scope_id=?1 AND path=?2 AND exact_hash=?3 AND algorithm_version=?4 AND dhash IS NOT NULL",
            params![scope_id, archive.archive_id, content_hash, algorithm_version],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(signature) = reused {
        return Ok((
            CoverFeature {
                content_hash,
                signature,
            },
            true,
        ));
    }
    let signature = match decoded_cover_signature(bytes) {
        Ok(value) => value,
        Err(error) if error == "low-information cover" => String::new(),
        Err(error) => return Err(error),
    };
    connection.execute(
        "INSERT INTO dedup_features (scope_id,path,exact_hash,dhash,algorithm_version,size) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(scope_id,path) DO UPDATE SET exact_hash=excluded.exact_hash,dhash=excluded.dhash,algorithm_version=excluded.algorithm_version,size=excluded.size,updated_at=CURRENT_TIMESTAMP",
        params![scope_id, archive.archive_id, content_hash, signature, algorithm_version, bytes.len() as i64],
    ).map_err(|error| error.to_string())?;
    Ok((
        CoverFeature {
            content_hash,
            signature,
        },
        false,
    ))
}

/// 内存条目：签名整轮只解析一次。15k 封面 × ~1KB 亮度 ≈ 15MB，可全量常驻，
/// O(n²) 预筛无需再访问数据库。
struct ScanEntry {
    archive_id: String,
    filename: String,
    /// 封面是否可用作证据：命中占位图（同一张图挂在页数/体积互相矛盾的档案上）
    /// 时置 false，比较层就此不再用封面判重。
    cover_trusted: bool,
    /// 归一化文件名与它的字符数在装载时算好：比较循环每个档案对都会用到，
    /// 放在循环里等于每对都跑一遍 NFKC 与分配。
    normalized_name: String,
    name_chars: usize,
    page_count: Option<i64>,
    size: Option<i64>,
    content_hash: Option<String>,
    signature: Option<StoredImageSignature>,
}

impl ScanEntry {
    fn new(
        archive_id: String,
        filename: String,
        page_count: Option<i64>,
        size: Option<i64>,
        content_hash: Option<String>,
        signature: Option<StoredImageSignature>,
    ) -> Self {
        let normalized_name = normalized_filename(&filename);
        let name_chars = normalized_name.chars().count();
        Self {
            archive_id,
            filename,
            cover_trusted: true,
            normalized_name,
            name_chars,
            page_count,
            size,
            content_hash,
            signature,
        }
    }
}

fn load_scan_entries(
    connection: &Connection,
    session_id: &str,
    scope_id: &str,
    algorithm_version: &str,
) -> Result<Vec<ScanEntry>, String> {
    let mut statement = connection.prepare(
        "SELECT s.archive_id,COALESCE(s.title,''),s.page_count,s.size,f.exact_hash,f.dhash FROM dedup_archive_snapshots s LEFT JOIN dedup_features f ON f.scope_id=?2 AND f.path=s.archive_id AND f.algorithm_version=?3 WHERE s.session_id=?1 ORDER BY s.archive_id",
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![session_id, scope_id, algorithm_version], |row| {
            let exact_hash: Option<String> = row.get(4)?;
            let signature_json: Option<String> = row.get(5)?;
            let signature = match signature_json {
                Some(json) if !json.is_empty() => match serde_json::from_str(&json) {
                    Ok(signature) => Some(signature),
                    Err(error) => {
                        return Err(rusqlite::Error::FromSqlConversionFailure(
                            5,
                            rusqlite::types::Type::Text,
                            format!("Corrupt stored signature: {error}").into(),
                        ));
                    }
                },
                _ => None,
            };
            Ok(ScanEntry::new(
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                exact_hash,
                signature,
            ))
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

/// 全局同名计数（Readoshi 的 nameCounts）：快照标题归一化后的出现次数，用于
/// 「同名档案 ≤2 个才直接判文件名重复」的门限。
fn count_normalized_names(
    connection: &Connection,
    session_id: &str,
) -> Result<std::collections::HashMap<String, i64>, String> {
    let mut statement = connection
        .prepare("SELECT COALESCE(title,'') FROM dedup_archive_snapshots WHERE session_id=?1")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([session_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut counts = std::collections::HashMap::new();
    for title in rows {
        let title = title.map_err(|error| error.to_string())?;
        let name = normalized_filename(&title);
        if !name.is_empty() {
            *counts.entry(name).or_insert(0) += 1;
        }
    }
    Ok(counts)
}

/// 成对判定：blake3 精确 → 判重；否则 dhash 预筛（汉明 ≤ 预筛阈值）→
/// 廉价跳过门 → 证据放宽 → 块级 Wilson 精评。返回 Some(分数) 表示判重。
fn pair_image_match(
    left: &ScanEntry,
    right: &ScanEntry,
    evidence: FilenameEvidence,
    name_count: i64,
    options: &SignatureComparisonOptions,
) -> Option<f64> {
    // 占位图不是证据：命中它的档案在封面这条线上直接退出比较。
    if !left.cover_trusted || !right.cover_trusted {
        return None;
    }
    let exact_hash_match = left
        .content_hash
        .as_ref()
        .zip(right.content_hash.as_ref())
        .is_some_and(|(a, b)| a == b);
    let shapes = (
        (left.page_count, left.size),
        (right.page_count, right.size),
    );
    if exact_hash_match {
        return Some(0.0);
    }
    let (left_signature, right_signature) = left.signature.as_ref().zip(right.signature.as_ref())?;
    let hash_distance: u32 = left_signature
        .perceptual_hash
        .iter()
        .zip(&right_signature.perceptual_hash)
        .map(|(left, right)| u32::from((left ^ right).count_ones()))
        .sum();
    if hash_distance > DHASH_PRESCREEN_HAMMING {
        return None;
    }
    if should_skip_cheap_pair(left_signature, right_signature, evidence, shapes.0, shapes.1, options) {
        return None;
    }
    let adjusted = image_comparison_options(evidence, name_count, options);
    are_signatures_duplicate(left_signature, right_signature, shapes.0, shapes.1, &adjusted)
}

/// 封面字节哈希被多个档案共用的档案集合。历史上不带 `no_fallback` 抓封面时，
/// 缩略图尚未生成的档案都会拿到 LRR 的同一张占位图并被缓存——这些档案必须重新
/// 取一次封面（现在会用 no_fallback 拿真图或排队生成），否则占位图会让它们继续
/// 互相判重。真重复的封面相同也无妨：重取回来还是同一张图，代价只是每个共用
/// 哈希的档案多一次下载。
fn cover_hashes_shared_by_multiple(
    connection: &Connection,
    scope_id: &str,
) -> Result<std::collections::HashSet<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT path FROM dedup_features WHERE scope_id=?1 AND exact_hash IN (
                 SELECT exact_hash FROM dedup_features WHERE scope_id=?1
                 GROUP BY exact_hash HAVING COUNT(*) >= 2
             )",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([scope_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(|error| error.to_string())
}

/// LRR 在档案还没有缩略图时回的是同一张占位图，它会被逐字节缓存，于是完全
/// 无关的档案看起来「封面一模一样」。只在封面哈希相同、而两边页数/体积互相
/// 矛盾时才判定为占位图——真重复不会这样。命中的档案在比较里视为没有封面：
/// 仍可靠文件名成对，但不会再因为共用一张图被判重。
fn distrust_placeholder_covers(entries: &mut [ScanEntry]) {
    let mut by_hash: std::collections::HashMap<&str, Vec<usize>> =
        std::collections::HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if let Some(hash) = entry.content_hash.as_deref().filter(|hash| !hash.is_empty()) {
            by_hash.entry(hash).or_default().push(index);
        }
    }
    let mut placeholders = std::collections::HashSet::new();
    for (hash, indexes) in by_hash {
        if indexes.len() < 2 {
            continue;
        }
        let incompatible = indexes.iter().enumerate().any(|(offset, left)| {
            indexes.iter().skip(offset + 1).any(|right| {
                // 与判重同一道形状门槛（页数 1.65/8 + 体积 2.25/1MB）。
                archive_shape_mismatch(
                    (entries[*left].page_count, entries[*left].size),
                    (entries[*right].page_count, entries[*right].size),
                    1.65,
                    8,
                    2.25,
                    1_000_000,
                )
            })
        });
        if incompatible {
            placeholders.insert(hash.to_owned());
        }
    }
    if placeholders.is_empty() {
        return;
    }
    for entry in entries.iter_mut() {
        if entry
            .content_hash
            .as_deref()
            .is_some_and(|hash| placeholders.contains(hash))
        {
            entry.cover_trusted = false;
        }
    }
}

/// 某一端的全部不重复标记（含历史墓碑之外的有效标记），一次读进内存：
/// 比较循环因此不需要数据库连接，长循环也就不用攥着全局连接锁。
fn load_excluded_pair_keys(
    connection: &Connection,
    scope_id: &str,
) -> Result<std::collections::HashSet<String>, String> {
    let mut statement = connection
        .prepare("SELECT pair_key FROM dedup_non_duplicates WHERE scope_id=?1 AND tombstoned=0")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([scope_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(|error| error.to_string())
}

/// 成对比较的核心，纯计算，不碰数据库，按左端批次回报进度。
///
/// 循环顺序是按代价排的：dhash 预筛（异或 + 位计数）先淘汰绝大多数组合，
/// 只有可能命中的对才去算文件名证据里的 Levenshtein 相似度。此前每一对都
/// 先跑 normalized_filename（NFKC + 去括号标记）再跑相似度，15k 档案就是
/// 上亿次字符串分配，比较阶段实际永远跑不完。
fn compare_scan_entries(
    entries: &[ScanEntry],
    name_counts: &std::collections::HashMap<String, i64>,
    excluded: &std::collections::HashSet<String>,
    algorithm_version: &str,
    progress_batch: usize,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<Vec<DedupPairInput>, String> {
    let base_options = SignatureComparisonOptions::default();
    let name_count_of: Vec<i64> = entries
        .iter()
        .map(|entry| name_counts.get(&entry.normalized_name).copied().unwrap_or(0))
        .collect();
    let mut pairs = Vec::new();
    for (left_index, left) in entries.iter().enumerate() {
        let name_count = name_count_of[left_index];
        for right in entries.iter().skip(left_index + 1) {
            // 同名是唯一不依赖签名/哈希的判重路径，其余组合先过预筛。
            let same_name = !left.normalized_name.is_empty()
                && left.normalized_name == right.normalized_name;
            if !same_name && !signature_prescreen_passes(left, right) {
                continue;
            }
            let evidence = filename_evidence(left, right);
            // 精确同名：直接成对（同名数 ≤2 才允许，防模板名互配）。
            let exact_filename_pair = evidence == FilenameEvidence::Exact
                && name_count <= 2
                && !left.filename.trim().is_empty();
            let image_score = pair_image_match(left, right, evidence, name_count, &base_options);
            let source = if image_score.is_some() {
                Some("image")
            } else if exact_filename_pair {
                Some("filename")
            } else {
                None
            };
            let Some(source) = source else {
                continue;
            };
            let (key, normalized_left, normalized_right) =
                pair_key(&left.archive_id, &right.archive_id)?;
            if excluded.contains(&key) {
                continue;
            }
            let diagnostics = serde_json::json!({
                "algorithmVersion": algorithm_version,
                "exactHashMatch": left.content_hash.as_ref().zip(right.content_hash.as_ref()).is_some_and(|(a, b)| a == b),
                "imageDifference": image_score,
                "pageCountDelta": left.page_count.zip(right.page_count).map(|(a,b)| (a-b).abs()),
                "sizeDelta": left.size.zip(right.size).map(|(a,b)| (a-b).abs()),
            });
            pairs.push(DedupPairInput {
                left_archive_id: normalized_left,
                right_archive_id: normalized_right,
                source: source.into(),
                diagnostics: Some(diagnostics),
            });
        }
        if progress_batch > 0 && (left_index + 1) % progress_batch == 0 {
            on_progress(left_index + 1, entries.len());
        }
    }
    // 批次回调按批走，最后一批通常不满：收尾补一次，进度条才会落到 100%。
    on_progress(entries.len(), entries.len());
    Ok(pairs)
}

/// 用本次比较的结果整体替换会话里的命中对，一个事务写完。
fn replace_pairs(
    connection: &mut Connection,
    session_id: &str,
    pairs: &[DedupPairInput],
) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM dedup_pairs WHERE session_id=?1", [session_id])
        .map_err(|error| error.to_string())?;
    persist_pairs(&transaction, session_id, pairs)?;
    transaction.commit().map_err(|error| error.to_string())
}

/// 把命中的对写进会话；主键是 (session_id, pair_key)，重复写入按替换处理。
fn persist_pairs(
    connection: &Connection,
    session_id: &str,
    pairs: &[DedupPairInput],
) -> Result<(), String> {
    for pair in pairs {
        let (key, normalized_left, normalized_right) =
            pair_key(&pair.left_archive_id, &pair.right_archive_id)?;
        let diagnostics = pair.diagnostics.as_ref().map(|value| value.to_string());
        connection
            .execute(
                "INSERT OR REPLACE INTO dedup_pairs (session_id,pair_key,left_archive_id,right_archive_id,source,diagnostics) VALUES (?1,?2,?3,?4,?5,?6)",
                params![session_id, key, normalized_left, normalized_right, pair.source, diagnostics],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 同步入口：装载证据 → 比较 → 落库。扫描命令不用它（它在比较期间仍然握着
/// 连接，正是要避免的做法），保留给测试当一行式的比较入口。
#[cfg(test)]
fn build_pairs_bounded(
    connection: &mut Connection,
    session_id: &str,
    scope_id: &str,
    algorithm_version: &str,
) -> Result<Vec<DedupPairInput>, String> {
    let name_counts = count_normalized_names(connection, session_id)?;
    let mut entries = load_scan_entries(connection, session_id, scope_id, algorithm_version)?;
    distrust_placeholder_covers(&mut entries);
    let excluded = load_excluded_pair_keys(connection, scope_id)?;
    let pairs = compare_scan_entries(
        &entries,
        &name_counts,
        &excluded,
        algorithm_version,
        0,
        |_, _| {},
    )?;
    replace_pairs(connection, session_id, &pairs)?;
    Ok(pairs)
}

#[cfg(test)]
pub fn execute_cached_cover_scan<S, C>(
    scope_id: &str,
    algorithm_version: &str,
    archives: &[DedupScanArchive],
    chunk_size: usize,
    source: &mut S,
    mut is_cancelled: C,
) -> DedupScanProgress
where
    S: DedupCoverSource,
    C: FnMut() -> bool,
{
    let total = archives.len() as i64;
    let mut progress = DedupScanProgress {
        session_id: String::new(),
        scope_id: scope_id.to_string(),
        status: "running".into(),
        stage: "covers".into(),
        processed: 0,
        total,
        cache_hits: 0,
        downloads: 0,
        missing_covers: 0,
        invalid_covers: 0,
        pair_count: 0,
        degraded: false,
        checkpoint: 0,
        diagnostics: Vec::new(),
        pairs: Vec::new(),
    };
    let chunk_size = chunk_size.max(1);
    // Keep only compact content signatures after each bounded chunk; raw cover
    // bytes are dropped before the next chunk starts.
    let mut covers: BTreeMap<String, CoverFeature> = BTreeMap::new();
    for chunk in archives.chunks(chunk_size) {
        if is_cancelled() {
            progress.status = "cancelled".into();
            progress.stage = "cancelled".into();
            break;
        }
        for archive in chunk {
            let bytes = match source.cached_cover(&archive.archive_id) {
                Ok(Some(bytes)) => {
                    progress.cache_hits += 1;
                    Some(bytes)
                }
                Ok(None) => match source.download_cover(&archive.archive_id) {
                    Ok(bytes) if !bytes.is_empty() => {
                        progress.downloads += 1;
                        Some(bytes)
                    }
                    Ok(_) => {
                        progress.invalid_covers += 1;
                        progress
                            .diagnostics
                            .push(format!("{}: cover invalid", archive.archive_id));
                        None
                    }
                    Err(error) => {
                        progress.missing_covers += 1;
                        progress
                            .diagnostics
                            .push(format!("{}: cover missing ({error})", archive.archive_id));
                        None
                    }
                },
                Err(error) => {
                    progress.invalid_covers += 1;
                    progress
                        .diagnostics
                        .push(format!("{}: cache invalid ({error})", archive.archive_id));
                    None
                }
            };
            if let Some(bytes) = bytes {
                match decoded_cover_signature(&bytes) {
                    Ok(signature) => {
                        covers.insert(
                            archive.archive_id.clone(),
                            CoverFeature {
                                content_hash: exact_hash(&bytes),
                                signature,
                            },
                        );
                    }
                    Err(error) => {
                        progress.invalid_covers += 1;
                        progress.diagnostics.push(format!(
                            "{}: cover decode failed ({error})",
                            archive.archive_id
                        ));
                    }
                }
            }
            progress.processed += 1;
            progress.checkpoint = progress.processed;
        }
    }
    let name_counts = {
        let mut counts = std::collections::HashMap::new();
        for archive in archives {
            let name = normalized_filename(&archive.filename);
            if !name.is_empty() {
                *counts.entry(name).or_insert(0) += 1;
            }
        }
        counts
    };
    let entries: Vec<ScanEntry> = archives
        .iter()
        .map(|archive| {
            let feature = covers.get(&archive.archive_id);
            ScanEntry::new(
                archive.archive_id.clone(),
                archive.filename.clone(),
                archive.page_count,
                archive.size,
                feature.map(|feature| feature.content_hash.clone()),
                feature.and_then(|feature| serde_json::from_str(&feature.signature).ok()),
            )
        })
        .collect();
    let mut entries = entries;
    distrust_placeholder_covers(&mut entries);
    let pairs = compare_scan_entries(
        &entries,
        &name_counts,
        &std::collections::HashSet::new(),
        algorithm_version,
        0,
        |_, _| {},
    )
    .unwrap_or_default();
    for pair in pairs {
        progress.pairs.push(DedupPairInput {
            diagnostics: Some(serde_json::json!({ "algorithmVersion": algorithm_version, "scopeId": scope_id })),
            ..pair
        });
    }
    progress.pair_count = progress.pairs.len() as i64;
    progress.degraded = progress.missing_covers > 0 || progress.invalid_covers > 0;
    if progress.status == "running" {
        progress.status = "completed".into();
        progress.stage = "completed".into();
    }
    progress
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupStartScanInput {
    pub session_id: String,
    pub scope_id: String,
    pub algorithm_version: String,
    pub archive_count: i64,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupArchiveSnapshotInput {
    pub archive_id: String,
    pub path: String,
    pub title: Option<String>,
    pub page_count: Option<i64>,
    pub size: Option<i64>,
    pub feature_version: String,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupPairInput {
    pub left_archive_id: String,
    pub right_archive_id: String,
    pub source: String,
    pub diagnostics: Option<serde_json::Value>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupScanChunkInput {
    pub session_id: String,
    pub algorithm_version: String,
    pub checkpoint: i64,
    pub archives: Vec<DedupArchiveSnapshotInput>,
    pub pairs: Vec<DedupPairInput>,
    pub selected_archive_ids: Vec<String>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupNonDuplicateInput {
    pub scope_id: String,
    pub left_archive_id: String,
    pub right_archive_id: String,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupDeleteSelectedInput {
    pub session_id: String,
    pub outcomes: Vec<DedupDeletionOutcomeInput>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupDeletionOutcomeInput {
    pub archive_id: String,
    pub deleted: bool,
    pub message: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupImportInput {
    pub scope_id: String,
    pub pairs: Vec<DedupPairInput>,
}

/// 持久化的不重复关系行（含墓碑），供工作区直接查看与撤销标记。
#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DedupNonDuplicateRecord {
    pub pair_key: String,
    pub left_archive_id: String,
    pub right_archive_id: String,
    pub tombstoned: bool,
}

pub fn list_non_duplicates(
    connection: &Connection,
    scope_id: &str,
) -> Result<Vec<DedupNonDuplicateRecord>, String> {
    required_text(scope_id)?;
    let mut statement = connection
        .prepare(
            "SELECT pair_key,left_archive_id,right_archive_id,tombstoned
             FROM dedup_non_duplicates WHERE scope_id=?1 ORDER BY pair_key",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![scope_id], |row| {
            Ok(DedupNonDuplicateRecord {
                pair_key: row.get(0)?,
                left_archive_id: row.get(1)?,
                right_archive_id: row.get(2)?,
                tombstoned: row.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DedupDeletionOutcome {
    pub archive_id: String,
    pub deleted: bool,
    pub message: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupScanSession {
    pub session_id: String,
    pub scope_id: String,
    pub algorithm_version: String,
    pub status: String,
    pub checkpoint: i64,
    pub archive_count: i64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupDeleteSelectedResult {
    pub rejected_archive_ids: Vec<String>,
    pub outcomes: Vec<DedupDeletionOutcome>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupLoadResult {
    pub session: DedupScanSession,
    pub archives: Vec<DedupArchiveSnapshotInput>,
    pub pairs: Vec<DedupPairInput>,
    pub selected_archive_ids: Vec<String>,
    pub outcomes: Vec<DedupDeletionOutcome>,
}

fn required_text(value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err("Invalid dedup identifier".into())
    } else {
        Ok(())
    }
}

fn archive_id(value: &str) -> Result<(), String> {
    required_text(value)?;
    if value.contains('|') {
        Err("Invalid dedup identifier".into())
    } else {
        Ok(())
    }
}

fn pair_key(left: &str, right: &str) -> Result<(String, String, String), String> {
    archive_id(left)?;
    archive_id(right)?;
    if left == right {
        return Err("Invalid dedup pair".into());
    }
    if left < right {
        Ok((format!("{left}|{right}"), left.into(), right.into()))
    } else {
        Ok((format!("{right}|{left}"), right.into(), left.into()))
    }
}

fn session(connection: &Connection, session_id: &str) -> Result<DedupScanSession, String> {
    connection.query_row(
        "SELECT id, scope_id, algorithm_version, status, checkpoint, archive_count FROM dedup_sessions WHERE id=?1",
        [session_id],
        |row| Ok(DedupScanSession { session_id: row.get(0)?, scope_id: row.get(1)?, algorithm_version: row.get(2)?, status: row.get(3)?, checkpoint: row.get(4)?, archive_count: row.get(5)? }),
    ).optional().map_err(|error| error.to_string())?.ok_or_else(|| "Dedup session not found".into())
}

pub fn start_scan(
    connection: &mut Connection,
    input: DedupStartScanInput,
) -> Result<DedupScanSession, String> {
    required_text(&input.session_id)?;
    required_text(&input.scope_id)?;
    required_text(&input.algorithm_version)?;
    if input.archive_count < 0 {
        return Err("Invalid archive count".into());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let existing: Option<(String, String)> = transaction
        .query_row(
            "SELECT scope_id,algorithm_version FROM dedup_sessions WHERE id=?1",
            [&input.session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if existing.as_ref().is_some_and(|(scope_id, version)| {
        scope_id != &input.scope_id || version != &input.algorithm_version
    }) {
        transaction
            .execute(
                "DELETE FROM dedup_sessions WHERE id=?1",
                [&input.session_id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.execute(
        "INSERT INTO dedup_sessions (id,scope_id,algorithm_version,status,checkpoint,archive_count,saved) VALUES (?1,?2,?3,'running',0,?4,0) ON CONFLICT(id) DO UPDATE SET scope_id=excluded.scope_id, archive_count=excluded.archive_count, status='running', updated_at=CURRENT_TIMESTAMP",
        params![input.session_id, input.scope_id, input.algorithm_version, input.archive_count],
    ).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    session(connection, &input.session_id)
}

pub fn scan_chunk(
    connection: &mut Connection,
    input: DedupScanChunkInput,
) -> Result<DedupScanSession, String> {
    if input.checkpoint < 0 {
        return Err("Invalid checkpoint".into());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let (version, status, persisted_checkpoint, archive_count): (String, String, i64, i64) = transaction
        .query_row(
            "SELECT algorithm_version,status,checkpoint,archive_count FROM dedup_sessions WHERE id=?1",
            [&input.session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Dedup session not found".to_string())?;
    if version != input.algorithm_version {
        return Err("Dedup algorithm version changed".into());
    }
    if status != "running" {
        return Err("Dedup scan is not running".into());
    }
    if input.checkpoint > archive_count {
        return Err("Invalid checkpoint".into());
    }
    if input.checkpoint < persisted_checkpoint {
        return Err("Dedup checkpoint regressed".into());
    }
    for archive in &input.archives {
        archive_id(&archive.archive_id)?;
        required_text(&archive.path)?;
        required_text(&archive.feature_version)?;
        if archive.feature_version != input.algorithm_version {
            return Err("Dedup feature version changed".into());
        }
        transaction.execute("INSERT INTO dedup_archive_snapshots (session_id,archive_id,path,title,page_count,size,feature_version) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(session_id,archive_id) DO UPDATE SET path=excluded.path,title=excluded.title,page_count=excluded.page_count,size=excluded.size,feature_version=excluded.feature_version", params![input.session_id, archive.archive_id, archive.path, archive.title, archive.page_count, archive.size, archive.feature_version]).map_err(|error| error.to_string())?;
    }
    for pair in &input.pairs {
        let (key, left, right) = pair_key(&pair.left_archive_id, &pair.right_archive_id)?;
        required_text(&pair.source)?;
        let endpoint_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM dedup_archive_snapshots WHERE session_id=?1 AND archive_id IN (?2,?3)",
            params![input.session_id, left, right],
            |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if endpoint_count != 2 {
            return Err("Dedup pair references an absent archive".into());
        }
        let diagnostics = pair
            .diagnostics
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| error.to_string())?;
        transaction.execute("INSERT INTO dedup_pairs (session_id,pair_key,left_archive_id,right_archive_id,source,diagnostics) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(session_id,pair_key) DO UPDATE SET source=excluded.source,diagnostics=excluded.diagnostics", params![input.session_id, key, left, right, pair.source, diagnostics]).map_err(|error| error.to_string())?;
    }
    transaction
        .execute(
            "DELETE FROM dedup_selection WHERE session_id=?1",
            [&input.session_id],
        )
        .map_err(|error| error.to_string())?;
    for selected_id in BTreeSet::<String>::from_iter(input.selected_archive_ids) {
        archive_id(&selected_id)?;
        let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM dedup_archive_snapshots WHERE session_id=?1 AND archive_id=?2)", params![input.session_id, selected_id], |row| row.get(0)).map_err(|error| error.to_string())?;
        if !exists {
            return Err("Selected archive is absent from the persisted scan".into());
        }
        transaction
            .execute(
                "INSERT INTO dedup_selection (session_id,archive_id) VALUES (?1,?2)",
                params![input.session_id, selected_id],
            )
            .map_err(|error| error.to_string())?;
    }
    let next_status = if input.checkpoint == archive_count {
        "completed"
    } else {
        "running"
    };
    transaction.execute("UPDATE dedup_sessions SET checkpoint=?2,status=?3,updated_at=CURRENT_TIMESTAMP WHERE id=?1", params![input.session_id, input.checkpoint, next_status]).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    session(connection, &input.session_id)
}

/// 选择集不是扫描进度：已完成的会话也要能改待删列表，否则「载入扫描结果」之后
/// 勾选任何档案都会被 scan_chunk 的「运行中」门禁拒掉（界面只弹一句
/// "Dedup scan is not running"，勾选毫无反应）。
pub fn save_selection(
    connection: &mut Connection,
    session_id: &str,
    selected_archive_ids: &[String],
) -> Result<(), String> {
    required_text(session_id)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let known: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM dedup_sessions WHERE id=?1)",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !known {
        return Err("Dedup session not found".into());
    }
    transaction
        .execute("DELETE FROM dedup_selection WHERE session_id=?1", [session_id])
        .map_err(|error| error.to_string())?;
    for selected_id in BTreeSet::<String>::from_iter(selected_archive_ids.iter().cloned()) {
        archive_id(&selected_id)?;
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM dedup_archive_snapshots WHERE session_id=?1 AND archive_id=?2)",
                params![session_id, selected_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !exists {
            return Err("Selected archive is absent from the persisted scan".into());
        }
        transaction
            .execute(
                "INSERT INTO dedup_selection (session_id,archive_id) VALUES (?1,?2)",
                params![session_id, selected_id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

pub fn cancel_scan(
    connection: &mut Connection,
    session_id: String,
) -> Result<DedupScanSession, String> {
    connection.execute("UPDATE dedup_sessions SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status='running'", [&session_id]).map_err(|error| error.to_string())?;
    session(connection, &session_id)
}

pub fn resume_scan(
    connection: &mut Connection,
    session_id: String,
) -> Result<DedupScanSession, String> {
    let changed = connection.execute("UPDATE dedup_sessions SET status='running',updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status='cancelled'", [&session_id]).map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("Dedup scan cannot be resumed".into());
    }
    session(connection, &session_id)
}

/// 非重复结论也跨设备：本地写完顺手记一条同步日志，类型与落地端一致。
/// 逻辑时钟取表里那一行的值，远端的抢占比较才与本地同源。
fn journal_non_duplicate(
    transaction: &rusqlite::Transaction<'_>,
    scope_id: &str,
    pair_key: &str,
    left: &str,
    right: &str,
    tombstoned: bool,
) -> Result<(), String> {
    let clock: i64 = transaction
        .query_row(
            "SELECT logical_clock FROM dedup_non_duplicates WHERE scope_id = ?1 AND pair_key = ?2",
            params![scope_id, pair_key],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    crate::commands::sync::journal_object(
        transaction,
        scope_id,
        "dedup_non_duplicate",
        &format!("{scope_id}/{pair_key}"),
        clock,
        serde_json::json!({
            "pairKey": pair_key,
            "leftArchiveId": left,
            "rightArchiveId": right,
            "tombstoned": tombstoned,
        }),
    )
}

pub fn save_non_duplicate(
    connection: &mut Connection,
    input: DedupNonDuplicateInput,
) -> Result<(), String> {
    required_text(&input.scope_id)?;
    let (key, left, right) = pair_key(&input.left_archive_id, &input.right_archive_id)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction.execute("INSERT INTO dedup_non_duplicates (scope_id,pair_key,left_archive_id,right_archive_id,tombstoned,logical_clock) VALUES (?1,?2,?3,?4,0,1) ON CONFLICT(scope_id,pair_key) DO UPDATE SET tombstoned=0,logical_clock=dedup_non_duplicates.logical_clock+1,updated_at=CURRENT_TIMESTAMP", params![input.scope_id, key, left, right]).map_err(|error| error.to_string())?;
    journal_non_duplicate(&transaction, &input.scope_id, &key, &left, &right, false)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

pub fn remove_non_duplicate(
    connection: &mut Connection,
    input: DedupNonDuplicateInput,
) -> Result<(), String> {
    required_text(&input.scope_id)?;
    let (key, left, right) = pair_key(&input.left_archive_id, &input.right_archive_id)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction.execute("INSERT INTO dedup_non_duplicates (scope_id,pair_key,left_archive_id,right_archive_id,tombstoned,logical_clock) VALUES (?1,?2,?3,?4,1,1) ON CONFLICT(scope_id,pair_key) DO UPDATE SET tombstoned=1,logical_clock=dedup_non_duplicates.logical_clock+1,updated_at=CURRENT_TIMESTAMP", params![input.scope_id, key, left, right]).map_err(|error| error.to_string())?;
    journal_non_duplicate(&transaction, &input.scope_id, &key, &left, &right, true)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

pub fn import_readoshi(connection: &mut Connection, input: DedupImportInput) -> Result<(), String> {
    required_text(&input.scope_id)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for pair in input.pairs {
        let (key, left, right) = pair_key(&pair.left_archive_id, &pair.right_archive_id)?;
        transaction.execute(
            "INSERT INTO dedup_non_duplicates (scope_id,pair_key,left_archive_id,right_archive_id,tombstoned,logical_clock) VALUES (?1,?2,?3,?4,0,1) ON CONFLICT(scope_id,pair_key) DO UPDATE SET tombstoned=0,logical_clock=dedup_non_duplicates.logical_clock+1,updated_at=CURRENT_TIMESTAMP",
            params![input.scope_id, key, left, right],
        ).map_err(|error| error.to_string())?;
        journal_non_duplicate(&transaction, &input.scope_id, &key, &left, &right, false)?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn selected_component_rejections(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<String>, String> {
    let mut graph: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut archives = connection
        .prepare("SELECT archive_id FROM dedup_archive_snapshots WHERE session_id=?1 AND NOT EXISTS (SELECT 1 FROM dedup_deletion_outcomes WHERE session_id=dedup_archive_snapshots.session_id AND archive_id=dedup_archive_snapshots.archive_id AND deleted=1)")
        .map_err(|error| error.to_string())?;
    for row in archives
        .query_map([session_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
    {
        graph
            .entry(row.map_err(|error| error.to_string())?)
            .or_default();
    }
    let mut pairs = connection
        .prepare("SELECT left_archive_id,right_archive_id FROM dedup_pairs WHERE session_id=?1")
        .map_err(|error| error.to_string())?;
    for row in pairs
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
    {
        let (left, right) = row.map_err(|error| error.to_string())?;
        if graph.contains_key(&left) && graph.contains_key(&right) {
            graph.entry(left.clone()).or_default().insert(right.clone());
            graph.entry(right).or_default().insert(left);
        }
    }
    let selected: BTreeSet<String> = connection
        .prepare("SELECT archive_id FROM dedup_selection WHERE session_id=?1")
        .map_err(|error| error.to_string())?
        .query_map([session_id], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .map(|row| row.map_err(|error| error.to_string()))
        .collect::<Result<_, _>>()?;
    let mut seen = BTreeSet::new();
    let mut rejected = BTreeSet::new();
    for start in graph.keys() {
        if !seen.insert(start.clone()) {
            continue;
        }
        let mut component = BTreeSet::new();
        let mut queue = VecDeque::from([start.clone()]);
        while let Some(current) = queue.pop_front() {
            if !component.insert(current.clone()) {
                continue;
            }
            if let Some(neighbors) = graph.get(&current) {
                queue.extend(neighbors.iter().cloned());
            }
        }
        seen.extend(component.iter().cloned());
        if !component.is_empty() && component.iter().all(|id| selected.contains(id)) {
            rejected.extend(component);
        }
    }
    Ok(rejected.into_iter().collect())
}

pub fn delete_selected(
    connection: &mut Connection,
    input: DedupDeleteSelectedInput,
) -> Result<DedupDeleteSelectedResult, String> {
    if session(connection, &input.session_id)?.status != "completed" {
        return Err("Dedup scan is not complete".into());
    }
    let rejected_archive_ids = selected_component_rejections(connection, &input.session_id)?;
    if !rejected_archive_ids.is_empty() {
        return Ok(DedupDeleteSelectedResult {
            rejected_archive_ids,
            outcomes: vec![],
        });
    }
    let selected: BTreeSet<String> = connection
        .prepare("SELECT archive_id FROM dedup_selection WHERE session_id=?1")
        .map_err(|error| error.to_string())?
        .query_map([&input.session_id], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .map(|row| row.map_err(|error| error.to_string()))
        .collect::<Result<_, _>>()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let mut outcomes = Vec::new();
    for outcome in input.outcomes {
        if !selected.contains(&outcome.archive_id) {
            return Err("Deletion outcome is not selected".into());
        }
        transaction.execute("INSERT INTO dedup_deletion_outcomes (session_id,archive_id,deleted,message) VALUES (?1,?2,?3,?4) ON CONFLICT(session_id,archive_id) DO UPDATE SET deleted=excluded.deleted,message=excluded.message,created_at=CURRENT_TIMESTAMP", params![input.session_id, outcome.archive_id, outcome.deleted, outcome.message]).map_err(|error| error.to_string())?;
        outcomes.push(DedupDeletionOutcome {
            archive_id: outcome.archive_id,
            deleted: outcome.deleted,
            message: outcome.message,
        });
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(DedupDeleteSelectedResult {
        rejected_archive_ids: vec![],
        outcomes,
    })
}

pub fn load_result(connection: &Connection, session_id: &str) -> Result<DedupLoadResult, String> {
    let archives = connection.prepare("SELECT archive_id,path,title,page_count,size,feature_version FROM dedup_archive_snapshots WHERE session_id=?1 ORDER BY archive_id").map_err(|error| error.to_string())?.query_map([session_id], |row| Ok(DedupArchiveSnapshotInput { archive_id: row.get(0)?, path: row.get(1)?, title: row.get(2)?, page_count: row.get(3)?, size: row.get(4)?, feature_version: row.get(5)? })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let pairs = connection.prepare("SELECT left_archive_id,right_archive_id,source,diagnostics FROM dedup_pairs WHERE session_id=?1 ORDER BY pair_key").map_err(|error| error.to_string())?.query_map([session_id], |row| { let diagnostics: Option<String> = row.get(3)?; Ok(DedupPairInput { left_archive_id: row.get(0)?, right_archive_id: row.get(1)?, source: row.get(2)?, diagnostics: diagnostics.map(|value| serde_json::from_str(&value)).transpose().map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))? }) }).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let selected_archive_ids = connection
        .prepare("SELECT archive_id FROM dedup_selection WHERE session_id=?1 ORDER BY archive_id")
        .map_err(|error| error.to_string())?
        .query_map([session_id], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let outcomes = connection.prepare("SELECT archive_id,deleted,message FROM dedup_deletion_outcomes WHERE session_id=?1 ORDER BY archive_id").map_err(|error| error.to_string())?.query_map([session_id], |row| Ok(DedupDeletionOutcome { archive_id: row.get(0)?, deleted: row.get(1)?, message: row.get(2)? })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(DedupLoadResult {
        session: session(connection, session_id)?,
        archives,
        pairs,
        selected_archive_ids,
        outcomes,
    })
}

fn command_error<T>(result: Result<T, String>) -> crate::domain::result::CommandResult<T> {
    match result {
        Ok(value) => crate::domain::result::CommandResult::success(value),
        Err(error) => {
            crate::domain::result::CommandResult::failure("INVALID_RESPONSE", error, false)
        }
    }
}

#[tauri::command(async)]
pub fn dedup_start_scan(
    input: DedupStartScanInput,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<DedupScanSession> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.into())
            .and_then(|mut connection| start_scan(&mut connection, input)),
    )
}
#[tauri::command(async)]
pub fn dedup_scan_chunk(
    input: DedupScanChunkInput,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<DedupScanSession> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.into())
            .and_then(|mut connection| scan_chunk(&mut connection, input)),
    )
}
#[tauri::command(async)]
pub fn dedup_cancel_scan(
    session_id: String,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<DedupScanSession> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.into())
            .and_then(|mut connection| cancel_scan(&mut connection, session_id)),
    )
}
#[tauri::command(async)]
pub fn dedup_resume_scan(
    session_id: String,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<DedupScanSession> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.into())
            .and_then(|mut connection| resume_scan(&mut connection, session_id)),
    )
}
#[tauri::command(async)]
pub fn dedup_load_result(
    session_id: String,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<DedupLoadResult> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.into())
            .and_then(|connection| load_result(&connection, &session_id)),
    )
}
#[tauri::command(async)]
pub fn dedup_save_non_duplicate(
    input: DedupNonDuplicateInput,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<()> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.into())
            .and_then(|mut connection| {
                let scope_id = input.scope_id.clone();
                let (pair_key, left, right) =
                    pair_key(&input.left_archive_id, &input.right_archive_id)?;
                save_non_duplicate(&mut connection, input)?;
                crate::commands::sync::append_dedup_journal(
                    &mut connection,
                    &scope_id,
                    &pair_key,
                    "upsert",
                    &left,
                    &right,
                    false,
                )
            }),
    )
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupNonDuplicateBatchInput {
    pub entries: Vec<DedupNonDuplicateInput>,
}

/// 一批两两标记一次落库：整组执行时前端按 C(m,2) 逐对发 IPC，
/// 一组五人就是十次串行往返。按输入顺序逐条回 bool：前端只把成功的对
/// 记作已处理，部分失败不会把没落库的组从视图里误删。
#[tauri::command(async)]
pub fn dedup_save_non_duplicates(
    input: DedupNonDuplicateBatchInput,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<Vec<bool>> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.into())
            .and_then(|mut connection| {
                let mut outcomes = Vec::with_capacity(input.entries.len());
                for entry in input.entries {
                    let scope_id = entry.scope_id.clone();
                    let outcome = match pair_key(&entry.left_archive_id, &entry.right_archive_id) {
                        Ok((pair_key, left, right)) => {
                            save_non_duplicate(&mut connection, entry).is_ok()
                                && crate::commands::sync::append_dedup_journal(
                                    &mut connection,
                                    &scope_id,
                                    &pair_key,
                                    "upsert",
                                    &left,
                                    &right,
                                    false,
                                )
                                .is_ok()
                        }
                        Err(_) => false,
                    };
                    outcomes.push(outcome);
                }
                Ok(outcomes)
            }),
    )
}
#[tauri::command(async)]
pub fn dedup_remove_non_duplicate(
    input: DedupNonDuplicateInput,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<()> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.into())
            .and_then(|mut connection| {
                let scope_id = input.scope_id.clone();
                let (pair_key, left, right) =
                    pair_key(&input.left_archive_id, &input.right_archive_id)?;
                remove_non_duplicate(&mut connection, input)?;
                crate::commands::sync::append_dedup_journal(
                    &mut connection,
                    &scope_id,
                    &pair_key,
                    "delete",
                    &left,
                    &right,
                    true,
                )
            }),
    )
}

#[tauri::command(async)]
pub fn dedup_list_non_duplicates(
    scope_id: String,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<Vec<DedupNonDuplicateRecord>> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.into())
            .and_then(|connection| list_non_duplicates(&connection, &scope_id)),
    )
}
async fn dedup_delete_selected_impl(
    input: DedupDeleteSelectedInput,
    sync_favorite: bool,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<DedupDeleteSelectedResult> {
    let session_id = input.session_id;
    let (server_id, selected) = {
        let connection = match database.connection.lock() {
            Ok(value) => value,
            Err(_) => {
                return crate::domain::result::CommandResult::failure(
                    "UNKNOWN",
                    crate::cache::LOCK_FAILED,
                    true,
                )
            }
        };
        let current = match session(&connection, &session_id) {
            Ok(value) if value.status == "completed" => value,
            Ok(_) => {
                return crate::domain::result::CommandResult::failure(
                    "INVALID_RESPONSE",
                    "Dedup scan is not complete",
                    false,
                )
            }
            Err(error) => {
                return crate::domain::result::CommandResult::failure(
                    "INVALID_RESPONSE",
                    error,
                    false,
                )
            }
        };
        let rejected = match selected_component_rejections(&connection, &session_id) {
            Ok(value) => value,
            Err(error) => {
                return crate::domain::result::CommandResult::failure("UNKNOWN", error, true)
            }
        };
        if !rejected.is_empty() {
            return crate::domain::result::CommandResult::success(DedupDeleteSelectedResult {
                rejected_archive_ids: rejected,
                outcomes: vec![],
            });
        }
        let (server_id, _) = match resolve_scan_scope(&connection, &current.scope_id) {
            Ok(value) => value,
            Err(error) => {
                return crate::domain::result::CommandResult::failure(
                    "INVALID_RESPONSE",
                    error,
                    false,
                )
            }
        };
        let mut statement = match connection.prepare(
            "SELECT archive_id FROM dedup_selection WHERE session_id=?1 ORDER BY archive_id",
        ) {
            Ok(value) => value,
            Err(error) => {
                return crate::domain::result::CommandResult::failure(
                    "UNKNOWN",
                    error.to_string(),
                    true,
                )
            }
        };
        let selected = match statement.query_map([&session_id], |row| row.get::<_, String>(0)) {
            Ok(rows) => rows.collect::<Result<Vec<_>, _>>(),
            Err(error) => Err(error),
        };
        let selected = match selected {
            Ok(value) => value,
            Err(error) => {
                return crate::domain::result::CommandResult::failure(
                    "UNKNOWN",
                    error.to_string(),
                    true,
                )
            }
        };
        let stale = selected.iter().filter(|archive_id| connection.query_row("SELECT EXISTS(SELECT 1 FROM archives WHERE server_id=?1 AND archive_id=?2 AND is_deleted=0)", params![server_id,archive_id], |row| row.get::<_,bool>(0)).unwrap_or(false) == false).cloned().collect::<Vec<_>>();
        if !stale.is_empty() {
            return crate::domain::result::CommandResult::success(DedupDeleteSelectedResult {
                rejected_archive_ids: stale,
                outcomes: vec![],
            });
        }
        (server_id, selected)
    };
    let mut outcomes = Vec::new();
    for archive_id in selected {
        let outcome = match crate::commands::library::delete_archive_with_favorite_sync(
            server_id.clone(),
            archive_id.clone(),
            sync_favorite,
            database.clone(),
        )
        .await
        {
            Ok(crate::domain::result::CommandResult::Success { .. }) => DedupDeletionOutcomeInput {
                archive_id,
                deleted: true,
                message: None,
            },
            Ok(crate::domain::result::CommandResult::Failure { error, .. }) => {
                DedupDeletionOutcomeInput {
                    archive_id,
                    deleted: false,
                    message: Some(error.message),
                }
            }
            Err(error) => DedupDeletionOutcomeInput {
                archive_id,
                deleted: false,
                message: Some(error),
            },
        };
        let persisted = database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.to_string())
            .and_then(|mut connection| {
                delete_selected(
                    &mut connection,
                    DedupDeleteSelectedInput {
                        session_id: session_id.clone(),
                        outcomes: vec![outcome.clone()],
                    },
                )
            });
        match persisted {
            Ok(result) => outcomes.extend(result.outcomes),
            Err(error) => {
                return crate::domain::result::CommandResult::failure("UNKNOWN", error, true)
            }
        }
    }
    crate::domain::result::CommandResult::success(DedupDeleteSelectedResult {
        rejected_archive_ids: vec![],
        outcomes,
    })
}

#[tauri::command]
pub async fn dedup_delete_selected(
    input: DedupDeleteSelectedInput,
    sync_favorite: Option<bool>,
    database: tauri::State<'_, crate::db::Database>,
) -> Result<crate::domain::result::CommandResult<DedupDeleteSelectedResult>, String> {
    Ok(dedup_delete_selected_impl(input, sync_favorite.unwrap_or(false), database).await)
}
#[tauri::command(async)]
pub fn dedup_import_readoshi(
    input: DedupImportInput,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<()> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.into())
            .and_then(|mut connection| {
                let scope_id = input.scope_id.clone();
                let pairs = input.pairs.clone();
                import_readoshi(&mut connection, input)?;
                for pair in pairs {
                    let (pair_key, left, right) =
                        pair_key(&pair.left_archive_id, &pair.right_archive_id)?;
                    crate::commands::sync::append_dedup_journal(
                        &mut connection,
                        &scope_id,
                        &pair_key,
                        "upsert",
                        &left,
                        &right,
                        false,
                    )?;
                }
                Ok(())
            }),
    )
}

fn cover_scan_pool<F: std::future::Future>(
    jobs: Vec<F>,
) -> impl futures_util::Stream<Item = F::Output> + Unpin {
    use futures_util::StreamExt;
    futures_util::stream::iter(jobs).buffer_unordered(6)
}

// A completed cover beyond a queued job must not advance the restart cursor.
struct CoverScanCheckpoint {
    checkpoint: i64,
    completed: BTreeSet<i64>,
}
impl CoverScanCheckpoint {
    fn new(checkpoint: i64) -> Self {
        Self {
            checkpoint,
            completed: BTreeSet::new(),
        }
    }
    fn complete(&mut self, index: i64) {
        if index < self.checkpoint {
            return;
        }
        self.completed.insert(index);
        while self.completed.remove(&self.checkpoint) {
            self.checkpoint += 1;
        }
    }
}

enum ScanCoverResult {
    Queued(i64),
    Complete {
        cached: bool,
        error_code: Option<String>,
        feature_failed: bool,
    },
}

async fn load_scan_cover(
    app: tauri::AppHandle,
    server_id: &str,
    scope_id: &str,
    app_data: &std::path::Path,
    archive: &DedupScanArchive,
    version: &str,
    refetch: bool,
    pending_job: Option<(i64, tokio::time::Instant)>,
) -> ScanCoverResult {
    use crate::commands::library::CoverThumbnail;
    use crate::domain::result::CommandResult;
    use tauri::Manager;
    let database = app.state::<crate::db::Database>();
    let identity = crate::cache::CacheImageIdentity::new(scope_id, &archive.archive_id, "cover", 0);
    let cached = if !refetch && pending_job.is_none() {
        crate::cache::read_cached_image(&database, app_data, &identity)
            .ok()
            .flatten()
            .filter(|image| {
                crate::cache::sniff_image_mime("application/octet-stream", &image.bytes).is_some()
            })
    } else {
        None
    };
    let (cached, result) = if let Some(image) = cached {
        (
            true,
            Ok(CommandResult::success(CoverThumbnail::Ready(image.bytes))),
        )
    } else {
        (
            false,
            crate::commands::library::load_scan_thumbnail(
                server_id,
                &archive.archive_id,
                &database,
                app_data,
                pending_job,
            )
            .await,
        )
    };
    match result {
        Ok(CommandResult::Success {
            value: CoverThumbnail::Queued(job),
            ..
        }) => ScanCoverResult::Queued(job),
        Ok(CommandResult::Success {
            value: CoverThumbnail::Ready(bytes),
            ..
        }) => {
            let scope = scope_id.to_string();
            let archive = archive.clone();
            let version = version.to_string();
            let feature = tokio::task::spawn_blocking(move || {
                compute_scan_feature(
                    &app.state::<crate::db::Database>(),
                    &scope,
                    &archive,
                    &version,
                    &bytes,
                )
            })
            .await;
            ScanCoverResult::Complete {
                cached,
                error_code: None,
                feature_failed: !matches!(feature, Ok(Ok(()))),
            }
        }
        Ok(CommandResult::Failure { error, .. }) => ScanCoverResult::Complete {
            cached,
            error_code: Some(error.code.into()),
            feature_failed: false,
        },
        Err(_) => ScanCoverResult::Complete {
            cached,
            error_code: Some("TRANSPORT_FAILED".into()),
            feature_failed: false,
        },
    }
}

fn record_scan_cover(
    progress: &mut DedupScanProgress,
    archive: &DedupScanArchive,
    result: ScanCoverResult,
) {
    if let ScanCoverResult::Complete {
        cached,
        error_code,
        feature_failed,
    } = result
    {
        if let Some(code) = error_code {
            progress.missing_covers += 1;
            progress
                .diagnostics
                .push(format!("{}: {}", archive.archive_id, code));
        } else if cached {
            progress.cache_hits += 1;
        } else {
            progress.downloads += 1;
        }
        if feature_failed {
            progress.invalid_covers += 1;
            progress
                .diagnostics
                .push("cover feature computation failed".into());
        }
        progress.processed += 1;
    }
}

async fn dedup_scan_impl(
    input: DedupScanInput,
    app: tauri::AppHandle,
    database: tauri::State<'_, crate::db::Database>,
    registry: tauri::State<'_, DedupScanRegistry>,
) -> crate::domain::result::CommandResult<DedupScanProgress> {
    if input.session_id.trim().is_empty()
        || input.scope_id.trim().is_empty()
        || input.algorithm_version.trim().is_empty()
    {
        return crate::domain::result::CommandResult::failure(
            "INVALID_RESPONSE",
            "Invalid dedup scan input",
            false,
        );
    }
    let app_data = match crate::data_paths::data_dir(&app) {
        Ok(value) => value,
        Err(error) => {
            return crate::domain::result::CommandResult::failure(
                "PLATFORM_UNAVAILABLE",
                error.to_string(),
                true,
            )
        }
    };
    let start_epoch = match date_to_epoch(input.start_date.as_deref(), false) {
        Ok(value) => value.unwrap_or(i64::MIN / 2),
        Err(error) => {
            return crate::domain::result::CommandResult::failure("INVALID_RESPONSE", error, false)
        }
    };
    let end_epoch = match date_to_epoch(input.end_date.as_deref(), true) {
        Ok(value) => value.unwrap_or(i64::MAX / 2),
        Err(error) => {
            return crate::domain::result::CommandResult::failure("INVALID_RESPONSE", error, false)
        }
    };
    if start_epoch > end_epoch {
        return crate::domain::result::CommandResult::failure(
            "INVALID_RESPONSE",
            "Invalid dedup date range",
            false,
        );
    }
    let chunk_size = input.chunk_size.unwrap_or(32).clamp(1, 256) as i64;
    let (server_id, scope_id, total, mut checkpoint) = {
        let mut connection = match database.connection.lock() {
            Ok(value) => value,
            Err(_) => {
                return crate::domain::result::CommandResult::failure(
                    "UNKNOWN",
                    crate::cache::LOCK_FAILED,
                    true,
                )
            }
        };
        let (server_id, scope_id) = match resolve_scan_scope(&connection, &input.scope_id) {
            Ok(value) => value,
            Err(error) => {
                return crate::domain::result::CommandResult::failure(
                    "INVALID_RESPONSE",
                    error,
                    false,
                )
            }
        };
        let total = match count_scan_archives(&connection, &server_id, start_epoch, end_epoch) {
            Ok(value) => value,
            Err(error) => {
                return crate::domain::result::CommandResult::failure("UNKNOWN", error, true)
            }
        };
        let current = match start_scan(
            &mut connection,
            DedupStartScanInput {
                session_id: input.session_id.clone(),
                scope_id: scope_id.clone(),
                algorithm_version: input.algorithm_version.clone(),
                archive_count: total,
            },
        ) {
            Ok(value) => value,
            Err(error) => {
                return crate::domain::result::CommandResult::failure(
                    "INVALID_RESPONSE",
                    error,
                    false,
                )
            }
        };
        (server_id, scope_id, total, current.checkpoint)
    };
    let mut progress = DedupScanProgress {
        session_id: input.session_id.clone(),
        scope_id: scope_id.clone(),
        status: "running".into(),
        stage: "covers".into(),
        processed: checkpoint,
        total,
        cache_hits: 0,
        downloads: 0,
        missing_covers: 0,
        invalid_covers: 0,
        pair_count: 0,
        degraded: false,
        checkpoint,
        diagnostics: vec![],
        pairs: vec![],
    };
    // 先播一次再干活：点击「开始扫描」后前端立刻就能画出进度条，而不是等到
    // 第一个分块下载完才有反应。
    registry.publish(&progress);
    // 共用同一张封面的档案（历史占位图，或真重复）不信任本地缓存，本次重新抓：
    // 真重复抓回来还是同一张图，占位图则会被真封面替换掉。集合只算一次。
    let refetch_covers = database
        .connection
        .lock()
        .ok()
        .and_then(|connection| cover_hashes_shared_by_multiple(&connection, &scope_id).ok())
        .unwrap_or_default();
    let mut cursor = CoverScanCheckpoint::new(checkpoint);
    let mut deferred = Vec::new();
    // checkpoint is the enumeration offset here; cursor tracks durable completion.
    while checkpoint < total {
        let cancelled = database
            .connection
            .lock()
            .ok()
            .and_then(|connection| session(&connection, &input.session_id).ok())
            .is_some_and(|current| current.status == "cancelled");
        if cancelled {
            progress.status = "cancelled".into();
            progress.stage = "cancelled".into();
            progress.checkpoint = cursor.checkpoint;
            registry.publish(&progress);
            return crate::domain::result::CommandResult::success(progress);
        }
        let archives = {
            let connection = match database.connection.lock() {
                Ok(value) => value,
                Err(_) => {
                    return crate::domain::result::CommandResult::failure(
                        "UNKNOWN",
                        crate::cache::LOCK_FAILED,
                        true,
                    )
                }
            };
            match enumerate_scan_archives(
                &connection,
                &server_id,
                start_epoch,
                end_epoch,
                checkpoint,
                chunk_size,
            ) {
                Ok(value) => value,
                Err(error) => {
                    return crate::domain::result::CommandResult::failure("UNKNOWN", error, true)
                }
            }
        };
        if archives.is_empty() {
            break;
        }
        use futures_util::StreamExt;
        let jobs = archives
            .iter()
            .cloned()
            .enumerate()
            .map(|(offset, archive)| {
                let app = app.clone();
                let server_id = &server_id;
                let scope_id = &scope_id;
                let app_data = &app_data;
                let refetch = refetch_covers.contains(&archive.archive_id);
                let version = &input.algorithm_version;
                let index = checkpoint + offset as i64;
                async move {
                    let result = load_scan_cover(
                        app, server_id, scope_id, app_data, &archive, version, refetch, None,
                    )
                    .await;
                    (index, archive, result)
                }
            })
            .collect();
        let mut pending = cover_scan_pool(jobs);
        while let Some((index, archive, result)) = pending.next().await {
            match result {
                ScanCoverResult::Queued(job) => deferred.push((
                    index,
                    archive,
                    job,
                    tokio::time::Instant::now() + std::time::Duration::from_secs(120),
                )),
                result => {
                    cursor.complete(index);
                    record_scan_cover(&mut progress, &archive, result);
                    registry.publish(&progress);
                }
            }
        }
        drop(pending);
        checkpoint += archives.len() as i64;
        let snapshots = archives
            .into_iter()
            .map(|archive| DedupArchiveSnapshotInput {
                archive_id: archive.archive_id,
                path: archive.path,
                title: archive.title,
                page_count: archive.page_count,
                size: archive.size,
                feature_version: input.algorithm_version.clone(),
            })
            .collect();
        let persisted = database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.to_string())
            .and_then(|mut connection| {
                scan_chunk(
                    &mut connection,
                    DedupScanChunkInput {
                        session_id: input.session_id.clone(),
                        algorithm_version: input.algorithm_version.clone(),
                        checkpoint: cursor.checkpoint,
                        archives: snapshots,
                        pairs: vec![],
                        selected_archive_ids: vec![],
                    },
                )
            });
        if let Err(error) = persisted {
            return crate::domain::result::CommandResult::failure("INVALID_RESPONSE", error, false);
        }
        progress.checkpoint = cursor.checkpoint;
    }
    // Only generated covers wait for Minion. Ready covers anywhere in the library
    // have already completed, regardless of how many generation jobs are queued.
    {
        use futures_util::StreamExt;
        if !deferred.is_empty() {
            progress.stage = "waiting-covers".into();
            registry.publish(&progress);
        }
        let jobs = deferred
            .into_iter()
            .map(|(index, archive, job, deadline)| {
                let app = app.clone();
                let server_id = &server_id;
                let scope_id = &scope_id;
                let app_data = &app_data;
                let version = &input.algorithm_version;
                async move {
                    let result = load_scan_cover(
                        app,
                        server_id,
                        scope_id,
                        app_data,
                        &archive,
                        version,
                        true,
                        Some((job, deadline)),
                    )
                    .await;
                    (index, archive, result)
                }
            })
            .collect();
        let mut pending = cover_scan_pool(jobs);
        // Poll cancellation while waiting, instead of waiting two minutes for a job.
        loop {
            let next = tokio::select! {
                value = pending.next() => value,
                _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {
                    let cancelled = database.connection.lock().ok()
                        .and_then(|connection| session(&connection, &input.session_id).ok())
                        .is_some_and(|current| current.status == "cancelled");
                    if cancelled {
                        progress.status = "cancelled".into();
                        progress.stage = "cancelled".into();
                        progress.checkpoint = cursor.checkpoint;
                        registry.publish(&progress);
                        return crate::domain::result::CommandResult::success(progress);
                    }
                    continue;
                }
            };
            let Some((index, archive, result)) = next else {
                break;
            };
            cursor.complete(index);
            record_scan_cover(&mut progress, &archive, result);
            let persisted = database
                .connection
                .lock()
                .map_err(|_| crate::cache::LOCK_FAILED.to_string())
                .and_then(|mut connection| {
                    scan_chunk(
                        &mut connection,
                        DedupScanChunkInput {
                            session_id: input.session_id.clone(),
                            algorithm_version: input.algorithm_version.clone(),
                            checkpoint: cursor.checkpoint,
                            archives: vec![],
                            pairs: vec![],
                            selected_archive_ids: vec![],
                        },
                    )
                });
            if let Err(error) = persisted {
                return crate::domain::result::CommandResult::failure(
                    "INVALID_RESPONSE",
                    error,
                    false,
                );
            }
            progress.checkpoint = cursor.checkpoint;
            registry.publish(&progress);
        }
    }
    if total == 0 {
        let completed = database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.to_string())
            .and_then(|mut connection| {
                scan_chunk(
                    &mut connection,
                    DedupScanChunkInput {
                        session_id: input.session_id.clone(),
                        algorithm_version: input.algorithm_version.clone(),
                        checkpoint: 0,
                        archives: vec![],
                        pairs: vec![],
                        selected_archive_ids: vec![],
                    },
                )
            });
        if let Err(error) = completed {
            return crate::domain::result::CommandResult::failure("INVALID_RESPONSE", error, false);
        }
    }
    progress.stage = "comparing".into();
    progress.processed = 0;
    // 比较阶段只需要三段数据，取完就放开连接：这个循环以前是攥着连接跑的
    // O(n²)，主线程上的同步命令全被挡在锁外，表现就是整个窗口卡死。
    let evidence = {
        let connection = match database.connection.lock() {
            Ok(value) => value,
            Err(_) => {
                return crate::domain::result::CommandResult::failure(
                    "UNKNOWN",
                    crate::cache::LOCK_FAILED,
                    true,
                )
            }
        };
        (
            load_scan_entries(
                &connection,
                &input.session_id,
                &scope_id,
                &input.algorithm_version,
            ),
            count_normalized_names(&connection, &input.session_id),
            load_excluded_pair_keys(&connection, &scope_id),
        )
    };
    let pairs = match evidence {
        (Ok(mut entries), Ok(name_counts), Ok(excluded)) => {
            distrust_placeholder_covers(&mut entries);
            progress.total = entries.len() as i64;
            registry.publish(&progress);
            compare_scan_entries(
                &entries,
                &name_counts,
                &excluded,
                &input.algorithm_version,
                COMPARE_PROGRESS_BATCH,
                |processed, total| {
                    progress.processed = processed as i64;
                    progress.total = total as i64;
                    registry.publish(&progress);
                },
            )
        }
        (entries, name_counts, excluded) => Err(entries
            .err()
            .or(name_counts.err())
            .or(excluded.err())
            .unwrap_or_else(|| "Dedup evidence unavailable".into())),
    };
    let pairs = match pairs {
        Ok(value) => value,
        Err(error) => return crate::domain::result::CommandResult::failure("UNKNOWN", error, true),
    };
    let persisted = database
        .connection
        .lock()
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
        .and_then(|mut connection| replace_pairs(&mut connection, &input.session_id, &pairs));
    if let Err(error) = persisted {
        return crate::domain::result::CommandResult::failure("UNKNOWN", error, true);
    }
    progress.pairs = pairs;
    progress.pair_count = progress.pairs.len() as i64;
    progress.degraded = progress.missing_covers > 0 || progress.invalid_covers > 0;
    progress.processed = progress.total;
    progress.checkpoint = progress.total;
    progress.status = "completed".into();
    progress.stage = "completed".into();
    registry.publish(&progress);
    crate::domain::result::CommandResult::success(progress)
}

/// 比较阶段每处理这么多条左端记录就播报一次进度：太小会频繁抢进度表的锁，
/// 太大则进度条一跳一大格。
const COMPARE_PROGRESS_BATCH: usize = 8;

#[tauri::command]
pub async fn dedup_scan(
    input: DedupScanInput,
    app: tauri::AppHandle,
    database: tauri::State<'_, crate::db::Database>,
    registry: tauri::State<'_, DedupScanRegistry>,
) -> Result<crate::domain::result::CommandResult<DedupScanProgress>, String> {
    Ok(dedup_scan_impl(input, app, database, registry).await)
}

/// 前端画进度条用；没有登记（扫描已结束或进程刚重启）时返回 null。
#[tauri::command]
pub fn dedup_scan_progress(
    session_id: String,
    registry: tauri::State<'_, DedupScanRegistry>,
) -> crate::domain::result::CommandResult<Option<DedupScanProgress>> {
    command_error(Ok(registry.read(&session_id)))
}

#[tauri::command(async)]
pub fn dedup_list_sessions(
    scope_id: String,
    include_unsaved: Option<bool>,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<Vec<DedupSessionSummary>> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.to_string())
            .and_then(|connection| list_sessions_filtered(&connection, &scope_id, 50, !include_unsaved.unwrap_or(false))),
    )
}

#[tauri::command(async)]
pub fn dedup_save_session(
    session_id: String,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<()> {
    command_error(database.connection.lock()
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())
        .and_then(|connection| save_session(&connection, &session_id)))
}

#[tauri::command(async)]
pub fn dedup_save_selection(
    session_id: String,
    selected_archive_ids: Vec<String>,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<()> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.to_string())
            .and_then(|mut connection| {
                save_selection(&mut connection, &session_id, &selected_archive_ids)
            }),
    )
}

#[tauri::command(async)]
pub fn dedup_delete_session(
    session_id: String,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<()> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| crate::cache::LOCK_FAILED.to_string())
            .and_then(|connection| delete_session(&connection, &session_id)),
    )
}

pub fn exact_hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExactHashResult {
    pub hash: String,
    pub size: u64,
}

#[derive(Debug, serde::Deserialize)]
pub struct DedupFileInput {
    pub path: String,
}

#[tauri::command(async)]
pub fn dedup_check_file(
    input: DedupFileInput,
) -> crate::domain::result::CommandResult<ExactHashResult> {
    let metadata = match std::fs::metadata(&input.path) {
        Ok(value) if value.is_file() => value,
        _ => {
            return crate::domain::result::CommandResult::failure(
                "INVALID_RESPONSE",
                "Dedup path is not a regular file",
                false,
            )
        }
    };
    match std::fs::read(&input.path) {
        Ok(bytes) => crate::domain::result::CommandResult::success(ExactHashResult {
            hash: exact_hash(&bytes),
            size: metadata.len(),
        }),
        Err(error) => crate::domain::result::CommandResult::failure(
            "REMOTE_UNAVAILABLE",
            error.to_string(),
            true,
        ),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupFeatureInput {
    pub scope_id: String,
    pub path: String,
    pub exact_hash: String,
    pub dhash: Option<String>,
    pub algorithm_version: String,
    pub size: u64,
}

#[tauri::command(async)]
pub fn dedup_save_feature(
    input: DedupFeatureInput,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<()> {
    if input.scope_id.trim().is_empty()
        || input.path.trim().is_empty()
        || input.exact_hash.len() != 64
        || !input
            .exact_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return crate::domain::result::CommandResult::failure(
            "INVALID_RESPONSE",
            "Invalid dedup feature",
            false,
        );
    }
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => {
            return crate::domain::result::CommandResult::failure(
                "UNKNOWN",
                crate::cache::LOCK_FAILED,
                true,
            )
        }
    };
    match connection.execute("INSERT INTO dedup_features (scope_id,path,exact_hash,dhash,algorithm_version,size) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(scope_id,path) DO UPDATE SET exact_hash=excluded.exact_hash,dhash=excluded.dhash,algorithm_version=excluded.algorithm_version,size=excluded.size,updated_at=CURRENT_TIMESTAMP", rusqlite::params![input.scope_id,input.path,input.exact_hash,input.dhash,input.algorithm_version,input.size]) {
        Ok(_) => crate::domain::result::CommandResult::success(()),
        Err(error) => crate::domain::result::CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupFeatureRecord {
    pub scope_id: String,
    pub path: String,
    pub exact_hash: String,
    pub dhash: Option<String>,
    pub algorithm_version: String,
    pub size: u64,
}

#[tauri::command(async)]
pub fn dedup_find_exact(
    scope_id: String,
    exact_hash: String,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<Vec<DedupFeatureRecord>> {
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => {
            return crate::domain::result::CommandResult::failure(
                "UNKNOWN",
                crate::cache::LOCK_FAILED,
                true,
            )
        }
    };
    let mut statement = match connection.prepare("SELECT scope_id,path,exact_hash,dhash,algorithm_version,size FROM dedup_features WHERE scope_id=?1 AND exact_hash=?2 ORDER BY path") { Ok(value) => value, Err(error) => return crate::domain::result::CommandResult::failure("UNKNOWN", error.to_string(), true) };
    let rows = statement
        .query_map(rusqlite::params![scope_id, exact_hash], |row| {
            Ok(DedupFeatureRecord {
                scope_id: row.get(0)?,
                path: row.get(1)?,
                exact_hash: row.get(2)?,
                dhash: row.get(3)?,
                algorithm_version: row.get(4)?,
                size: row.get(5)?,
            })
        })
        .ok();
    crate::domain::result::CommandResult::success(
        rows.map(|iter| iter.filter_map(Result::ok).collect())
            .unwrap_or_default(),
    )
}
