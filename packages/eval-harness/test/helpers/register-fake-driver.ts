// Vitest setup file. Registers the test-only fake driver before each in-process
// test module so engine/corpus/quality tests can exercise the full pipeline
// (discover -> run -> check -> report) without Postgres, a worker, or model
// credentials. The fake driver is never shipped; it registers through the same
// public registerDriver plugin API that downstream consumers use.
import { useFakeDriver } from "./fake-driver.js";

useFakeDriver();
