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
        connection
            .execute_batch(include_str!("../migrations/0008_dedup_features.sql"))
            .expect("dedup feature schema");
        connection
            .execute_batch(include_str!("../migrations/0015_dedup_sessions.sql"))
            .expect("dedup session schema");
        connection
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
            build_pairs_bounded(&mut connection, "scan-1", "server-a", "v1", 2, 1)
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
            build_pairs_bounded(&mut connection, "scan-1", "server-a", "v1", 2, 1)
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

fn normalized_filename(value: &str) -> String {
    value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(value)
        .trim()
        .to_ascii_lowercase()
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredImageSignature {
    ratio: f64,
    pixels: Vec<u8>,
    mean: f64,
    standard_deviation: f64,
    dominant_fraction: f64,
}

fn decoded_cover_signature(bytes: &[u8]) -> Result<String, String> {
    use image::imageops::FilterType;
    let image = image::load_from_memory(bytes).map_err(|error| error.to_string())?;
    let ratio = image.width() as f64 / image.height().max(1) as f64;
    let pixels = image
        .resize_exact(16, 16, FilterType::Triangle)
        .to_rgb8()
        .into_raw();
    let luminance = pixels
        .chunks_exact(3)
        .map(|pixel| pixel[0] as f64 * 0.299 + pixel[1] as f64 * 0.587 + pixel[2] as f64 * 0.114)
        .collect::<Vec<_>>();
    let mean = luminance.iter().sum::<f64>() / luminance.len().max(1) as f64;
    let standard_deviation = (luminance
        .iter()
        .map(|value| (value - mean).powi(2))
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
    serde_json::to_string(&StoredImageSignature {
        ratio,
        pixels,
        mean,
        standard_deviation,
        dominant_fraction,
    })
    .map_err(|error| error.to_string())
}

fn signature_changed_ratio(left: &str, right: &str) -> Option<f64> {
    let left: StoredImageSignature = serde_json::from_str(left).ok()?;
    let right: StoredImageSignature = serde_json::from_str(right).ok()?;
    if (left.ratio - right.ratio).abs() > 0.1
        || (left.standard_deviation <= 12.0 && right.standard_deviation >= 32.0)
        || (right.standard_deviation <= 12.0 && left.standard_deviation >= 32.0)
        || (left.dominant_fraction >= 0.75 && right.dominant_fraction >= 0.75)
    {
        return None;
    }
    let mut differences = left
        .pixels
        .chunks_exact(3)
        .zip(right.pixels.chunks_exact(3))
        .map(|(left, right)| {
            left.iter()
                .zip(right)
                .map(|(left, right)| (*left as i32 - *right as i32).unsigned_abs())
                .sum::<u32>()
        })
        .collect::<Vec<_>>();
    if differences.is_empty() {
        return None;
    }
    let changed_ratio = differences
        .iter()
        .filter(|difference| **difference > 30)
        .count() as f64
        / differences.len() as f64;
    if changed_ratio < 0.2 {
        return Some(changed_ratio);
    }
    if changed_ratio > 0.55 {
        return None;
    }
    differences.sort_unstable();
    differences.truncate(((differences.len() as f64 * 0.85).floor() as usize).max(1));
    let tolerant_ratio = differences
        .iter()
        .filter(|difference| **difference > 30)
        .count() as f64
        / differences.len() as f64;
    (tolerant_ratio < 0.2).then_some(tolerant_ratio)
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

#[derive(Clone)]
struct ScanFeatureRecord {
    archive_id: String,
    filename: String,
    page_count: Option<i64>,
    size: Option<i64>,
    feature: Option<CoverFeature>,
}

fn load_scan_feature_chunk(
    connection: &Connection,
    session_id: &str,
    scope_id: &str,
    algorithm_version: &str,
    offset: i64,
    limit: i64,
) -> Result<Vec<ScanFeatureRecord>, String> {
    let mut statement = connection.prepare(
        "SELECT s.archive_id,COALESCE(s.title,''),s.page_count,s.size,f.exact_hash,f.dhash FROM dedup_archive_snapshots s LEFT JOIN dedup_features f ON f.scope_id=?2 AND f.path=s.archive_id AND f.algorithm_version=?3 WHERE s.session_id=?1 ORDER BY s.archive_id LIMIT ?4 OFFSET ?5",
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            params![session_id, scope_id, algorithm_version, limit, offset],
            |row| {
                let exact_hash: Option<String> = row.get(4)?;
                let signature: Option<String> = row.get(5)?;
                Ok(ScanFeatureRecord {
                    archive_id: row.get(0)?,
                    filename: row.get(1)?,
                    page_count: row.get(2)?,
                    size: row.get(3)?,
                    feature: exact_hash.zip(signature).map(|(content_hash, signature)| {
                        CoverFeature {
                            content_hash,
                            signature,
                        }
                    }),
                })
            },
        )
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn build_pairs_bounded(
    connection: &mut Connection,
    session_id: &str,
    scope_id: &str,
    algorithm_version: &str,
    total: i64,
    chunk_size: i64,
) -> Result<Vec<DedupPairInput>, String> {
    connection
        .execute("DELETE FROM dedup_pairs WHERE session_id=?1", [session_id])
        .map_err(|error| error.to_string())?;
    let mut pairs = Vec::new();
    let mut outer_offset = 0;
    while outer_offset < total {
        let outer = load_scan_feature_chunk(
            connection,
            session_id,
            scope_id,
            algorithm_version,
            outer_offset,
            chunk_size,
        )?;
        let mut inner_offset = 0;
        while inner_offset <= outer_offset {
            let inner = load_scan_feature_chunk(
                connection,
                session_id,
                scope_id,
                algorithm_version,
                inner_offset,
                chunk_size,
            )?;
            for left in &outer {
                for right in &inner {
                    if left.archive_id == right.archive_id
                        || (outer_offset == inner_offset && left.archive_id > right.archive_id)
                    {
                        continue;
                    }
                    let exact_hash_match = left
                        .feature
                        .as_ref()
                        .zip(right.feature.as_ref())
                        .is_some_and(|(a, b)| a.content_hash == b.content_hash);
                    let image_difference = left
                        .feature
                        .as_ref()
                        .zip(right.feature.as_ref())
                        .and_then(|(a, b)| {
                            if exact_hash_match {
                                Some(0.0)
                            } else {
                                signature_changed_ratio(&a.signature, &b.signature)
                            }
                        });
                    let source = if image_difference.is_some() {
                        Some("image")
                    } else if !left.filename.trim().is_empty()
                        && normalized_filename(&left.filename)
                            == normalized_filename(&right.filename)
                    {
                        Some("filename")
                    } else {
                        None
                    };
                    let Some(source) = source else {
                        continue;
                    };
                    let (key, normalized_left, normalized_right) =
                        pair_key(&left.archive_id, &right.archive_id)?;
                    let excluded: bool = connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM dedup_non_duplicates WHERE scope_id=?1 AND pair_key=?2 AND tombstoned=0)",
                        params![scope_id,key], |row| row.get(0),
                    ).map_err(|error| error.to_string())?;
                    if excluded {
                        continue;
                    }
                    let diagnostics = serde_json::json!({
                        "algorithmVersion": algorithm_version,
                        "exactHashMatch": exact_hash_match,
                        "imageDifference": image_difference,
                        "pageCountDelta": left.page_count.zip(right.page_count).map(|(a,b)| (a-b).abs()),
                        "sizeDelta": left.size.zip(right.size).map(|(a,b)| (a-b).abs()),
                    });
                    connection.execute(
                        "INSERT OR REPLACE INTO dedup_pairs (session_id,pair_key,left_archive_id,right_archive_id,source,diagnostics) VALUES (?1,?2,?3,?4,?5,?6)",
                        params![session_id,key,normalized_left,normalized_right,source,diagnostics.to_string()],
                    ).map_err(|error| error.to_string())?;
                    pairs.push(DedupPairInput {
                        left_archive_id: normalized_left,
                        right_archive_id: normalized_right,
                        source: source.into(),
                        diagnostics: Some(diagnostics),
                    });
                }
            }
            inner_offset += chunk_size;
        }
        outer_offset += chunk_size;
    }
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
    for (index, left) in archives.iter().enumerate() {
        for right in archives.iter().skip(index + 1) {
            let source_name = match (covers.get(&left.archive_id), covers.get(&right.archive_id)) {
                (Some(a), Some(b))
                    if a.content_hash == b.content_hash
                        || signature_changed_ratio(&a.signature, &b.signature).is_some() =>
                {
                    Some("image")
                }
                _ if normalized_filename(&left.filename)
                    == normalized_filename(&right.filename) =>
                {
                    Some("filename")
                }
                _ => None,
            };
            if let Some(source_name) = source_name {
                let (key, left_id, right_id) =
                    pair_key(&left.archive_id, &right.archive_id).unwrap_or_default();
                if key.is_empty() {
                    continue;
                }
                progress.pairs.push(DedupPairInput {
                    left_archive_id: left_id,
                    right_archive_id: right_id,
                    source: source_name.into(),
                    diagnostics: Some(serde_json::json!({ "algorithmVersion": algorithm_version, "scopeId": scope_id })),
                });
            }
        }
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
        "INSERT INTO dedup_sessions (id,scope_id,algorithm_version,status,checkpoint,archive_count) VALUES (?1,?2,?3,'running',0,?4) ON CONFLICT(id) DO UPDATE SET scope_id=excluded.scope_id, archive_count=excluded.archive_count, status='running', updated_at=CURRENT_TIMESTAMP",
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

pub fn save_non_duplicate(
    connection: &mut Connection,
    input: DedupNonDuplicateInput,
) -> Result<(), String> {
    required_text(&input.scope_id)?;
    let (key, left, right) = pair_key(&input.left_archive_id, &input.right_archive_id)?;
    connection.execute("INSERT INTO dedup_non_duplicates (scope_id,pair_key,left_archive_id,right_archive_id,tombstoned) VALUES (?1,?2,?3,?4,0) ON CONFLICT(scope_id,pair_key) DO UPDATE SET tombstoned=0,updated_at=CURRENT_TIMESTAMP", params![input.scope_id, key, left, right]).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn remove_non_duplicate(
    connection: &mut Connection,
    input: DedupNonDuplicateInput,
) -> Result<(), String> {
    required_text(&input.scope_id)?;
    let (key, left, right) = pair_key(&input.left_archive_id, &input.right_archive_id)?;
    connection.execute("INSERT INTO dedup_non_duplicates (scope_id,pair_key,left_archive_id,right_archive_id,tombstoned) VALUES (?1,?2,?3,?4,1) ON CONFLICT(scope_id,pair_key) DO UPDATE SET tombstoned=1,updated_at=CURRENT_TIMESTAMP", params![input.scope_id, key, left, right]).map_err(|error| error.to_string())?;
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
            "INSERT INTO dedup_non_duplicates (scope_id,pair_key,left_archive_id,right_archive_id,tombstoned) VALUES (?1,?2,?3,?4,0) ON CONFLICT(scope_id,pair_key) DO UPDATE SET tombstoned=0,updated_at=CURRENT_TIMESTAMP",
            params![input.scope_id, key, left, right],
        ).map_err(|error| error.to_string())?;
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

#[tauri::command]
pub fn dedup_start_scan(
    input: DedupStartScanInput,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<DedupScanSession> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| "Database lock failed".into())
            .and_then(|mut connection| start_scan(&mut connection, input)),
    )
}
#[tauri::command]
pub fn dedup_scan_chunk(
    input: DedupScanChunkInput,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<DedupScanSession> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| "Database lock failed".into())
            .and_then(|mut connection| scan_chunk(&mut connection, input)),
    )
}
#[tauri::command]
pub fn dedup_cancel_scan(
    session_id: String,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<DedupScanSession> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| "Database lock failed".into())
            .and_then(|mut connection| cancel_scan(&mut connection, session_id)),
    )
}
#[tauri::command]
pub fn dedup_resume_scan(
    session_id: String,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<DedupScanSession> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| "Database lock failed".into())
            .and_then(|mut connection| resume_scan(&mut connection, session_id)),
    )
}
#[tauri::command]
pub fn dedup_load_result(
    session_id: String,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<DedupLoadResult> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| "Database lock failed".into())
            .and_then(|connection| load_result(&connection, &session_id)),
    )
}
#[tauri::command]
pub fn dedup_save_non_duplicate(
    input: DedupNonDuplicateInput,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<()> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| "Database lock failed".into())
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
#[tauri::command]
pub fn dedup_remove_non_duplicate(
    input: DedupNonDuplicateInput,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<()> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| "Database lock failed".into())
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
                    "Database lock failed",
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
            .map_err(|_| "Database lock failed".to_string())
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
#[tauri::command]
pub fn dedup_import_readoshi(
    input: DedupImportInput,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<()> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| "Database lock failed".into())
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

