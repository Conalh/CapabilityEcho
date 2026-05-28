import test from "node:test";
import assert from "node:assert";
import { sum } from "../src/sum.js";
test("sums", () => { assert.equal(sum([1, 2, 3]), 6); });
