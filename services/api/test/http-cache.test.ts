import assert from "node:assert/strict";
import test from "node:test";
import {
  ifNoneMatchMatches,
  IMMUTABLE_PRIVATE_CACHE_CONTROL,
  strongEtag,
} from "../src/http-cache.js";

test("uses a one-year immutable private browser cache policy", () => {
  assert.equal(IMMUTABLE_PRIVATE_CACHE_CONTROL, "private, max-age=31536000, immutable");
});

test("builds a strong ETag from the media digest", () => {
  assert.equal(strongEtag("abc123"), '"abc123"');
});

test("matches strong, weak, list, and wildcard If-None-Match values", () => {
  const etag = strongEtag("abc123");
  assert.equal(ifNoneMatchMatches('"abc123"', etag), true);
  assert.equal(ifNoneMatchMatches('W/"abc123"', etag), true);
  assert.equal(ifNoneMatchMatches('"other", W/"abc123"', etag), true);
  assert.equal(ifNoneMatchMatches("*", etag), true);
  assert.equal(ifNoneMatchMatches('"other"', etag), false);
  assert.equal(ifNoneMatchMatches(undefined, etag), false);
});