async fn dedup_scan_impl(
    input: DedupScanInput,
    app: tauri::AppHandle,
    database: tauri::State<'_, crate::db::Database>,
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
                    "Database lock failed",
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
            progress.checkpoint = checkpoint;
            return crate::domain::result::CommandResult::success(progress);
        }
        let archives = {
            let connection = match database.connection.lock() {
                Ok(value) => value,
                Err(_) => {
                    return crate::domain::result::CommandResult::failure(
                        "UNKNOWN",
                        "Database lock failed",
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
        for archive in &archives {
            let identity =
                crate::cache::CacheImageIdentity::new(&scope_id, &archive.archive_id, "cover", 0);
            let (had_cache_entry, cached) = match database.connection.lock() {
                Ok(connection) => {
                    let key = crate::cache::image_cache_key(&identity);
                    let existed = connection
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM cache_entries WHERE key=?1)",
                            [key],
                            |row| row.get::<_, bool>(0),
                        )
                        .unwrap_or(false);
                    (
                        existed,
                        crate::cache::load_image_cache(&connection, &app_data, &identity),
                    )
                }
                Err(_) => {
                    return crate::domain::result::CommandResult::failure(
                        "UNKNOWN",
                        "Database lock failed",
                        true,
                    )
                }
            };
            let bytes = match cached {
                Ok(Some(image)) => {
                    progress.cache_hits += 1;
                    Some(image.bytes)
                }
                Ok(None) => {
                    if had_cache_entry {
                        progress.invalid_covers += 1;
                        progress.diagnostics.push(format!(
                            "{}: corrupt cached cover replaced",
                            archive.archive_id
                        ));
                    }
                    match crate::commands::library::load_archive_thumbnail_bytes(
                        server_id.clone(),
                        archive.archive_id.clone(),
                        database.clone(),
                        app.clone(),
                    )
                    .await
                    {
                        Ok(crate::domain::result::CommandResult::Success { value, .. }) => {
                            progress.downloads += 1;
                            Some(value)
                        }
                        Ok(crate::domain::result::CommandResult::Failure { error, .. }) => {
                            progress.missing_covers += 1;
                            progress
                                .diagnostics
                                .push(format!("{}: {}", archive.archive_id, error.message));
                            None
                        }
                        Err(error) => {
                            progress.missing_covers += 1;
                            progress
                                .diagnostics
                                .push(format!("{}: {error}", archive.archive_id));
                            None
                        }
                    }
                }
                Err(error) => {
                    progress.invalid_covers += 1;
                    progress
                        .diagnostics
                        .push(format!("{}: {error}", archive.archive_id));
                    None
                }
            };
            if let Some(bytes) = bytes {
                let feature = database
                    .connection
                    .lock()
                    .map_err(|_| "Database lock failed".to_string())
                    .and_then(|connection| {
                        load_or_compute_feature(
                            &connection,
                            &scope_id,
                            archive,
                            &input.algorithm_version,
                            &bytes,
                        )
                    });
                if let Err(error) = feature {
                    progress.invalid_covers += 1;
                    progress.diagnostics.push(format!(
                        "{}: cover decode failed ({error})",
                        archive.archive_id
                    ));
                }
            }
        }
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
            .map_err(|_| "Database lock failed".to_string())
            .and_then(|mut connection| {
                scan_chunk(
                    &mut connection,
                    DedupScanChunkInput {
                        session_id: input.session_id.clone(),
                        algorithm_version: input.algorithm_version.clone(),
                        checkpoint,
                        archives: snapshots,
                        pairs: vec![],
                        selected_archive_ids: vec![],
                    },
                )
            });
        if let Err(error) = persisted {
            return crate::domain::result::CommandResult::failure("INVALID_RESPONSE", error, false);
        }
        progress.processed = checkpoint;
        progress.checkpoint = checkpoint;
    }
    if total == 0 {
        let completed = database
            .connection
            .lock()
            .map_err(|_| "Database lock failed".to_string())
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
    let pairs = database
        .connection
        .lock()
        .map_err(|_| "Database lock failed".to_string())
        .and_then(|mut connection| {
            build_pairs_bounded(
                &mut connection,
                &input.session_id,
                &scope_id,
                &input.algorithm_version,
                total,
                chunk_size,
            )
        });
    progress.pairs = match pairs {
        Ok(value) => value,
        Err(error) => return crate::domain::result::CommandResult::failure("UNKNOWN", error, true),
    };
    progress.pair_count = progress.pairs.len() as i64;
    progress.degraded = progress.missing_covers > 0 || progress.invalid_covers > 0;
    progress.status = "completed".into();
    progress.stage = "completed".into();
    crate::domain::result::CommandResult::success(progress)
}

#[tauri::command]
pub async fn dedup_scan(
    input: DedupScanInput,
    app: tauri::AppHandle,
    database: tauri::State<'_, crate::db::Database>,
) -> Result<crate::domain::result::CommandResult<DedupScanProgress>, String> {
    Ok(dedup_scan_impl(input, app, database).await)
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

#[tauri::command]
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

#[tauri::command]
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
                "Database lock failed",
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

#[tauri::command]
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
                "Database lock failed",
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
