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
        let entry = |signature: StoredImageSignature| ScanEntry {
            archive_id: "a".into(),
            filename: String::new(),
            page_count: Some(10),
            size: Some(100),
            content_hash: None,
            signature: Some(signature),
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

fn filename_evidence(left: &str, right: &str) -> (FilenameEvidence, String) {
    let left_name = normalized_filename(left);
    let right_name = normalized_filename(right);
    if !left_name.is_empty() && left_name == right_name {
        if left_name.chars().count() >= 12 {
            return (FilenameEvidence::Exact, left_name);
        }
        return (FilenameEvidence::None, left_name);
    }
    let similar = filename_similarity(&left_name, &right_name) >= 0.92;
    (
        if similar { FilenameEvidence::Similar } else { FilenameEvidence::None },
        left_name,
    )
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
    page_count: Option<i64>,
    size: Option<i64>,
    content_hash: Option<String>,
    signature: Option<StoredImageSignature>,
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
            Ok(ScanEntry {
                archive_id: row.get(0)?,
                filename: row.get(1)?,
                page_count: row.get(2)?,
                size: row.get(3)?,
                content_hash: exact_hash,
                signature,
            })
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

fn build_pairs_bounded(
    connection: &mut Connection,
    session_id: &str,
    scope_id: &str,
    algorithm_version: &str,
) -> Result<Vec<DedupPairInput>, String> {
    connection
        .execute("DELETE FROM dedup_pairs WHERE session_id=?1", [session_id])
        .map_err(|error| error.to_string())?;
    let name_counts = count_normalized_names(connection, session_id)?;
    let base_options = SignatureComparisonOptions::default();
    let entries = load_scan_entries(connection, session_id, scope_id, algorithm_version)?;
    let mut pairs = Vec::new();
    for (left_index, left) in entries.iter().enumerate() {
        for right in entries.iter().skip(left_index + 1) {
            // 文件名证据 + 全局同名计数（Readoshi 的 evidence/nameCounts）。
            let (evidence, evidence_name) =
                filename_evidence(&left.filename, &right.filename);
            let name_count = name_counts.get(&evidence_name).copied().unwrap_or(0);
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
            let excluded: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM dedup_non_duplicates WHERE scope_id=?1 AND pair_key=?2 AND tombstoned=0)",
                params![scope_id,key], |row| row.get(0),
            ).map_err(|error| error.to_string())?;
            if excluded {
                continue;
            }
            let diagnostics = serde_json::json!({
                "algorithmVersion": algorithm_version,
                "exactHashMatch": left.content_hash.as_ref().zip(right.content_hash.as_ref()).is_some_and(|(a, b)| a == b),
                "imageDifference": image_score,
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
    let base_options = SignatureComparisonOptions::default();
    for (index, left) in archives.iter().enumerate() {
        for right in archives.iter().skip(index + 1) {
            let (evidence, evidence_name) = filename_evidence(&left.filename, &right.filename);
            let name_count = name_counts.get(&evidence_name).copied().unwrap_or(0);
            let exact_filename_pair = evidence == FilenameEvidence::Exact
                && name_count <= 2
                && !left.filename.trim().is_empty();
            let pair_entry = |archive: &DedupScanArchive, feature: Option<&CoverFeature>| ScanEntry {
                archive_id: archive.archive_id.clone(),
                filename: archive.filename.clone(),
                page_count: archive.page_count,
                size: archive.size,
                content_hash: feature.map(|feature| feature.content_hash.clone()),
                signature: feature.and_then(|feature| serde_json::from_str(&feature.signature).ok()),
            };
            let left_entry = pair_entry(left, covers.get(&left.archive_id));
            let right_entry = pair_entry(right, covers.get(&right.archive_id));
            let source_name = match pair_image_match(
                &left_entry,
                &right_entry,
                evidence,
                name_count,
                &base_options,
            ) {
                Some(_) => Some("image"),
                None if exact_filename_pair => Some("filename"),
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

#[tauri::command]
pub fn dedup_list_non_duplicates(
    scope_id: String,
    database: tauri::State<'_, crate::db::Database>,
) -> crate::domain::result::CommandResult<Vec<DedupNonDuplicateRecord>> {
    command_error(
        database
            .connection
            .lock()
            .map_err(|_| "Database lock failed".into())
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
