-- Per-suite test databases so vitest suites can run in parallel under turbo.
create database flow_test_storage;
create database flow_test_engine;
