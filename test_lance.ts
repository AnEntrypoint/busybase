import { connect } from "vectordb";
import { rmSync } from "node:fs";

try { rmSync("./test_vec_dir", { recursive: true }); } catch {}
const db = await connect("./test_vec_dir");

// Vector search
const items = await db.createTable("items", [
  { id: "1", label: "cat", vector: [1, 0, 0, 0] },
  { id: "2", label: "dog", vector: [0, 1, 0, 0] },
  { id: "3", label: "fish", vector: [0, 0, 1, 0] },
]);
const results = await items.search([1, 0, 0, 0]).limit(2).execute();
console.log("vector search top1:", results[0]?.label === "cat" ? "✓" : "✗", results.map(r => `${r.label}:${r._distance.toFixed(2)}`));

// Filter with vector column (zero vec for non-vector rows)
const nums = await db.createTable("nums", [
  { id: "1", score: 10, vector: [0] },
  { id: "2", score: 20, vector: [0] },
  { id: "3", score: 30, vector: [0] },
]);
const gt15 = await nums.filter("score > 15").execute();
console.log("filter gt:", gt15.length === 2 ? "✓" : "✗");

// LIKE
const strs = await db.createTable("strs", [
  { id: "1", name: "hello world", vector: [0] },
  { id: "2", name: "goodbye", vector: [0] },
]);
try {
  const liked = await strs.filter("name LIKE '%hello%'").execute();
  console.log("LIKE:", liked.length === 1 ? "✓" : "✗");
} catch(e: any) {
  console.log("LIKE not supported:", e.message.slice(0, 80));
}

// != / neq
const neq = await nums.filter("score != 10").execute();
console.log("neq:", neq.length === 2 ? "✓" : "✗");

// ordering - LanceDB doesn't have ORDER BY natively, need to sort in JS
const all = await nums.filter("id IS NOT NULL").execute();
all.sort((a, b) => a.score - b.score);
console.log("js sort:", all.map(r => r.score).join(",") === "10,20,30" ? "✓" : "✗");

// schema: can we have mixed types (TEXT columns)?
const mixed = await db.createTable("mixed", [
  { id: "1", name: "alice", age: 30, active: true, vector: [0] }
]);
const m = await mixed.filter("id IS NOT NULL").execute();
console.log("mixed types:", m[0]?.name === "alice" ? "✓" : "✗", typeof m[0]?.age, typeof m[0]?.active);

try { rmSync("./test_vec_dir", { recursive: true }); } catch {}
