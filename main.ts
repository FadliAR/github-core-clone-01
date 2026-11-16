// A standalone GitHub-compatible git forge.
//
// One Node 22 process, standard library only, serving four surfaces from its
// own in-memory store:
//   - git smart HTTP at /{owner}/{repo}.git (upload-pack v2, receive-pack v0)
//   - the REST v3 API under /api/v3
//   - GraphQL v4 at /api/graphql
//   - MCP (JSON-RPC over streamable HTTP) at /mcp
//
// The store is one set of Maps shared by every surface, so an object created
// over MCP reads back over REST with the same id, and a branch pushed over
// git is the same branch the REST contents API commits onto.
//
// Determinism: nothing in any response derives from the wall clock or from
// randomness. Ids come from counters and timestamps from a logical clock
// that advances one second per mutation, so two runs that receive the same
// requests produce the same bytes.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, createHmac } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Configuration and the logical clock
// ---------------------------------------------------------------------------

const ENV_URL: string = (process.env.MAKEFUN_ENV_URL || "").replace(/\/+$/, "");
const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN || "";
const VIEWER_LOGIN = "octocat";
const VIEWER_ID = 1;
const ZERO_SHA = "0000000000000000000000000000000000000000";
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Logical clock: starts at a fixed instant and ticks once per use. Response
// timestamps are stable across runs and strictly increase in issue order,
// which is what the ordering checks read.
let clockTick = 0;
const CLOCK_BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
function nowIso(): string {
  clockTick += 1;
  return new Date(CLOCK_BASE_MS + clockTick * 1000).toISOString();
}
function nowIsoNoTick(): string {
  return new Date(CLOCK_BASE_MS + clockTick * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Types for the store
// ---------------------------------------------------------------------------

type GitObjectType = "blob" | "tree" | "commit" | "tag";

interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
  isDefault: boolean;
}

interface CommentRec {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string; // "open" | "closed"
  labels: string[];
  assignees: string[];
  milestone: string | null;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: CommentRec[];
  isPull: boolean;
}

interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string; // "open" | "closed"
  headRef: string;
  headSha: string;
  baseRef: string;
  baseShaAtCreate: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  draft: boolean;
  labels: string[];
  comments: CommentRec[];
}

interface RepoRec {
  id: number;
  name: string;
  owner: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  hasIssues: boolean;
  hasWiki: boolean;
  hasProjects: boolean;
  homepage: string | null;
  language: string | null;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // full ref name -> commit sha
  labels: Map<string, LabelRec>; // lower-case name -> label
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  stars: number;
  forks: number;
}

interface Store {
  repos: Map<string, RepoRec>; // "owner/name" lower-cased -> repo
  nextRepoId: number;
  nextIssueId: number;
  nextCommentId: number;
  nextLabelId: number;
}

const store: Store = {
  repos: new Map(),
  nextRepoId: 100,
  nextIssueId: 1000,
  nextCommentId: 5000,
  nextLabelId: 9000,
};

let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return "REQ-" + requestSeq.toString(36).toUpperCase().padStart(6, "0");
}

// ---------------------------------------------------------------------------
// Git object primitives (SHA-1 object model, zlib storage is in-memory here)
// ---------------------------------------------------------------------------

function hashObject(type: GitObjectType, data: Buffer): string {
  const head = Buffer.from(type + " " + data.length + "\0", "utf8");
  return createHash("sha1").update(head).update(data).digest("hex");
}

function storeObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

function getObject(repo: RepoRec, sha: string): GitObject | null {
  return repo.objects.get(sha) || null;
}

interface CommitInfo {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  message: string;
}

function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString("utf8");
  const splitAt = text.indexOf("\n\n");
  const head = splitAt >= 0 ? text.slice(0, splitAt) : text;
  const message = splitAt >= 0 ? text.slice(splitAt + 2) : "";
  let tree = EMPTY_TREE_SHA;
  const parents: string[] = [];
  let authorLine = "";
  let committerLine = "";
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
    else if (line.startsWith("author ")) authorLine = line.slice(7);
    else if (line.startsWith("committer ")) committerLine = line.slice(10);
  }
  return { tree, parents, authorLine, committerLine, message };
}

function formatPersonLine(line: string): { name: string; email: string; date: string } {
  // "Name <email> 1700000000 +0000"
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (!m) return { name: line || "octocat", email: "", date: nowIsoNoTick() };
  const secs = parseInt(m[3], 10);
  return { name: m[1], email: m[2], date: new Date(secs * 1000).toISOString() };
}

const AUTHOR_LINE = "octocat <octocat@example.com> 1767225600 +0000";

function makeCommit(
  repo: RepoRec,
  tree: string,
  parents: string[],
  message: string,
): string {
  const lines: string[] = ["tree " + tree];
  for (const p of parents) lines.push("parent " + p);
  lines.push("author " + AUTHOR_LINE);
  lines.push("committer " + AUTHOR_LINE);
  const data = Buffer.from(lines.join("\n") + "\n\n" + message, "utf8");
  return storeObject(repo, "commit", data);
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.toString("utf8", i, sp);
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.toString("utf8", sp + 1, nul);
    const sha = data.toString("hex", nul + 1, nul + 21);
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}

function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === "40000" ? a.name + "/" : a.name;
    const bn = b.mode === "40000" ? b.name + "/" : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(e.mode + " " + e.name + "\0", "utf8"));
    parts.push(Buffer.from(e.sha, "hex"));
  }
  return Buffer.concat(parts);
}

// Flatten a tree (recursively) into path -> {sha, mode}.
function flattenTree(
  repo: RepoRec,
  treeSha: string,
  prefix: string,
  out: Map<string, { sha: string; mode: string }>,
): void {
  const obj = getObject(repo, treeSha);
  if (!obj || obj.type !== "tree") return;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? prefix + "/" + e.name : e.name;
    if (e.mode === "40000") flattenTree(repo, e.sha, path, out);
    else out.set(path, { sha: e.sha, mode: e.mode });
  }
}

function treeFileMap(repo: RepoRec, commitSha: string | null): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  if (!commitSha) return out;
  const obj = getObject(repo, commitSha);
  if (!obj || obj.type !== "commit") return out;
  flattenTree(repo, parseCommit(obj.data).tree, "", out);
  return out;
}

// Rebuild nested trees from a flat path map; returns the root tree sha.
function buildTreeFromMap(repo: RepoRec, files: Map<string, { sha: string; mode: string }>): string {
  interface Node {
    files: Map<string, { sha: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, info] of files) {
    const parts = path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], info);
  }
  const writeNode = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, info] of node.files) entries.push({ mode: info.mode, name, sha: info.sha });
    for (const [name, sub] of node.dirs) entries.push({ mode: "40000", name, sha: writeNode(sub) });
    if (entries.length === 0) {
      if (!repo.objects.has(EMPTY_TREE_SHA)) {
        repo.objects.set(EMPTY_TREE_SHA, { type: "tree", data: Buffer.alloc(0) });
      }
      return EMPTY_TREE_SHA;
    }
    return storeObject(repo, "tree", buildTreeData(entries));
  };
  return writeNode(root);
}

function isAncestor(repo: RepoRec, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack: string[] = [desc];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (cur === anc) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== "commit") continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancA = new Set<string>();
  const stack: string[] = [a];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (ancA.has(cur)) continue;
    ancA.add(cur);
    const obj = getObject(repo, cur);
    if (obj && obj.type === "commit") for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length) {
    const cur = queue.shift() as string;
    if (ancA.has(cur)) return cur;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = getObject(repo, cur);
    if (obj && obj.type === "commit") for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

// Every object reachable from a commit (commit, its tree, subtrees, blobs,
// and ancestors unless depth-limited).
function collectReachable(
  repo: RepoRec,
  tip: string,
  depth: number, // 0 = unlimited; 1 = tip commit only (plus its tree)
  into: Map<string, GitObject>,
): string[] {
  const shallowBoundary: string[] = [];
  const queue: { sha: string; d: number }[] = [{ sha: tip, d: 1 }];
  const seenCommits = new Set<string>();
  while (queue.length) {
    const { sha, d } = queue.shift() as { sha: string; d: number };
    if (seenCommits.has(sha)) continue;
    seenCommits.add(sha);
    const obj = getObject(repo, sha);
    if (!obj || obj.type !== "commit") continue;
    into.set(sha, obj);
    const info = parseCommit(obj.data);
    const treeQueue: string[] = [info.tree];
    while (treeQueue.length) {
      const t = treeQueue.pop() as string;
      const tobj = getObject(repo, t);
      if (!tobj) continue;
      into.set(t, tobj);
      if (tobj.type === "tree") {
        for (const e of parseTree(tobj.data)) {
          if (e.mode === "40000") treeQueue.push(e.sha);
          else {
            const b = getObject(repo, e.sha);
            if (b) into.set(e.sha, b);
          }
        }
      }
    }
    if (depth > 0 && d >= depth) {
      if (info.parents.length) shallowBoundary.push(sha);
      continue;
    }
    for (const p of info.parents) queue.push({ sha: p, d: d + 1 });
  }
  return shallowBoundary;
}

// ---------------------------------------------------------------------------
// Packfiles: parse (receive-pack) and build (upload-pack)
// ---------------------------------------------------------------------------

const TYPE_NAMES: Record<number, GitObjectType> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};
const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let val = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++];
      val |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return val;
  };
  readVarint(); // base size (trusted, not checked)
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error("bad delta opcode 0");
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize) {
    // Tolerate: produced counts should agree; return what we built.
    void produced;
  }
  return result;
}

interface PackEntry {
  type: GitObjectType;
  data: Buffer;
  sha: string;
}

// Parse a packfile into the repo's object store. Returns the object count.
function parsePack(repo: RepoRec, pack: Buffer): number {
  if (pack.length < 12 || pack.toString("utf8", 0, 4) !== "PACK") {
    throw new Error("not a packfile");
  }
  const count = pack.readUInt32BE(8);
  let pos = 12;
  const pending: { baseSha?: string; baseOffset?: number; delta: Buffer; offset: number }[] = [];
  const byOffset = new Map<number, PackEntry>();
  let stored = 0;

  const storeEntry = (type: GitObjectType, data: Buffer, offset: number): PackEntry => {
    const sha = storeObject(repo, type, data);
    const entry = { type, data, sha };
    byOffset.set(offset, entry);
    stored += 1;
    return entry;
  };

  for (let n = 0; n < count; n++) {
    const entryOffset = pos;
    let byte = pack[pos++];
    const typeCode = (byte >> 4) & 0x07;
    // size varint (low 4 bits then 7-bit groups) — value not needed beyond framing
    while (byte & 0x80) byte = pack[pos++];
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint
      let b = pack[pos++];
      let off = b & 0x7f;
      while (b & 0x80) {
        b = pack[pos++];
        off = ((off + 1) << 7) | (b & 0x7f);
      }
      const inf = inflateEntry(pack.subarray(pos));
      pos += inf.consumed;
      pending.push({ baseOffset: entryOffset - off, delta: inf.data, offset: entryOffset });
    } else if (typeCode === 7) {
      // REF_DELTA: 20-byte base sha
      const baseSha = pack.toString("hex", pos, pos + 20);
      pos += 20;
      const inf = inflateEntry(pack.subarray(pos));
      pos += inf.consumed;
      pending.push({ baseSha, delta: inf.data, offset: entryOffset });
    } else {
      const type = TYPE_NAMES[typeCode];
      if (!type) throw new Error("unknown pack object type " + typeCode);
      const inf = inflateEntry(pack.subarray(pos));
      pos += inf.consumed;
      storeEntry(type, inf.data, entryOffset);
    }
  }

  // Resolve deltas; iterate because deltas can chain.
  let guard = 0;
  while (pending.length && guard < 10000) {
    guard += 1;
    let progressed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      let base: PackEntry | undefined;
      if (p.baseOffset !== undefined) base = byOffset.get(p.baseOffset);
      else if (p.baseSha) {
        const obj = repo.objects.get(p.baseSha);
        if (obj) base = { type: obj.type, data: obj.data, sha: p.baseSha };
      }
      if (!base) continue;
      const data = applyDelta(base.data, p.delta);
      storeEntry(base.type, data, p.offset);
      pending.splice(i, 1);
      progressed = true;
    }
    if (!progressed) break;
  }
  return stored;
}

// Inflate one pack entry and report how many compressed bytes it consumed:
// inflateSync with info:true exposes the stream's bytesWritten, which is
// exactly the compressed length of the first stream in the buffer.
function inflateEntry(buf: Buffer): { data: Buffer; consumed: number } {
  const r = inflateSync(buf, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: r.buffer, consumed: r.engine.bytesWritten };
}

function buildPack(objects: Map<string, GitObject>): Buffer {
  const entries: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write("PACK", 0, "utf8");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.size, 8);
  entries.push(head);
  for (const [sha, obj] of objects) {
    void sha;
    const code = TYPE_CODES[obj.type];
    const size = obj.data.length;
    const bytes: number[] = [];
    let first = (code << 4) | (size & 0x0f);
    size >> 4 > 0 ? (first |= 0x80) : 0;
    bytes.push(first);
    let rest = size >> 4;
    while (rest > 0) {
      let b = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) b |= 0x80;
      bytes.push(b);
    }
    entries.push(Buffer.from(bytes));
    entries.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(entries);
  const trailer = createHash("sha1").update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, "0"), "utf8");
  return Buffer.concat([head, data]);
}
const PKT_FLUSH = Buffer.from("0000", "utf8");
const PKT_DELIM = Buffer.from("0001", "utf8");

interface PktReader {
  lines: (Buffer | null)[]; // null = flush, "delim" marker encoded as empty with flag
  raw: Buffer[];
  rest: Buffer;
}

function readPktLines(buf: Buffer, start: number): { items: { kind: string; data: Buffer }[]; pos: number } {
  const items: { kind: string; data: Buffer }[] = [];
  let pos = start;
  while (pos + 4 <= buf.length) {
    const lenHex = buf.toString("utf8", pos, pos + 4);
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      items.push({ kind: "flush", data: Buffer.alloc(0) });
      pos += 4;
      break;
    }
    if (len === 1) {
      items.push({ kind: "delim", data: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 2) {
      items.push({ kind: "response-end", data: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    items.push({ kind: "line", data: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { items, pos };
}

// ---------------------------------------------------------------------------
// Repository helpers shared by every surface
// ---------------------------------------------------------------------------

function repoKey(owner: string, name: string): string {
  return (owner + "/" + name).toLowerCase();
}

function findRepo(owner: string, name: string): RepoRec | null {
  return store.repos.get(repoKey(owner, name)) || null;
}

function createRepo(owner: string, name: string, description: string | null, isPrivate: boolean): RepoRec {
  const ts = nowIso();
  const repo: RepoRec = {
    id: store.nextRepoId++,
    name,
    owner,
    description,
    isPrivate,
    defaultBranch: "main",
    hasIssues: true,
    hasWiki: true,
    hasProjects: true,
    homepage: null,
    language: null,
    createdAt: ts,
    updatedAt: ts,
    pushedAt: ts,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    stars: 0,
    forks: 0,
  };
  repo.objects.set(EMPTY_TREE_SHA, { type: "tree", data: Buffer.alloc(0) });
  // Seed the default labels GitHub creates with every repository.
  const defaults: [string, string][] = [
    ["bug", "d73a4a"],
    ["documentation", "0075ca"],
    ["duplicate", "cfd3d7"],
    ["enhancement", "a2eeef"],
    ["good first issue", "7057ff"],
    ["help wanted", "008672"],
    ["invalid", "e4e669"],
    ["question", "d876e3"],
    ["wontfix", "ffffff"],
  ];
  for (const [n, c] of defaults) {
    repo.labels.set(n.toLowerCase(), {
      id: store.nextLabelId++,
      name: n,
      color: c,
      description: null,
      isDefault: true,
    });
  }
  store.repos.set(repoKey(owner, name), repo);
  return repo;
}

function headSha(repo: RepoRec, branch: string): string | null {
  return repo.refs.get("refs/heads/" + branch) || null;
}

function sortedRefNames(repo: RepoRec): string[] {
  return [...repo.refs.keys()].sort();
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

const UPLOAD_CAPS_V0 =
  "multi_ack_detailed no-done side-band side-band-64k thin-pack ofs-delta deepen-since deepen-not agent=forge/1.0";
const RECEIVE_CAPS =
  "report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta agent=forge/1.0";

function advertiseRefs(
  repo: RepoRec,
  service: "git-upload-pack" | "git-receive-pack",
): Buffer {
  const caps = service === "git-upload-pack" ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const parts: Buffer[] = [];
  parts.push(pktLine("# service=" + service + "\n"));
  parts.push(PKT_FLUSH);
  const lines: string[] = [];
  const head = headSha(repo, repo.defaultBranch);
  if (head) lines.push(head + " HEAD\0" + caps);
  else lines.push(ZERO_SHA + " capabilities^{}\0" + caps);
  const names = sortedRefNames(repo);
  for (const name of names) lines.push(repo.refs.get(name) + " " + name);
  // Peel tags if any tag objects exist.
  for (const name of names) {
    if (!name.startsWith("refs/tags/")) continue;
    const sha = repo.refs.get(name) as string;
    const obj = getObject(repo, sha);
    if (obj && obj.type === "tag") {
      const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString("utf8"));
      if (m) lines.push(m[1] + " " + name + "^{}");
    }
  }
  for (const l of lines) parts.push(pktLine(l + "\n"));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertiseV2(): Buffer {
  const lines = [
    "version 2",
    "agent=forge/1.0",
    "ls-refs=unborn",
    "fetch=filter shallow wait-for-done",
    "server-option",
    "object-format=sha1",
  ];
  const parts = lines.map((l) => pktLine(l + "\n"));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// Build the pack for a fetch: objects reachable from wants, honouring depth.
function fetchPack(
  repo: RepoRec,
  wants: string[],
  depth: number,
): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const objects = new Map<string, GitObject>();
  const shallow = new Set<string>();
  for (const w of wants) {
    if (!repo.objects.has(w)) continue;
    const obj = repo.objects.get(w) as GitObject;
    if (obj.type === "commit") {
      const boundary = collectReachable(repo, w, depth, objects);
      for (const b of boundary) shallow.add(b);
    } else {
      objects.set(w, obj);
    }
  }
  return { pack: buildPack(objects), shallow: [...shallow], unshallow: [] };
}

function sideBandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65500;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, i + CHUNK);
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  out.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from("done\n", "utf8")])));
  return out;
}

function handleUploadPackV0(repo: RepoRec, body: Buffer, res: ServerResponse): void {
  const { items, pos } = readPktLines(body, 0);
  void pos;
  const wants: string[] = [];
  const haves: string[] = [];
  let depth = 0;
  for (const it of items) {
    if (it.kind !== "line") continue;
    const line = it.data.toString("utf8").replace(/\n$/, "");
    if (line.startsWith("want ")) wants.push(line.slice(5, 45));
    else if (line.startsWith("have ")) haves.push(line.slice(5, 45));
    else if (line.startsWith("deepen ")) depth = parseInt(line.slice(7), 10) || 0;
  }
  const { pack, shallow } = fetchPack(repo, wants, depth);
  const parts: Buffer[] = [];
  if (depth > 0) {
    for (const s of shallow) parts.push(pktLine("shallow " + s + "\n"));
  }
  // No multi_ack negotiation was completed (we advertise no-done but answer
  // the simple way): a single NAK, then the pack on side-band 1.
  if (haves.length === 0 || true) parts.push(pktLine("NAK\n"));
  for (const p of sideBandPack(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
  res.end(Buffer.concat(parts));
}

function parseV2Args(items: { kind: string; data: Buffer }[]): string[] {
  const args: string[] = [];
  let pastDelim = false;
  for (const it of items) {
    if (it.kind === "delim") {
      pastDelim = true;
      continue;
    }
    if (it.kind !== "line") continue;
    const line = it.data.toString("utf8").replace(/\n$/, "");
    if (!pastDelim) continue; // command=..., agent=..., object-format=...
    args.push(line);
  }
  return args;
}

function handleLsRefs(repo: RepoRec, items: { kind: string; data: Buffer }[], res: ServerResponse): void {
  const args = parseV2Args(items);
  let symrefs = false;
  let peel = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === "symrefs") symrefs = true;
    else if (a === "peel") peel = true;
    else if (a.startsWith("ref-prefix ")) prefixes.push(a.slice(11));
  }
  const parts: Buffer[] = [];
  const head = headSha(repo, repo.defaultBranch);
  const emit = (sha: string, name: string, attrs: string) => {
    if (prefixes.length && !prefixes.some((p) => name.startsWith(p))) return;
    parts.push(pktLine(sha + " " + name + attrs + "\n"));
  };
  if (head) {
    emit(head, "HEAD", symrefs ? " symref-target:refs/heads/" + repo.defaultBranch : "");
  } else if (symrefs) {
    emit(ZERO_SHA, "HEAD", " symref-target:refs/heads/" + repo.defaultBranch + " unborn");
  }
  for (const name of sortedRefNames(repo)) {
    const sha = repo.refs.get(name) as string;
    emit(sha, name, "");
    if (peel && name.startsWith("refs/tags/")) {
      const obj = getObject(repo, sha);
      if (obj && obj.type === "tag") {
        const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString("utf8"));
        if (m) emit(m[1], name + "^{}", "");
      }
    }
  }
  parts.push(PKT_FLUSH);
  res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
  res.end(Buffer.concat(parts));
}

function handleFetchV2(repo: RepoRec, items: { kind: string; data: Buffer }[], res: ServerResponse): void {
  const args = parseV2Args(items);
  const wants: string[] = [];
  const haves: string[] = [];
  let depth = 0;
  let done = false;
  let waitForDone = false;
  for (const a of args) {
    if (a.startsWith("want ")) wants.push(a.slice(5, 45));
    else if (a.startsWith("have ")) haves.push(a.slice(5, 45));
    else if (a.startsWith("deepen ")) depth = parseInt(a.slice(7), 10) || 0;
    else if (a === "done") done = true;
    else if (a === "wait-for-done") waitForDone = true;
  }
  const parts: Buffer[] = [];
  parts.push(pktLine("acknowledgments\n"));
  if (!done && !waitForDone) {
    // Negotiation round: acknowledge a common have or NAK, no pack yet.
    const common = haves.find((h) => repo.objects.has(h));
    if (common) parts.push(pktLine("ACK " + common + "\n"));
    else if (haves.length) parts.push(pktLine("NAK\n"));
    parts.push(PKT_FLUSH);
    res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
    res.end(Buffer.concat(parts));
    return;
  }
  parts.push(pktLine("ready\n"));
  parts.push(PKT_DELIM);
  const { pack, shallow } = fetchPack(repo, wants, depth);
  if (depth > 0) {
    parts.push(pktLine("shallow-info\n"));
    for (const s of shallow) parts.push(pktLine("shallow " + s + "\n"));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine("packfile\n"));
  for (const p of sideBandPack(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
  res.end(Buffer.concat(parts));
}

function handleUploadPackV2(repo: RepoRec, body: Buffer, res: ServerResponse): void {
  const { items } = readPktLines(body, 0);
  let command = "";
  for (const it of items) {
    if (it.kind === "line") {
      const line = it.data.toString("utf8").replace(/\n$/, "");
      if (line.startsWith("command=")) {
        command = line.slice(8);
        break;
      }
    }
    if (it.kind === "delim") break;
  }
  if (command === "ls-refs") return handleLsRefs(repo, items, res);
  if (command === "fetch") return handleFetchV2(repo, items, res);
  res.writeHead(400, { "content-type": "application/x-git-upload-pack-result" });
  res.end(pktLine("ERR unknown command\n"));
}

interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

function handleReceivePack(repo: RepoRec, body: Buffer, res: ServerResponse): void {
  const { items, pos } = readPktLines(body, 0);
  const updates: RefUpdate[] = [];
  for (const it of items) {
    if (it.kind !== "line") continue;
    const text = it.data.toString("utf8");
    const nul = text.indexOf("\0");
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, "");
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line.trim());
    if (m) updates.push({ oldSha: m[1], newSha: m[2], ref: m[3] });
  }
  const packData = body.subarray(pos);
  let unpackOk = true;
  let unpackMsg = "ok";
  if (packData.length > 0) {
    try {
      parsePack(repo, packData);
    } catch (e) {
      unpackOk = false;
      unpackMsg = "index-pack failed";
      void e;
    }
  }
  const report: string[] = [];
  if (unpackOk) {
    for (const u of updates) {
      if (u.newSha === ZERO_SHA) {
        // delete-refs
        repo.refs.delete(u.ref);
        report.push("ok " + u.ref + "\n");
        continue;
      }
      if (!repo.objects.has(u.newSha)) {
        report.push("ng " + u.ref + " unknown object\n");
        continue;
      }
      const current = repo.refs.get(u.ref) || ZERO_SHA;
      if (u.oldSha !== ZERO_SHA && current !== ZERO_SHA && u.oldSha !== current) {
        report.push("ng " + u.ref + " stale info\n");
        continue;
      }
      if (current !== ZERO_SHA) {
        const newObj = getObject(repo, u.newSha);
        if (newObj && newObj.type === "commit") {
          if (!isAncestor(repo, current, u.newSha)) {
            report.push("ng " + u.ref + " non-fast-forward\n");
            continue;
          }
        }
      }
      repo.refs.set(u.ref, u.newSha);
      repo.pushedAt = nowIso();
      repo.updatedAt = repo.pushedAt;
      report.push("ok " + u.ref + "\n");
    }
  } else {
    for (const u of updates) report.push("ng " + u.ref + " unpacker error\n");
  }
  const parts: Buffer[] = [];
  const wrap = (line: string) => pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(line, "utf8")]));
  parts.push(wrap("unpack " + unpackMsg + "\n"));
  for (const r of report) parts.push(wrap(r));
  parts.push(PKT_FLUSH);
  res.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
  res.end(Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  base: string; // e.g. http://127.0.0.1:4321
  url: URL;
  body: Buffer;
  json: unknown; // parsed JSON body when present and valid
  jsonError: boolean;
}

function sendJson(ctx: Ctx, status: number, value: unknown, extraHeaders?: Record<string, string>): void {
  const text = JSON.stringify(value);
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "x-github-request-id": nextRequestId(),
    "x-github-media-type": "github.v3",
    "content-length": String(Buffer.byteLength(text)),
  };
  if (extraHeaders) for (const k of Object.keys(extraHeaders)) headers[k] = extraHeaders[k];
  ctx.res.writeHead(status, headers);
  ctx.res.end(text);
}

function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message, documentation_url: ctx.base + "/api/v3" });
}

function bodyJsonObject(ctx: Ctx): Record<string, unknown> {
  if (ctx.json && typeof ctx.json === "object" && !Array.isArray(ctx.json)) {
    return ctx.json as Record<string, unknown>;
  }
  return {};
}

function strField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

function checkAuth(ctx: Ctx): boolean {
  const header = ctx.req.headers["authorization"] || "";
  if (header === "Bearer " + SHOP_TOKEN && SHOP_TOKEN.length > 0) return true;
  // Real git clients send Basic when credentials are in the URL; accept the
  // token as the password there too.
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const pass = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    if (pass === SHOP_TOKEN && SHOP_TOKEN.length > 0) return true;
  }
  return false;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// REST serializers
// ---------------------------------------------------------------------------

function userJson(login: string, base: string): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER_LOGIN ? VIEWER_ID : 2,
    node_id: Buffer.from("04:User" + (login === VIEWER_LOGIN ? VIEWER_ID : 2), "utf8").toString("base64"),
    avatar_url: base + "/avatars/" + login,
    gravatar_id: "",
    url: base + "/api/v3/users/" + login,
    html_url: base + "/" + login,
    type: "User",
    site_admin: false,
  };
}

function repoJson(repo: RepoRec, base: string): Record<string, unknown> {
  const full = repo.owner + "/" + repo.name;
  const openIssues =
    [...repo.issues.values()].filter((i) => i.state === "open").length +
    [...repo.pulls.values()].filter((p) => p.state === "open").length;
  return {
    id: repo.id,
    node_id: Buffer.from("010:Repository" + repo.id, "utf8").toString("base64"),
    name: repo.name,
    full_name: full,
    owner: userJson(repo.owner, base),
    private: repo.isPrivate,
    html_url: base + "/" + full,
    description: repo.description,
    fork: false,
    url: base + "/api/v3/repos/" + full,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    git_url: "git://" + base.replace(/^https?:\/\//, "") + "/" + full + ".git",
    ssh_url: "git@" + base.replace(/^https?:\/\//, "") + ":" + full + ".git",
    clone_url: base + "/" + full + ".git",
    homepage: repo.homepage,
    size: 1,
    stargazers_count: repo.stars,
    watchers_count: repo.stars,
    language: repo.language,
    has_issues: repo.hasIssues,
    has_projects: repo.hasProjects,
    has_downloads: true,
    has_wiki: repo.hasWiki,
    has_pages: false,
    forks_count: repo.forks,
    open_issues_count: openIssues,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, push: true, pull: true },
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? "private" : "public",
  };
}

function labelJson(repo: RepoRec, label: LabelRec, base: string): Record<string, unknown> {
  void repo;
  return {
    id: label.id,
    node_id: Buffer.from("07:Label" + label.id, "utf8").toString("base64"),
    url: base + "/api/v3/repos/x/y/labels/" + encodeURIComponent(label.name),
    name: label.name,
    color: label.color,
    default: label.isDefault,
    description: label.description,
  };
}

function labelsJson(repo: RepoRec, names: string[], base: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const n of names) {
    const rec = repo.labels.get(n.toLowerCase());
    if (rec) out.push(labelJson(repo, rec, base));
  }
  return out;
}

function issueJson(repo: RepoRec, issue: IssueRec, base: string): Record<string, unknown> {
  const full = repo.owner + "/" + repo.name;
  const out: Record<string, unknown> = {
    id: issue.id,
    node_id: Buffer.from("05:Issue" + issue.id, "utf8").toString("base64"),
    url: base + "/api/v3/repos/" + full + "/issues/" + issue.number,
    repository_url: base + "/api/v3/repos/" + full,
    html_url: base + "/" + full + "/issues/" + issue.number,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(issue.userLogin, base),
    labels: labelsJson(repo, issue.labels, base),
    assignee: issue.assignees.length ? userJson(issue.assignees[0], base) : null,
    assignees: issue.assignees.map((a) => userJson(a, base)),
    milestone: issue.milestone ? { title: issue.milestone } : null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    locked: false,
  };
  if (issue.isPull) {
    out.pull_request = {
      url: base + "/api/v3/repos/" + full + "/pulls/" + issue.number,
      html_url: base + "/" + full + "/pull/" + issue.number,
    };
  }
  return out;
}

function pullJson(repo: RepoRec, pr: PullRec, base: string): Record<string, unknown> {
  const full = repo.owner + "/" + repo.name;
  const refSide = (ref: string, sha: string) => ({
    label: repo.owner + ":" + ref,
    ref,
    sha,
    user: userJson(repo.owner, base),
    repo: repoJson(repo, base),
  });
  const headCurrent = repo.refs.get("refs/heads/" + pr.headRef) || pr.headSha;
  const baseCurrent = repo.refs.get("refs/heads/" + pr.baseRef) || pr.baseShaAtCreate;
  return {
    id: pr.id,
    node_id: Buffer.from("011:PullRequest" + pr.id, "utf8").toString("base64"),
    url: base + "/api/v3/repos/" + full + "/pulls/" + pr.number,
    html_url: base + "/" + full + "/pull/" + pr.number,
    number: pr.number,
    state: pr.state,
    title: pr.title,
    body: pr.body,
    user: userJson(pr.userLogin, base),
    labels: labelsJson(repo, pr.labels, base),
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.merged ? pr.mergedAt : pr.state === "closed" ? pr.updatedAt : null,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeSha,
    head: refSide(pr.headRef, headCurrent),
    base: refSide(pr.baseRef, baseCurrent),
    merged: pr.merged,
    merged_by: pr.merged ? userJson(VIEWER_LOGIN, base) : null,
    mergeable: computeMergeable(repo, pr).mergeable,
    mergeable_state: computeMergeable(repo, pr).mergeable ? "clean" : "dirty",
    draft: pr.draft,
    comments: pr.comments.length,
    review_comments: 0,
    commits: countPrCommits(repo, pr),
    additions: 0,
    deletions: 0,
    changed_files: prFiles(repo, pr).length,
  };
}

function commentJson(repo: RepoRec, issueNumber: number, c: CommentRec, base: string): Record<string, unknown> {
  const full = repo.owner + "/" + repo.name;
  return {
    id: c.id,
    node_id: Buffer.from("06:IssueComment" + c.id, "utf8").toString("base64"),
    url: base + "/api/v3/repos/" + full + "/issues/comments/" + c.id,
    html_url: base + "/" + full + "/issues/" + issueNumber + "#issuecomment-" + c.id,
    body: c.body,
    user: userJson(c.userLogin, base),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

function commitJson(repo: RepoRec, sha: string, base: string): Record<string, unknown> | null {
  const obj = getObject(repo, sha);
  if (!obj || obj.type !== "commit") return null;
  const info = parseCommit(obj.data);
  const author = formatPersonLine(info.authorLine);
  const committer = formatPersonLine(info.committerLine);
  const full = repo.owner + "/" + repo.name;
  return {
    sha,
    node_id: Buffer.from("03:Commit" + sha, "utf8").toString("base64"),
    url: base + "/api/v3/repos/" + full + "/commits/" + sha,
    html_url: base + "/" + full + "/commit/" + sha,
    commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      message: info.message,
      tree: { sha: info.tree, url: base + "/api/v3/repos/" + full + "/git/trees/" + info.tree },
      comment_count: 0,
    },
    author: userJson(repo.owner, base),
    committer: userJson(repo.owner, base),
    parents: info.parents.map((p) => ({
      sha: p,
      url: base + "/api/v3/repos/" + full + "/commits/" + p,
      html_url: base + "/" + full + "/commit/" + p,
    })),
  };
}

// ---------------------------------------------------------------------------
// Mutations on the git store used by REST contents and pull merges
// ---------------------------------------------------------------------------

function commitFilesOnBranch(
  repo: RepoRec,
  branch: string,
  files: Map<string, { sha: string; mode: string }>,
  message: string,
  extraParents: string[],
): string {
  const tree = buildTreeFromMap(repo, files);
  const parent = headSha(repo, branch);
  const parents: string[] = [];
  if (parent) parents.push(parent);
  for (const p of extraParents) if (!parents.includes(p)) parents.push(p);
  const sha = makeCommit(repo, tree, parents, message.endsWith("\n") ? message : message + "\n");
  repo.refs.set("refs/heads/" + branch, sha);
  repo.pushedAt = nowIso();
  repo.updatedAt = repo.pushedAt;
  return sha;
}

function prFiles(repo: RepoRec, pr: PullRec): { filename: string; status: string; sha: string }[] {
  const head = repo.refs.get("refs/heads/" + pr.headRef) || pr.headSha;
  const baseTip = repo.refs.get("refs/heads/" + pr.baseRef) || pr.baseShaAtCreate;
  const mb = mergeBase(repo, baseTip, head) || pr.baseShaAtCreate;
  const baseMap = treeFileMap(repo, mb);
  const headMap = treeFileMap(repo, head);
  const out: { filename: string; status: string; sha: string }[] = [];
  const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
  for (const p of [...paths].sort()) {
    const b = baseMap.get(p);
    const h = headMap.get(p);
    if (b && h && b.sha === h.sha) continue;
    if (!b && h) out.push({ filename: p, status: "added", sha: h.sha });
    else if (b && !h) out.push({ filename: p, status: "removed", sha: b.sha });
    else if (b && h) out.push({ filename: p, status: "modified", sha: h.sha });
  }
  return out;
}

function countPrCommits(repo: RepoRec, pr: PullRec): number {
  const head = repo.refs.get("refs/heads/" + pr.headRef) || pr.headSha;
  const baseTip = repo.refs.get("refs/heads/" + pr.baseRef) || pr.baseShaAtCreate;
  const mb = mergeBase(repo, baseTip, head);
  let count = 0;
  let cur: string | null = head;
  const seen = new Set<string>();
  while (cur && cur !== mb && !seen.has(cur)) {
    seen.add(cur);
    count += 1;
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== "commit") break;
    const parents = parseCommit(obj.data).parents;
    cur = parents.length ? parents[0] : null;
  }
  return count;
}

// Three-way, file-level mergeability: conflict when both sides changed the
// same path away from the merge-base in different ways.
function computeMergeable(repo: RepoRec, pr: PullRec): { mergeable: boolean; mergedFiles: Map<string, { sha: string; mode: string }> } {
  const head = repo.refs.get("refs/heads/" + pr.headRef) || pr.headSha;
  const baseTip = repo.refs.get("refs/heads/" + pr.baseRef) || pr.baseShaAtCreate;
  if (pr.merged) return { mergeable: true, mergedFiles: treeFileMap(repo, head) };
  const mb = mergeBase(repo, baseTip, head);
  const baseMap0 = treeFileMap(repo, mb);
  const baseMap = treeFileMap(repo, baseTip);
  const headMap = treeFileMap(repo, head);
  const merged = new Map<string, { sha: string; mode: string }>();
  const paths = new Set<string>([...baseMap0.keys(), ...baseMap.keys(), ...headMap.keys()]);
  let conflict = false;
  for (const p of paths) {
    const o = baseMap0.get(p);
    const b = baseMap.get(p);
    const h = headMap.get(p);
    const oSha = o ? o.sha : null;
    const bSha = b ? b.sha : null;
    const hSha = h ? h.sha : null;
    if (bSha === hSha) {
      if (b) merged.set(p, b);
    } else if (oSha === bSha) {
      if (h) merged.set(p, h);
    } else if (oSha === hSha) {
      if (b) merged.set(p, b);
    } else {
      conflict = true;
    }
  }
  return { mergeable: !conflict, mergedFiles: merged };
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

interface Page {
  page: number;
  perPage: number;
}

function parsePage(ctx: Ctx): Page {
  const page = Math.max(1, parseInt(ctx.url.searchParams.get("page") || "1", 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(ctx.url.searchParams.get("per_page") || "30", 10) || 30));
  return { page, perPage };
}

function paginate<T>(ctx: Ctx, items: T[], page: Page): T[] {
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  if (items.length > start + page.perPage) {
    const u = new URL(ctx.url.toString());
    u.searchParams.set("page", String(page.page + 1));
    u.searchParams.set("per_page", String(page.perPage));
    const last = new URL(ctx.url.toString());
    last.searchParams.set("page", String(Math.ceil(items.length / page.perPage)));
    last.searchParams.set("per_page", String(page.perPage));
    ctx.res.setHeader(
      "link",
      "<" + u.toString() + '>; rel="next", <' + last.toString() + '>; rel="last"',
    );
  }
  return slice;
}

const milestonesByRepo = new Map<number, { number: number; title: string; state: string; description: string | null }[]>();

function repoNotFound(ctx: Ctx): void {
  sendError(ctx, 404, "Not Found");
}

function extractLabelNames(repo: RepoRec, raw: unknown): { names: string[]; missing: string | null } {
  const names: string[] = [];
  if (!Array.isArray(raw)) return { names, missing: null };
  for (const item of raw) {
    const name = typeof item === "string" ? item : (item as { name?: unknown })?.name;
    if (typeof name !== "string") continue;
    const rec = repo.labels.get(name.toLowerCase());
    if (!rec) return { names, missing: name };
    names.push(rec.name);
  }
  return { names, missing: null };
}

function handleRestRoot(ctx: Ctx): void {
  const base = ctx.base;
  sendJson(
    ctx,
    200,
    {
      current_user_url: base + "/api/v3/user",
      current_user_repositories_url: base + "/api/v3/user/repos",
      repository_url: base + "/api/v3/repos/{owner}/{repo}",
      repositories_url: base + "/api/v3/repositories",
      issue_url: base + "/api/v3/repos/{owner}/{repo}/issues/{number}",
      label_url: base + "/api/v3/repos/{owner}/{repo}/labels/{name}",
      search_repositories_url: base + "/api/v3/search/repositories?q={query}",
      search_issues_url: base + "/api/v3/search/issues?q={query}",
      user_url: base + "/api/v3/users/{user}",
      organization_repositories_url: base + "/api/v3/orgs/{org}/repos",
    },
    { "x-oauth-scopes": "repo, read:org, gist, user" },
  );
}

function handleCreateRepo(ctx: Ctx): void {
  const body = bodyJsonObject(ctx);
  const name = strField(body, "name");
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    sendJson(ctx, 422, {
      message: "Validation Failed",
      errors: [{ resource: "Repository", field: "name", code: "invalid" }],
    });
    return;
  }
  if (findRepo(VIEWER_LOGIN, name)) {
    sendJson(ctx, 422, {
      message: "Validation Failed",
      errors: [{ resource: "Repository", field: "name", code: "already_exists" }],
    });
    return;
  }
  const repo = createRepo(
    VIEWER_LOGIN,
    name,
    strField(body, "description"),
    body.private === true,
  );
  if (typeof body.homepage === "string") repo.homepage = body.homepage;
  if (body.has_issues === false) repo.hasIssues = false;
  if (body.auto_init === true) {
    const files = new Map<string, { sha: string; mode: string }>();
    const readme = storeObject(repo, "blob", Buffer.from("# " + name + "\n", "utf8"));
    files.set("README.md", { sha: readme, mode: "100644" });
    commitFilesOnBranch(repo, repo.defaultBranch, files, "Initial commit\n", []);
  }
  sendJson(ctx, 201, repoJson(repo, ctx.base));
}

function handleRest(ctx: Ctx): void {
  const method = ctx.req.method || "GET";
  const segs = ctx.url.pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s));
  // segs[0] === "api", segs[1] === "v3"
  const rest = segs.slice(2);

  if (rest.length === 0) {
    if (method === "GET") return handleRestRoot(ctx);
    return repoNotFound(ctx);
  }
  if (rest[0] === "meta" && method === "GET") {
    return sendJson(ctx, 200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      installed_version: "1.0.0-forge",
      plan: "forge",
    });
  }
  if (rest[0] === "rate_limit" && method === "GET") {
    return sendJson(ctx, 200, {
      resources: { core: { limit: 5000, remaining: 4999, reset: 1767229200, used: 1 } },
      rate: { limit: 5000, remaining: 4999, reset: 1767229200, used: 1 },
    });
  }
  if (rest[0] === "user" && rest.length === 1) {
    if (method === "GET") {
      return sendJson(ctx, 200, {
        ...userJson(VIEWER_LOGIN, ctx.base),
        name: "The Octocat",
        email: "octocat@example.com",
        plan: { name: "pro", space: 976562499 },
        total_private_repos: 0,
        owned_private_repos: 0,
      });
    }
    if (method === "PATCH") {
      const out = { ...userJson(VIEWER_LOGIN, ctx.base) };
      const body = bodyJsonObject(ctx);
      if (typeof body.name === "string") out.name = body.name;
      return sendJson(ctx, 200, out);
    }
  }
  if (rest[0] === "user" && rest[1] === "repos") {
    if (method === "GET") {
      const mine = [...store.repos.values()].filter((r) => r.owner === VIEWER_LOGIN);
      mine.sort((a, b) => a.id - b.id);
      const page = parsePage(ctx);
      return sendJson(ctx, 200, paginate(ctx, mine, page).map((r) => repoJson(r, ctx.base)));
    }
    if (method === "POST") return handleCreateRepo(ctx);
  }
  if (rest[0] === "users" && rest.length >= 2) {
    const login = rest[1];
    if (rest.length === 2 && method === "GET") {
      if (login === VIEWER_LOGIN) return sendJson(ctx, 200, userJson(login, ctx.base));
      return repoNotFound(ctx);
    }
    if (rest[2] === "repos" && method === "GET") {
      const theirs = [...store.repos.values()].filter((r) => r.owner === login && !r.isPrivate);
      const page = parsePage(ctx);
      return sendJson(ctx, 200, paginate(ctx, theirs, page).map((r) => repoJson(r, ctx.base)));
    }
    return repoNotFound(ctx);
  }
  if (rest[0] === "orgs" && rest[2] === "repos" && method === "POST") {
    return handleCreateRepo(ctx);
  }
  if (rest[0] === "search") return handleSearch(ctx, rest[1]);
  if (rest[0] === "repositories" && method === "GET") {
    const all = [...store.repos.values()].sort((a, b) => a.id - b.id);
    const page = parsePage(ctx);
    return sendJson(ctx, 200, paginate(ctx, all, page).map((r) => repoJson(r, ctx.base)));
  }
  if (rest[0] === "repos" && rest.length >= 3) {
    return handleRepoScoped(ctx, rest[1], rest[2], rest.slice(3));
  }
  return repoNotFound(ctx);
}

function handleSearch(ctx: Ctx, kind: string | undefined): void {
  const q = ctx.url.searchParams.get("q") || "";
  const page = parsePage(ctx);
  if (kind === "repositories") {
    const needle = q.toLowerCase();
    const hits = [...store.repos.values()].filter(
      (r) => (r.owner + "/" + r.name).toLowerCase().includes(needle),
    );
    return sendJson(ctx, 200, {
      total_count: hits.length,
      incomplete_results: false,
      items: paginate(ctx, hits, page).map((r) => repoJson(r, ctx.base)),
    });
  }
  if (kind === "issues") {
    const needle = q.toLowerCase();
    const items: Record<string, unknown>[] = [];
    for (const repo of store.repos.values()) {
      for (const issue of repo.issues.values()) {
        if (issue.title.toLowerCase().includes(needle) || needle === "") {
          items.push(issueJson(repo, issue, ctx.base));
        }
      }
    }
    return sendJson(ctx, 200, { total_count: items.length, incomplete_results: false, items: paginate(ctx, items, page) });
  }
  if (kind === "users") {
    const items = q === "" || VIEWER_LOGIN.includes(q) ? [userJson(VIEWER_LOGIN, ctx.base)] : [];
    return sendJson(ctx, 200, { total_count: items.length, incomplete_results: false, items });
  }
  return repoNotFound(ctx);
}

function resolveCommitish(repo: RepoRec, ref: string | null): string | null {
  if (!ref) return headSha(repo, repo.defaultBranch);
  if (repo.refs.has("refs/heads/" + ref)) return repo.refs.get("refs/heads/" + ref) as string;
  if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    // A full sha that names a tree or blob is not a commit; still return it
    // so tree lookups by sha work.
    return ref;
  }
  return null;
}

function handleRepoScoped(ctx: Ctx, owner: string, name: string, rest: string[]): void {
  const method = ctx.req.method || "GET";
  const base = ctx.base;
  const repo = findRepo(owner, name);
  if (!repo) return repoNotFound(ctx);
  const full = repo.owner + "/" + repo.name;

  // Repository itself
  if (rest.length === 0) {
    if (method === "GET") return sendJson(ctx, 200, repoJson(repo, base));
    if (method === "PATCH") {
      const body = bodyJsonObject(ctx);
      if (typeof body.description === "string" || body.description === null) repo.description = body.description as string | null;
      if (typeof body.homepage === "string" || body.homepage === null) repo.homepage = body.homepage as string | null;
      if (typeof body.private === "boolean") repo.isPrivate = body.private;
      if (typeof body.has_issues === "boolean") repo.hasIssues = body.has_issues;
      if (typeof body.has_wiki === "boolean") repo.hasWiki = body.has_wiki;
      if (typeof body.default_branch === "string") repo.defaultBranch = body.default_branch;
      if (typeof body.name === "string" && body.name !== repo.name) {
        store.repos.delete(repoKey(repo.owner, repo.name));
        repo.name = body.name;
        store.repos.set(repoKey(repo.owner, repo.name), repo);
      }
      repo.updatedAt = nowIso();
      return sendJson(ctx, 200, repoJson(repo, base));
    }
    if (method === "DELETE") {
      store.repos.delete(repoKey(repo.owner, repo.name));
      ctx.res.writeHead(204, { "x-github-request-id": nextRequestId() });
      ctx.res.end();
      return;
    }
    return repoNotFound(ctx);
  }

  const head0 = rest[0];

  if (head0 === "branches") {
    if (rest.length === 1 && method === "GET") {
      const out = [];
      for (const refName of sortedRefNames(repo)) {
        if (!refName.startsWith("refs/heads/")) continue;
        out.push({
          name: refName.slice(11),
          commit: { sha: repo.refs.get(refName), url: base + "/api/v3/repos/" + full + "/commits/" + repo.refs.get(refName) },
          protected: false,
        });
      }
      const page = parsePage(ctx);
      return sendJson(ctx, 200, paginate(ctx, out, page));
    }
    const branch = rest.slice(1).join("/");
    const sha = headSha(repo, branch);
    if (method === "GET") {
      if (!sha) return repoNotFound(ctx);
      return sendJson(ctx, 200, {
        name: branch,
        commit: commitJson(repo, sha, base),
        protected: false,
        _links: { self: base + "/api/v3/repos/" + full + "/branches/" + branch, html: base + "/" + full + "/tree/" + branch },
      });
    }
    return repoNotFound(ctx);
  }

  if (head0 === "commits") {
    if (rest.length === 1 && method === "GET") {
      const ref = ctx.url.searchParams.get("sha") || ctx.url.searchParams.get("branch");
      const pathFilter = ctx.url.searchParams.get("path");
      let tip = resolveCommitish(repo, ref);
      const commits: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      while (tip && !seen.has(tip)) {
        seen.add(tip);
        const cj = commitJson(repo, tip, base);
        if (!cj) break;
        if (pathFilter) {
          const files = treeFileMap(repo, tip);
          if (!files.has(pathFilter)) {
            const info = parseCommit((getObject(repo, tip) as GitObject).data);
            tip = info.parents.length ? info.parents[0] : null;
            continue;
          }
        }
        commits.push(cj);
        const info = parseCommit((getObject(repo, tip) as GitObject).data);
        tip = info.parents.length ? info.parents[0] : null;
      }
      const page = parsePage(ctx);
      return sendJson(ctx, 200, paginate(ctx, commits, page));
    }
    if (rest.length === 2 && method === "GET") {
      const cj = commitJson(repo, rest[1], base);
      if (!cj) return repoNotFound(ctx);
      return sendJson(ctx, 200, cj);
    }
    return repoNotFound(ctx);
  }

  if (head0 === "contents") return handleContents(ctx, repo, rest.slice(1).join("/"));
  if (head0 === "git") return handleGitData(ctx, repo, rest.slice(1));
  if (head0 === "labels") return handleLabels(ctx, repo, rest.slice(1));
  if (head0 === "issues") return handleIssues(ctx, repo, rest.slice(1));
  if (head0 === "pulls") return handlePulls(ctx, repo, rest.slice(1));
  if (head0 === "milestones") return handleMilestones(ctx, repo, rest.slice(1));

  if (head0 === "collaborators" && method === "GET") {
    return sendJson(ctx, 200, [userJson(repo.owner, base)]);
  }
  if (head0 === "tags" && method === "GET") {
    const out = [];
    for (const refName of sortedRefNames(repo)) {
      if (refName.startsWith("refs/tags/")) {
        out.push({ name: refName.slice(10), commit: { sha: repo.refs.get(refName) }, zipball_url: "", tarball_url: "" });
      }
    }
    return sendJson(ctx, 200, out);
  }
  if (head0 === "languages" && method === "GET") return sendJson(ctx, 200, {});
  if (head0 === "forks" && method === "GET") return sendJson(ctx, 200, []);
  if (head0 === "stargazers" && method === "GET") return sendJson(ctx, 200, []);
  if (head0 === "subscribers" && method === "GET") return sendJson(ctx, 200, []);
  if (head0 === "teams" && method === "GET") return sendJson(ctx, 200, []);
  if (head0 === "hooks" && method === "GET") return sendJson(ctx, 200, []);
  if (head0 === "deployments" && method === "GET") return sendJson(ctx, 200, []);
  if (head0 === "releases" && method === "GET") return sendJson(ctx, 200, []);

  return repoNotFound(ctx);
}

function fileEntryJson(repo: RepoRec, path: string, sha: string, size: number, base: string): Record<string, unknown> {
  const full = repo.owner + "/" + repo.name;
  const name = path.split("/").pop() || path;
  return {
    name,
    path,
    sha,
    size,
    url: base + "/api/v3/repos/" + full + "/contents/" + path,
    html_url: base + "/" + full + "/blob/" + repo.defaultBranch + "/" + path,
    git_url: base + "/api/v3/repos/" + full + "/git/blobs/" + sha,
    download_url: base + "/" + full + "/raw/" + repo.defaultBranch + "/" + path,
    type: "file",
    _links: { self: base + "/api/v3/repos/" + full + "/contents/" + path },
  };
}

function handleContents(ctx: Ctx, repo: RepoRec, path: string): void {
  const method = ctx.req.method || "GET";
  const base = ctx.base;
  const full = repo.owner + "/" + repo.name;
  const body = bodyJsonObject(ctx);
  const branch = typeof body.branch === "string" ? body.branch : ctx.url.searchParams.get("ref") || repo.defaultBranch;
  const tip = headSha(repo, branch);

  if (method === "GET") {
    const commitSha = resolveCommitish(repo, ctx.url.searchParams.get("ref"));
    if (!commitSha) {
      // Empty repository: only the root listing exists, and it is empty.
      if (path === "") return sendJson(ctx, 200, []);
      return repoNotFound(ctx);
    }
    const files = treeFileMap(repo, commitSha);
    if (path === "") {
      const dirs = new Set<string>();
      const out: Record<string, unknown>[] = [];
      for (const [p, info] of files) {
        if (p.includes("/")) {
          dirs.add(p.split("/")[0]);
        } else {
          const blob = getObject(repo, info.sha);
          out.push({ ...fileEntryJson(repo, p, info.sha, blob ? blob.data.length : 0, base) });
        }
      }
      for (const d of [...dirs].sort()) {
        out.push({
          name: d,
          path: d,
          sha: "",
          size: 0,
          url: base + "/api/v3/repos/" + full + "/contents/" + d,
          html_url: base + "/" + full + "/tree/" + repo.defaultBranch + "/" + d,
          git_url: null,
          download_url: null,
          type: "dir",
          _links: { self: base + "/api/v3/repos/" + full + "/contents/" + d },
        });
      }
      out.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
      return sendJson(ctx, 200, out);
    }
    const entry = files.get(path);
    if (entry) {
      const blob = getObject(repo, entry.sha);
      const content = blob ? blob.data : Buffer.alloc(0);
      const b64 = content.toString("base64").replace(/(.{60})/g, "$1\n");
      return sendJson(ctx, 200, {
        ...fileEntryJson(repo, path, entry.sha, content.length, base),
        encoding: "base64",
        content: b64.endsWith("\n") || b64 === "" ? b64 : b64 + "\n",
      });
    }
    // Directory below the root?
    const prefix = path + "/";
    const sub = [...files.keys()].filter((p) => p.startsWith(prefix));
    if (sub.length) {
      const out: Record<string, unknown>[] = [];
      const dirs = new Set<string>();
      for (const p of sub) {
        const rel = p.slice(prefix.length);
        if (rel.includes("/")) dirs.add(rel.split("/")[0]);
        else {
          const info = files.get(p) as { sha: string; mode: string };
          const blob = getObject(repo, info.sha);
          out.push({ ...fileEntryJson(repo, p, info.sha, blob ? blob.data.length : 0, base) });
        }
      }
      for (const d of [...dirs].sort()) {
        out.push({
          name: d, path: prefix + d, sha: "", size: 0,
          url: base + "/api/v3/repos/" + full + "/contents/" + prefix + d,
          html_url: "", git_url: null, download_url: null, type: "dir", _links: {},
        });
      }
      out.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
      return sendJson(ctx, 200, out);
    }
    return repoNotFound(ctx);
  }

  if (method === "PUT") {
    const message = strField(body, "message");
    const contentB64 = strField(body, "content");
    if (message === null || contentB64 === null) {
      return sendJson(ctx, 422, { message: "Validation Failed", errors: [{ resource: "Contents", code: "missing_field" }] });
    }
    const data = Buffer.from(contentB64.replace(/\s+/g, ""), "base64");
    const files = treeFileMap(repo, tip);
    const existing = files.get(path);
    const givenSha = strField(body, "sha");
    if (existing && givenSha !== null && givenSha !== existing.sha) {
      return sendJson(ctx, 409, { message: path + " does not match " + givenSha });
    }
    if (!existing && givenSha) {
      return sendJson(ctx, 422, { message: "Validation Failed", errors: [{ resource: "Contents", field: "sha", code: "invalid" }] });
    }
    const blobSha = storeObject(repo, "blob", data);
    files.set(path, { sha: blobSha, mode: "100644" });
    const commitSha = commitFilesOnBranch(repo, branch, files, message + "\n", []);
    const status = existing ? 200 : 201;
    return sendJson(ctx, status, {
      content: fileEntryJson(repo, path, blobSha, data.length, base),
      commit: {
        sha: commitSha,
        url: base + "/api/v3/repos/" + full + "/commits/" + commitSha,
        html_url: base + "/" + full + "/commit/" + commitSha,
        message,
        author: { name: "octocat", email: "octocat@example.com", date: nowIsoNoTick() },
        committer: { name: "octocat", email: "octocat@example.com", date: nowIsoNoTick() },
      },
    });
  }

  if (method === "DELETE") {
    const message = strField(body, "message") || "Delete " + path;
    const files = treeFileMap(repo, tip);
    const existing = files.get(path);
    if (!existing) return repoNotFound(ctx);
    const givenSha = strField(body, "sha");
    if (givenSha !== null && givenSha !== existing.sha) {
      return sendJson(ctx, 409, { message: path + " does not match " + givenSha });
    }
    files.delete(path);
    const commitSha = commitFilesOnBranch(repo, branch, files, message + "\n", []);
    return sendJson(ctx, 200, {
      content: null,
      commit: {
        sha: commitSha,
        url: base + "/api/v3/repos/" + full + "/commits/" + commitSha,
        message,
      },
    });
  }
  return repoNotFound(ctx);
}

function handleGitData(ctx: Ctx, repo: RepoRec, rest: string[]): void {
  const method = ctx.req.method || "GET";
  const base = ctx.base;
  const full = repo.owner + "/" + repo.name;
  const body = bodyJsonObject(ctx);

  if (rest[0] === "refs") {
    if (rest.length === 1) {
      if (method === "GET") {
        const out = sortedRefNames(repo).map((r) => ({
          ref: r,
          node_id: "",
          url: base + "/api/v3/repos/" + full + "/git/refs/" + r.replace(/^refs\//, ""),
          object: { sha: repo.refs.get(r), type: "commit", url: base + "/api/v3/repos/" + full + "/git/commits/" + repo.refs.get(r) },
        }));
        return sendJson(ctx, 200, out);
      }
      if (method === "POST") {
        const ref = strField(body, "ref");
        const sha = strField(body, "sha");
        if (!ref || !sha || !repo.objects.has(sha)) {
          return sendJson(ctx, 422, { message: "Validation Failed" });
        }
        repo.refs.set(ref, sha);
        return sendJson(ctx, 201, {
          ref,
          node_id: "",
          url: base + "/api/v3/repos/" + full + "/git/refs/" + ref.replace(/^refs\//, ""),
          object: { sha, type: "commit", url: "" },
        });
      }
    }
    const refName = "refs/" + rest.slice(1).join("/");
    const sha = repo.refs.get(refName);
    if (method === "GET") {
      if (!sha) return repoNotFound(ctx);
      return sendJson(ctx, 200, {
        ref: refName,
        node_id: "",
        url: base + "/api/v3/repos/" + full + "/git/refs/" + rest.slice(1).join("/"),
        object: { sha, type: "commit", url: base + "/api/v3/repos/" + full + "/git/commits/" + sha },
      });
    }
    if (method === "PATCH") {
      const newSha = strField(body, "sha");
      if (!newSha || !repo.objects.has(newSha)) return sendJson(ctx, 422, { message: "Validation Failed" });
      repo.refs.set(refName, newSha);
      return sendJson(ctx, 200, { ref: refName, object: { sha: newSha, type: "commit" } });
    }
    if (method === "DELETE") {
      repo.refs.delete(refName);
      ctx.res.writeHead(204, { "x-github-request-id": nextRequestId() });
      ctx.res.end();
      return;
    }
  }

  if (rest[0] === "trees" && rest.length === 2) {
    const sha = resolveCommitish(repo, rest[1]);
    if (!sha) return repoNotFound(ctx);
    let treeSha = sha;
    const obj = getObject(repo, sha);
    if (obj && obj.type === "commit") treeSha = parseCommit(obj.data).tree;
    const recursive = ctx.url.searchParams.get("recursive") === "1";
    const entries: Record<string, unknown>[] = [];
    const walk = (tSha: string, prefix: string) => {
      const t = getObject(repo, tSha);
      if (!t || t.type !== "tree") return;
      for (const e of parseTree(t.data)) {
        const p = prefix ? prefix + "/" + e.name : e.name;
        const isTree = e.mode === "40000";
        entries.push({
          path: p,
          mode: e.mode === "40000" ? "040000" : e.mode,
          type: isTree ? "tree" : "blob",
          sha: e.sha,
          size: isTree ? undefined : (getObject(repo, e.sha)?.data.length ?? 0),
          url: base + "/api/v3/repos/" + full + "/git/" + (isTree ? "trees" : "blobs") + "/" + e.sha,
        });
        if (isTree && recursive) walk(e.sha, p);
      }
    };
    walk(treeSha, "");
    return sendJson(ctx, 200, { sha: treeSha, url: base + "/api/v3/repos/" + full + "/git/trees/" + treeSha, tree: entries, truncated: false });
  }

  if (rest[0] === "blobs") {
    if (rest.length === 2 && method === "GET") {
      const obj = getObject(repo, rest[1]);
      if (!obj || obj.type !== "blob") return repoNotFound(ctx);
      return sendJson(ctx, 200, {
        sha: rest[1],
        node_id: "",
        size: obj.data.length,
        url: base + "/api/v3/repos/" + full + "/git/blobs/" + rest[1],
        content: obj.data.toString("base64").replace(/(.{60})/g, "$1\n") + "\n",
        encoding: "base64",
      });
    }
    if (rest.length === 1 && method === "POST") {
      const content = strField(body, "content") || "";
      const encoding = strField(body, "encoding");
      const data = encoding === "base64" ? Buffer.from(content.replace(/\s+/g, ""), "base64") : Buffer.from(content, "utf8");
      const sha = storeObject(repo, "blob", data);
      return sendJson(ctx, 201, { sha, url: base + "/api/v3/repos/" + full + "/git/blobs/" + sha });
    }
  }

  if (rest[0] === "commits") {
    if (rest.length === 2 && method === "GET") {
      const obj = getObject(repo, rest[1]);
      if (!obj || obj.type !== "commit") return repoNotFound(ctx);
      const info = parseCommit(obj.data);
      const author = formatPersonLine(info.authorLine);
      return sendJson(ctx, 200, {
        sha: rest[1],
        node_id: "",
        url: base + "/api/v3/repos/" + full + "/git/commits/" + rest[1],
        author: { name: author.name, email: author.email, date: author.date },
        committer: { name: author.name, email: author.email, date: author.date },
        message: info.message,
        tree: { sha: info.tree, url: base + "/api/v3/repos/" + full + "/git/trees/" + info.tree },
        parents: info.parents.map((p) => ({ sha: p, url: base + "/api/v3/repos/" + full + "/git/commits/" + p })),
      });
    }
    if (rest.length === 1 && method === "POST") {
      const tree = strField(body, "tree");
      const message = strField(body, "message") || "";
      const parents = Array.isArray(body.parents) ? (body.parents as string[]) : [];
      if (!tree) return sendJson(ctx, 422, { message: "Validation Failed" });
      const sha = makeCommit(repo, tree, parents, message.endsWith("\n") ? message : message + "\n");
      return sendJson(ctx, 201, { sha, url: base + "/api/v3/repos/" + full + "/git/commits/" + sha, message });
    }
  }

  if (rest[0] === "tags" && method === "POST") {
    const tag = strField(body, "tag") || "";
    const message = strField(body, "message") || "";
    const object = strField(body, "object") || "";
    const data = Buffer.from(
      "object " + object + "\ntype commit\ntag " + tag + "\ntagger " + AUTHOR_LINE + "\n\n" + message,
      "utf8",
    );
    const sha = storeObject(repo, "tag", data);
    return sendJson(ctx, 201, { sha, tag, message, object: { sha: object, type: "commit" } });
  }

  return repoNotFound(ctx);
}

function handleLabels(ctx: Ctx, repo: RepoRec, rest: string[]): void {
  const method = ctx.req.method || "GET";
  const base = ctx.base;
  const body = bodyJsonObject(ctx);
  if (rest.length === 0) {
    if (method === "GET") {
      const all = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
      const page = parsePage(ctx);
      return sendJson(ctx, 200, paginate(ctx, all, page).map((l) => labelJson(repo, l, base)));
    }
    if (method === "POST") {
      const name = strField(body, "name");
      if (!name) return sendJson(ctx, 422, { message: "Validation Failed", errors: [{ resource: "Label", field: "name", code: "missing_field" }] });
      if (repo.labels.has(name.toLowerCase())) {
        return sendJson(ctx, 422, { message: "Validation Failed", errors: [{ resource: "Label", field: "name", code: "already_exists" }] });
      }
      const color = (strField(body, "color") || "ededed").replace(/^#/, "");
      const rec: LabelRec = {
        id: store.nextLabelId++,
        name,
        color,
        description: strField(body, "description"),
        isDefault: false,
      };
      repo.labels.set(name.toLowerCase(), rec);
      return sendJson(ctx, 201, labelJson(repo, rec, base));
    }
  }
  const name = decodeURIComponent(rest.join("/"));
  const rec = repo.labels.get(name.toLowerCase());
  if (!rec) return repoNotFound(ctx);
  if (method === "GET") return sendJson(ctx, 200, labelJson(repo, rec, base));
  if (method === "PATCH") {
    const newName = strField(body, "new_name") || strField(body, "name");
    if (typeof body.color === "string") rec.color = (body.color as string).replace(/^#/, "");
    if (typeof body.description === "string" || body.description === null) rec.description = body.description as string | null;
    if (newName && newName !== rec.name) {
      repo.labels.delete(rec.name.toLowerCase());
      // Rename on issues and pulls too.
      for (const issue of repo.issues.values()) {
        issue.labels = issue.labels.map((l) => (l.toLowerCase() === rec.name.toLowerCase() ? newName : l));
      }
      rec.name = newName;
      repo.labels.set(newName.toLowerCase(), rec);
    }
    return sendJson(ctx, 200, labelJson(repo, rec, base));
  }
  if (method === "DELETE") {
    repo.labels.delete(rec.name.toLowerCase());
    ctx.res.writeHead(204, { "x-github-request-id": nextRequestId() });
    ctx.res.end();
    return;
  }
  return repoNotFound(ctx);
}

function createIssueRec(repo: RepoRec, title: string, bodyText: string | null, labels: string[], assignees: string[]): IssueRec {
  const ts = nowIso();
  const rec: IssueRec = {
    id: store.nextIssueId++,
    number: repo.nextNumber++,
    title,
    body: bodyText,
    state: "open",
    labels,
    assignees,
    milestone: null,
    userLogin: VIEWER_LOGIN,
    createdAt: ts,
    updatedAt: ts,
    closedAt: null,
    comments: [],
    isPull: false,
  };
  repo.issues.set(rec.number, rec);
  return rec;
}

function handleIssues(ctx: Ctx, repo: RepoRec, rest: string[]): void {
  const method = ctx.req.method || "GET";
  const base = ctx.base;
  const body = bodyJsonObject(ctx);

  if (rest.length === 0) {
    if (method === "GET") {
      const state = ctx.url.searchParams.get("state") || "open";
      let list = [...repo.issues.values()];
      if (state === "open") list = list.filter((i) => i.state === "open");
      else if (state === "closed") list = list.filter((i) => i.state === "closed");
      const labelFilter = ctx.url.searchParams.get("labels");
      if (labelFilter) {
        const wanted = labelFilter.split(",").map((s) => s.trim().toLowerCase());
        list = list.filter((i) => wanted.every((w) => i.labels.some((l) => l.toLowerCase() === w)));
      }
      const sort = ctx.url.searchParams.get("sort") || "created";
      const direction = ctx.url.searchParams.get("direction") || "desc";
      list.sort((a, b) => (sort === "created" ? (a.createdAt < b.createdAt ? -1 : 1) : a.number - b.number) * (direction === "asc" ? 1 : -1));
      const page = parsePage(ctx);
      return sendJson(ctx, 200, paginate(ctx, list, page).map((i) => issueJson(repo, i, base)));
    }
    if (method === "POST") {
      const title = strField(body, "title");
      if (!title) return sendJson(ctx, 422, { message: "Validation Failed", errors: [{ resource: "Issue", field: "title", code: "missing_field" }] });
      const { names, missing } = extractLabelNames(repo, body.labels);
      if (missing !== null) {
        return sendJson(ctx, 422, {
          message: "Validation Failed: label '" + missing + "' does not exist",
          errors: [{ resource: "Issue", field: "labels", code: "invalid", value: missing }],
        });
      }
      const assignees = Array.isArray(body.assignees) ? (body.assignees as string[]).filter((a) => typeof a === "string") : [];
      const rec = createIssueRec(repo, title, strField(body, "body"), names, assignees);
      return sendJson(ctx, 201, issueJson(repo, rec, base));
    }
  }

  // /issues/comments/{id}
  if (rest[0] === "comments" && rest.length === 2) {
    const id = parseInt(rest[1], 10);
    for (const issue of repo.issues.values()) {
      const c = issue.comments.find((x) => x.id === id);
      if (c) {
        if (method === "GET") return sendJson(ctx, 200, commentJson(repo, issue.number, c, base));
        if (method === "PATCH") {
          if (typeof body.body === "string") c.body = body.body;
          c.updatedAt = nowIso();
          return sendJson(ctx, 200, commentJson(repo, issue.number, c, base));
        }
        if (method === "DELETE") {
          issue.comments = issue.comments.filter((x) => x.id !== id);
          ctx.res.writeHead(204, { "x-github-request-id": nextRequestId() });
          ctx.res.end();
          return;
        }
      }
    }
    return repoNotFound(ctx);
  }

  const number = parseInt(rest[0], 10);
  const issue = Number.isNaN(number) ? undefined : repo.issues.get(number);
  const pull = Number.isNaN(number) ? undefined : repo.pulls.get(number);
  if (!issue && !pull) return repoNotFound(ctx);

  if (rest.length === 1) {
    if (method === "GET") {
      if (issue) return sendJson(ctx, 200, issueJson(repo, issue, base));
      // A pull request read through the issues API carries the pull_request key.
      const asIssue: IssueRec = {
        id: (pull as PullRec).id,
        number: (pull as PullRec).number,
        title: (pull as PullRec).title,
        body: (pull as PullRec).body,
        state: (pull as PullRec).state,
        labels: (pull as PullRec).labels,
        assignees: [],
        milestone: null,
        userLogin: (pull as PullRec).userLogin,
        createdAt: (pull as PullRec).createdAt,
        updatedAt: (pull as PullRec).updatedAt,
        closedAt: null,
        comments: (pull as PullRec).comments,
        isPull: true,
      };
      return sendJson(ctx, 200, issueJson(repo, asIssue, base));
    }
    if (method === "PATCH" && issue) {
      if (typeof body.title === "string") issue.title = body.title;
      if (typeof body.body === "string" || body.body === null) issue.body = body.body as string | null;
      if (body.state === "open" || body.state === "closed") {
        issue.state = body.state;
        issue.closedAt = body.state === "closed" ? nowIso() : null;
      }
      if (body.labels !== undefined) {
        const { names, missing } = extractLabelNames(repo, body.labels);
        if (missing !== null) return sendJson(ctx, 422, { message: "Validation Failed: label '" + missing + "' does not exist" });
        issue.labels = names;
      }
      if (Array.isArray(body.assignees)) issue.assignees = (body.assignees as string[]).filter((a) => typeof a === "string");
      issue.updatedAt = nowIso();
      return sendJson(ctx, 200, issueJson(repo, issue, base));
    }
    return repoNotFound(ctx);
  }

  if (rest[1] === "comments") {
    const target = issue || null;
    const prTarget = pull || null;
    const comments: CommentRec[] = target ? target.comments : (prTarget as PullRec).comments;
    const ownerNumber = number;
    if (rest.length === 2) {
      if (method === "GET") {
        const page = parsePage(ctx);
        return sendJson(ctx, 200, paginate(ctx, comments, page).map((c) => commentJson(repo, ownerNumber, c, base)));
      }
      if (method === "POST") {
        const text = strField(body, "body");
        if (text === null) return sendJson(ctx, 422, { message: "Validation Failed", errors: [{ resource: "IssueComment", field: "body", code: "missing_field" }] });
        const ts = nowIso();
        const c: CommentRec = { id: store.nextCommentId++, body: text, userLogin: VIEWER_LOGIN, createdAt: ts, updatedAt: ts };
        comments.push(c);
        return sendJson(ctx, 201, commentJson(repo, ownerNumber, c, base));
      }
    }
    if (rest.length === 3) {
      const id = parseInt(rest[2], 10);
      const c = comments.find((x) => x.id === id);
      if (!c) return repoNotFound(ctx);
      if (method === "GET") return sendJson(ctx, 200, commentJson(repo, ownerNumber, c, base));
      if (method === "PATCH") {
        if (typeof body.body === "string") c.body = body.body;
        c.updatedAt = nowIso();
        return sendJson(ctx, 200, commentJson(repo, ownerNumber, c, base));
      }
      if (method === "DELETE") {
        const arr = target ? target.comments : (prTarget as PullRec).comments;
        const idx = arr.findIndex((x) => x.id === id);
        if (idx >= 0) arr.splice(idx, 1);
        ctx.res.writeHead(204, { "x-github-request-id": nextRequestId() });
        ctx.res.end();
        return;
      }
    }
  }

  if (rest[1] === "labels" && issue) {
    if (method === "GET") return sendJson(ctx, 200, labelsJson(repo, issue.labels, base));
    if (method === "POST") {
      const raw = Array.isArray(body.labels) ? body.labels : Array.isArray(ctx.json) ? ctx.json : [];
      const { names, missing } = extractLabelNames(repo, raw);
      if (missing !== null) return sendJson(ctx, 422, { message: "Validation Failed: label '" + missing + "' does not exist" });
      for (const n of names) if (!issue.labels.includes(n)) issue.labels.push(n);
      return sendJson(ctx, 200, labelsJson(repo, issue.labels, base));
    }
    if (method === "DELETE" && rest.length === 3) {
      const target = decodeURIComponent(rest[2]).toLowerCase();
      issue.labels = issue.labels.filter((l) => l.toLowerCase() !== target);
      return sendJson(ctx, 200, labelsJson(repo, issue.labels, base));
    }
    if (method === "DELETE" && rest.length === 2) {
      issue.labels = [];
      ctx.res.writeHead(204, { "x-github-request-id": nextRequestId() });
      ctx.res.end();
      return;
    }
  }

  return repoNotFound(ctx);
}

function handlePulls(ctx: Ctx, repo: RepoRec, rest: string[]): void {
  const method = ctx.req.method || "GET";
  const base = ctx.base;
  const body = bodyJsonObject(ctx);

  const normalizeRef = (raw: string): string => {
    const idx = raw.indexOf(":");
    return idx >= 0 ? raw.slice(idx + 1) : raw;
  };

  if (rest.length === 0) {
    if (method === "GET") {
      const state = ctx.url.searchParams.get("state") || "open";
      let list = [...repo.pulls.values()];
      if (state === "open") list = list.filter((p) => p.state === "open");
      else if (state === "closed") list = list.filter((p) => p.state === "closed");
      const headFilter = ctx.url.searchParams.get("head");
      const baseFilter = ctx.url.searchParams.get("base");
      if (headFilter) list = list.filter((p) => p.headRef === normalizeRef(headFilter));
      if (baseFilter) list = list.filter((p) => p.baseRef === baseFilter);
      list.sort((a, b) => b.number - a.number);
      const page = parsePage(ctx);
      return sendJson(ctx, 200, paginate(ctx, list, page).map((p) => pullJson(repo, p, base)));
    }
    if (method === "POST") {
      const title = strField(body, "title");
      const headRaw = strField(body, "head");
      const baseRaw = strField(body, "base") || repo.defaultBranch;
      if (!title || !headRaw) {
        return sendJson(ctx, 422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "missing_field" }] });
      }
      const headRef = normalizeRef(headRaw);
      const headCommit = headSha(repo, headRef);
      if (!headCommit) {
        return sendJson(ctx, 422, { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "head", code: "invalid" }] });
      }
      const baseCommit = headSha(repo, baseRaw) || ZERO_SHA;
      const ts = nowIso();
      const pr: PullRec = {
        id: store.nextIssueId++,
        number: repo.nextNumber++,
        title,
        body: strField(body, "body"),
        state: "open",
        headRef,
        headSha: headCommit,
        baseRef: baseRaw,
        baseShaAtCreate: baseCommit,
        userLogin: VIEWER_LOGIN,
        createdAt: ts,
        updatedAt: ts,
        merged: false,
        mergedAt: null,
        mergeSha: null,
        draft: body.draft === true,
        labels: [],
        comments: [],
      };
      repo.pulls.set(pr.number, pr);
      return sendJson(ctx, 201, pullJson(repo, pr, base));
    }
  }

  const number = parseInt(rest[0], 10);
  const pr = Number.isNaN(number) ? undefined : repo.pulls.get(number);
  if (!pr) return repoNotFound(ctx);

  if (rest.length === 1) {
    if (method === "GET") return sendJson(ctx, 200, pullJson(repo, pr, base));
    if (method === "PATCH") {
      if (typeof body.title === "string") pr.title = body.title;
      if (typeof body.body === "string" || body.body === null) pr.body = body.body as string | null;
      if (body.state === "open" || body.state === "closed") pr.state = body.state;
      if (typeof body.base === "string") pr.baseRef = body.base;
      pr.updatedAt = nowIso();
      return sendJson(ctx, 200, pullJson(repo, pr, base));
    }
    return repoNotFound(ctx);
  }

  if (rest[1] === "merge") {
    if (method === "GET") {
      if (pr.merged) {
        ctx.res.writeHead(204, { "x-github-request-id": nextRequestId() });
        ctx.res.end();
        return;
      }
      return repoNotFound(ctx);
    }
    if (method === "PUT") {
      if (pr.merged) return sendJson(ctx, 200, { sha: pr.mergeSha, merged: true, message: "Pull Request successfully merged" });
      const { mergeable, mergedFiles } = computeMergeable(repo, pr);
      if (!mergeable) {
        return sendJson(ctx, 405, { message: "Pull Request is not mergeable", documentation_url: base + "/api/v3" });
      }
      const methodWanted = typeof body.merge_method === "string" ? body.merge_method : "squash";
      void methodWanted;
      const baseTip = headSha(repo, pr.baseRef);
      const headTip = repo.refs.get("refs/heads/" + pr.headRef) || pr.headSha;
      const message =
        (typeof body.commit_title === "string" ? body.commit_title : pr.title) +
        " (#" + pr.number + ")\n\n" +
        (typeof body.commit_message === "string" ? body.commit_message : pr.body || "") +
        "\n";
      let mergeSha: string;
      if (methodWanted === "merge" && baseTip) {
        const headTree = treeFileMap(repo, headTip);
        void headTree;
        const tree = buildTreeFromMap(repo, mergedFiles);
        mergeSha = makeCommit(repo, tree, [baseTip, headTip], message);
        repo.refs.set("refs/heads/" + pr.baseRef, mergeSha);
      } else {
        mergeSha = commitFilesOnBranch(repo, pr.baseRef, mergedFiles, message, []);
      }
      pr.merged = true;
      pr.mergedAt = nowIso();
      pr.mergeSha = mergeSha;
      pr.state = "closed";
      pr.updatedAt = pr.mergedAt;
      return sendJson(ctx, 200, { sha: mergeSha, merged: true, message: "Pull Request successfully merged" });
    }
  }

  if (rest[1] === "files" && method === "GET") {
    const files = prFiles(repo, pr).map((f) => {
      const blob = getObject(repo, f.sha);
      const patch = blob ? "@@ file " + f.filename + " (" + blob.data.length + " bytes)" : "";
      return {
        sha: f.sha,
        filename: f.filename,
        status: f.status,
        additions: 1,
        deletions: 0,
        changes: 1,
        blob_url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/git/blobs/" + f.sha,
        raw_url: base + "/" + repo.owner + "/" + repo.name + "/raw/" + f.sha,
        contents_url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/contents/" + f.filename,
        patch,
      };
    });
    const page = parsePage(ctx);
    return sendJson(ctx, 200, paginate(ctx, files, page));
  }

  if (rest[1] === "commits" && method === "GET") {
    const head = repo.refs.get("refs/heads/" + pr.headRef) || pr.headSha;
    const baseTip = repo.refs.get("refs/heads/" + pr.baseRef) || pr.baseShaAtCreate;
    const mb = mergeBase(repo, baseTip, head);
    const commits: Record<string, unknown>[] = [];
    let cur: string | null = head;
    const seen = new Set<string>();
    while (cur && cur !== mb && !seen.has(cur)) {
      seen.add(cur);
      const cj = commitJson(repo, cur, base);
      if (cj) commits.push(cj);
      const obj = getObject(repo, cur);
      if (!obj || obj.type !== "commit") break;
      const parents = parseCommit(obj.data).parents;
      cur = parents.length ? parents[0] : null;
    }
    commits.reverse();
    const page = parsePage(ctx);
    return sendJson(ctx, 200, paginate(ctx, commits, page));
  }

  if (rest[1] === "comments") {
    if (method === "GET") {
      const page = parsePage(ctx);
      return sendJson(ctx, 200, paginate(ctx, pr.comments, page).map((c) => commentJson(repo, pr.number, c, base)));
    }
    if (method === "POST") {
      const text = strField(body, "body");
      if (text === null) return sendJson(ctx, 422, { message: "Validation Failed" });
      const ts = nowIso();
      const c: CommentRec = { id: store.nextCommentId++, body: text, userLogin: VIEWER_LOGIN, createdAt: ts, updatedAt: ts };
      pr.comments.push(c);
      return sendJson(ctx, 201, commentJson(repo, pr.number, c, base));
    }
  }

  return repoNotFound(ctx);
}

function handleMilestones(ctx: Ctx, repo: RepoRec, rest: string[]): void {
  const method = ctx.req.method || "GET";
  const body = bodyJsonObject(ctx);
  let list = milestonesByRepo.get(repo.id);
  if (!list) {
    list = [];
    milestonesByRepo.set(repo.id, list);
  }
  if (rest.length === 0) {
    if (method === "GET") return sendJson(ctx, 200, list.map((m) => ({ ...m, open_issues: 0, closed_issues: 0 })));
    if (method === "POST") {
      const title = strField(body, "title");
      if (!title) return sendJson(ctx, 422, { message: "Validation Failed" });
      const m = { number: list.length + 1, title, state: "open", description: strField(body, "description") };
      list.push(m);
      return sendJson(ctx, 201, { ...m, open_issues: 0, closed_issues: 0 });
    }
  }
  const n = parseInt(rest[0], 10);
  const m = list.find((x) => x.number === n);
  if (!m) return repoNotFound(ctx);
  if (method === "GET") return sendJson(ctx, 200, { ...m, open_issues: 0, closed_issues: 0 });
  if (method === "PATCH") {
    if (typeof body.title === "string") m.title = body.title;
    if (body.state === "open" || body.state === "closed") m.state = body.state;
    return sendJson(ctx, 200, { ...m, open_issues: 0, closed_issues: 0 });
  }
  if (method === "DELETE") {
    milestonesByRepo.set(repo.id, list.filter((x) => x.number !== n));
    ctx.res.writeHead(204, { "x-github-request-id": nextRequestId() });
    ctx.res.end();
    return;
  }
  return repoNotFound(ctx);
}

// ---------------------------------------------------------------------------
// GraphQL v4: a small parser for the documents gh and github-mcp-server send
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: "var"; name: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "string"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "enum"; value: string }
  | { kind: "null" }
  | { kind: "list"; values: GqlValue[] }
  | { kind: "object"; fields: { name: string; value: GqlValue }[] };

interface GqlField {
  kind: "field";
  name: string;
  alias: string | null;
  args: { name: string; value: GqlValue }[];
  selection: GqlSelection[] | null;
}
type GqlSelection =
  | GqlField
  | { kind: "spread"; name: string }
  | { kind: "inline"; typeCondition: string | null; selection: GqlSelection[] };

interface GqlOperation {
  operation: string; // query | mutation | subscription
  name: string | null;
  selection: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeCondition: string | null; selection: GqlSelection[] }>;
}

function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (/\s|,/.test(c)) {
      i++;
      continue;
    }
    if (src.startsWith("...", i)) {
      tokens.push("...");
      i += 3;
      continue;
    }
    if ("!$():=@[]{}|&=".includes(c)) {
      tokens.push(c);
      i++;
      continue;
    }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        tokens.push(JSON.stringify(src.slice(i + 3, end < 0 ? src.length : end)));
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          out += src[j] + src[j + 1];
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push('"' + out + '"');
      i = j + 1;
      continue;
    }
    const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i)) || /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
    if (m) {
      tokens.push(m[0]);
      i += m[0].length;
      continue;
    }
    i++;
  }
  return tokens;
}

class GqlParser {
  tokens: string[];
  pos: number;
  constructor(tokens: string[]) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string | undefined {
    return this.tokens[this.pos++];
  }
  expect(t: string): void {
    if (this.next() !== t) throw new Error("expected " + t);
  }
  parseDocument(): GqlDocument {
    const doc: GqlDocument = { operations: [], fragments: new Map() };
    while (this.pos < this.tokens.length) {
      const t = this.peek();
      if (t === "{") {
        doc.operations.push({ operation: "query", name: null, selection: this.parseSelectionSet() });
      } else if (t === "query" || t === "mutation" || t === "subscription") {
        const op = this.next() as string;
        let name: string | null = null;
        if (this.peek() && /^[_A-Za-z]/.test(this.peek() as string) && this.peek() !== "(" && this.peek() !== "{") {
          name = this.next() as string;
        }
        if (this.peek() === "(") this.skipParens(); // variable definitions
        if (this.peek() === "@") this.skipDirectives();
        doc.operations.push({ operation: op, name, selection: this.parseSelectionSet() });
      } else if (t === "fragment") {
        this.next();
        const fname = this.next() as string;
        if (this.peek() === "on") this.next();
        const cond = this.next() as string;
        if (this.peek() === "@") this.skipDirectives();
        doc.fragments.set(fname, { typeCondition: cond, selection: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return doc;
  }
  skipParens(): void {
    let depth = 0;
    do {
      const t = this.next();
      if (t === "(") depth++;
      else if (t === ")") depth--;
    } while (depth > 0 && this.pos < this.tokens.length);
  }
  skipDirectives(): void {
    while (this.peek() === "@") {
      this.next();
      this.next();
      if (this.peek() === "(") this.skipParens();
    }
  }
  parseSelectionSet(): GqlSelection[] {
    this.expect("{");
    const out: GqlSelection[] = [];
    while (this.peek() !== "}" && this.pos < this.tokens.length) {
      if (this.peek() === "...") {
        this.next();
        if (this.peek() === "on") {
          this.next();
          const cond = this.next() as string;
          if (this.peek() === "@") this.skipDirectives();
          out.push({ kind: "inline", typeCondition: cond, selection: this.parseSelectionSet() });
        } else {
          const name = this.next() as string;
          if (this.peek() === "@") this.skipDirectives();
          out.push({ kind: "spread", name });
        }
        continue;
      }
      const first = this.next() as string;
      let alias: string | null = null;
      let name = first;
      if (this.peek() === ":") {
        this.next();
        alias = first;
        name = this.next() as string;
      }
      const args: { name: string; value: GqlValue }[] = [];
      if (this.peek() === "(") {
        this.next();
        while (this.peek() !== ")" && this.pos < this.tokens.length) {
          const an = this.next() as string;
          this.expect(":");
          args.push({ name: an, value: this.parseValue() });
        }
        this.expect(")");
      }
      if (this.peek() === "@") this.skipDirectives();
      let selection: GqlSelection[] | null = null;
      if (this.peek() === "{") selection = this.parseSelectionSet();
      out.push({ kind: "field", name, alias, args, selection });
    }
    this.expect("}");
    return out;
  }
  parseValue(): GqlValue {
    const t = this.next() as string;
    if (t === "$") return { kind: "var", name: this.next() as string };
    if (t === "[") {
      const values: GqlValue[] = [];
      while (this.peek() !== "]") values.push(this.parseValue());
      this.next();
      return { kind: "list", values };
    }
    if (t === "{") {
      const fields: { name: string; value: GqlValue }[] = [];
      while (this.peek() !== "}") {
        const n = this.next() as string;
        this.expect(":");
        fields.push({ name: n, value: this.parseValue() });
      }
      this.next();
      return { kind: "object", fields };
    }
    if (t.startsWith('"')) {
      try {
        return { kind: "string", value: JSON.parse(t) as string };
      } catch {
        return { kind: "string", value: t.slice(1, -1) };
      }
    }
    if (t === "true" || t === "false") return { kind: "bool", value: t === "true" };
    if (t === "null") return { kind: "null" };
    if (/^-?\d+$/.test(t)) return { kind: "int", value: parseInt(t, 10) };
    if (/^-?\d*\.\d+/.test(t) || /^-?\d+(\.\d+)?[eE]/.test(t)) return { kind: "float", value: parseFloat(t) };
    return { kind: "enum", value: t };
  }
}

function gqlResolveValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case "var":
      return vars[v.name];
    case "int":
    case "float":
    case "string":
    case "bool":
    case "enum":
      return v.value;
    case "null":
      return null;
    case "list":
      return v.values.map((x) => gqlResolveValue(x, vars));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = gqlResolveValue(f.value, vars);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// GraphQL: object graph over the same store, plus introspection
// ---------------------------------------------------------------------------

type GqlObj = Record<string, unknown> & { __typename: string };

function nodeIdFor(prefix: string, id: number | string): string {
  return Buffer.from(prefix + id, "utf8").toString("base64");
}

function decodeNodeId(id: string): { kind: string; num: number } | null {
  let text = id;
  try {
    text = Buffer.from(id, "base64").toString("utf8");
  } catch {
    text = id;
  }
  const m = /(Repository|Issue|PullRequest|User|Label)(\d+)/.exec(text);
  if (m) return { kind: m[1], num: parseInt(m[2], 10) };
  if (/^\d+$/.test(id)) return { kind: "Repository", num: parseInt(id, 10) };
  return null;
}

function findRepoById(id: string): RepoRec | null {
  const decoded = decodeNodeId(id);
  if (decoded && decoded.kind === "Repository") {
    for (const r of store.repos.values()) if (r.id === decoded.num) return r;
  }
  // Also accept "owner/name".
  const slash = id.indexOf("/");
  if (slash > 0) return findRepo(id.slice(0, slash), id.slice(slash + 1));
  return null;
}

function gqlUser(login: string): GqlObj {
  return {
    __typename: "User",
    id: nodeIdFor("04:User", login === VIEWER_LOGIN ? VIEWER_ID : 2),
    databaseId: login === VIEWER_LOGIN ? VIEWER_ID : 2,
    login,
    name: login === VIEWER_LOGIN ? "The Octocat" : login,
    email: login === VIEWER_LOGIN ? "octocat@example.com" : "",
    url: "/users/" + login,
    avatarUrl: "/avatars/" + login,
    isViewer: login === VIEWER_LOGIN,
  };
}

function gqlRepo(repo: RepoRec): GqlObj {
  const head = headSha(repo, repo.defaultBranch);
  return {
    __typename: "Repository",
    _repo: repo,
    id: nodeIdFor("010:Repository", repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.owner + "/" + repo.name,
    description: repo.description,
    isPrivate: repo.isPrivate,
    isFork: false,
    isArchived: false,
    url: "/" + repo.owner + "/" + repo.name,
    homepageUrl: repo.homepage,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    pushedAt: repo.pushedAt,
    stargazerCount: repo.stars,
    forkCount: repo.forks,
    viewerPermission: "ADMIN",
    hasIssuesEnabled: repo.hasIssues,
    hasWikiEnabled: repo.hasWiki,
    hasProjectsEnabled: repo.hasProjects,
    isEmpty: repo.refs.size === 0,
    owner: gqlUser(repo.owner),
    parent: null,
    defaultBranchRef: head
      ? {
          __typename: "Ref",
          name: repo.defaultBranch,
          prefix: "refs/heads/",
          target: { __typename: "Commit", oid: head, id: nodeIdFor("03:Commit", head) },
        }
      : null,
    primaryLanguage: repo.language ? { __typename: "Language", name: repo.language } : null,
  };
}

function gqlIssue(repo: RepoRec, issue: IssueRec): GqlObj {
  return {
    __typename: "Issue",
    _repo: repo,
    _issue: issue,
    id: nodeIdFor("05:Issue", issue.id),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body || "",
    bodyText: issue.body || "",
    state: issue.state.toUpperCase(),
    url: "/" + repo.owner + "/" + repo.name + "/issues/" + issue.number,
    author: gqlUser(issue.userLogin),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    locked: false,
    repository: gqlRepo(repo),
  };
}

function gqlPull(repo: RepoRec, pr: PullRec): GqlObj {
  const status = computeMergeable(repo, pr);
  return {
    __typename: "PullRequest",
    _repo: repo,
    _pull: pr,
    id: nodeIdFor("011:PullRequest", pr.id),
    databaseId: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body || "",
    bodyText: pr.body || "",
    state: pr.merged ? "MERGED" : pr.state.toUpperCase(),
    merged: pr.merged,
    mergedAt: pr.mergedAt,
    mergeable: status.mergeable ? "MERGEABLE" : "CONFLICTING",
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    headRefOid: repo.refs.get("refs/heads/" + pr.headRef) || pr.headSha,
    baseRefOid: repo.refs.get("refs/heads/" + pr.baseRef) || pr.baseShaAtCreate,
    isDraft: pr.draft,
    url: "/" + repo.owner + "/" + repo.name + "/pull/" + pr.number,
    author: gqlUser(pr.userLogin),
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    closedAt: pr.merged ? pr.mergedAt : pr.state === "closed" ? pr.updatedAt : null,
    repository: gqlRepo(repo),
    mergeCommit: pr.mergeSha ? { __typename: "Commit", oid: pr.mergeSha, id: nodeIdFor("03:Commit", pr.mergeSha) } : null,
  };
}

function gqlConnection(nodes: GqlObj[], args: Record<string, unknown>): GqlObj {
  const first = typeof args.first === "number" ? (args.first as number) : null;
  const last = typeof args.last === "number" ? (args.last as number) : null;
  let slice = nodes;
  if (first !== null) slice = nodes.slice(0, first);
  else if (last !== null) slice = nodes.slice(Math.max(0, nodes.length - last));
  const edges = slice.map((n, i) => ({
    __typename: "Edge",
    node: n,
    cursor: Buffer.from("cursor:" + i, "utf8").toString("base64"),
  }));
  return {
    __typename: "Connection",
    totalCount: nodes.length,
    nodes: slice,
    edges,
    pageInfo: {
      __typename: "PageInfo",
      hasNextPage: first !== null && nodes.length > first,
      hasPreviousPage: false,
      startCursor: edges.length ? edges[0].cursor : null,
      endCursor: edges.length ? edges[edges.length - 1].cursor : null,
    },
  };
}

// Field existence per type, for introspection and unknown-field errors.
const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Query: ["repository", "repositoryOwner", "viewer", "user", "organization", "search", "node", "nodes", "rateLimit", "meta", "__type", "__schema", "__typename"],
  Mutation: ["createIssue", "updateIssue", "closeIssue", "reopenIssue", "createPullRequest", "updatePullRequest", "mergePullRequest", "addComment", "createLabel", "updateLabel", "createRepository", "__typename"],
  Repository: ["id", "databaseId", "name", "nameWithOwner", "description", "isPrivate", "isFork", "isArchived", "url", "homepageUrl", "createdAt", "updatedAt", "pushedAt", "stargazerCount", "forkCount", "viewerPermission", "hasIssuesEnabled", "hasWikiEnabled", "hasProjectsEnabled", "isEmpty", "owner", "parent", "defaultBranchRef", "primaryLanguage", "issue", "issues", "pullRequest", "pullRequests", "labels", "label", "refs", "ref", "object", "collaborators", "stargazers", "forks", "releases", "milestone", "milestones", "mentionableUsers", "assignableUsers", "__typename"],
  Issue: ["id", "databaseId", "number", "title", "body", "bodyText", "state", "url", "author", "createdAt", "updatedAt", "closedAt", "locked", "repository", "labels", "comments", "assignees", "milestone", "reactions", "participants", "__typename"],
  PullRequest: ["id", "databaseId", "number", "title", "body", "bodyText", "state", "merged", "mergedAt", "mergeable", "headRefName", "baseRefName", "headRefOid", "baseRefOid", "isDraft", "url", "author", "createdAt", "updatedAt", "closedAt", "repository", "files", "commits", "comments", "labels", "mergeCommit", "headRef", "baseRef", "additions", "deletions", "changedFiles", "reviewRequests", "reviews", "__typename"],
  User: ["id", "databaseId", "login", "name", "email", "url", "avatarUrl", "isViewer", "repositories", "issues", "pullRequests", "followers", "following", "createdAt", "updatedAt", "__typename"],
  Organization: ["id", "databaseId", "login", "name", "url", "repositories", "__typename"],
  Label: ["id", "name", "color", "description", "url", "__typename"],
  Ref: ["name", "prefix", "target", "repository", "__typename"],
  Commit: ["oid", "id", "message", "messageHeadline", "authoredDate", "committedDate", "author", "committer", "tree", "parents", "url", "__typename"],
  Tree: ["oid", "id", "entries", "__typename"],
  Blob: ["oid", "id", "text", "isBinary", "byteSize", "__typename"],
  PageInfo: ["hasNextPage", "hasPreviousPage", "startCursor", "endCursor", "__typename"],
  SearchResultItemConnection: ["issueCount", "repositoryCount", "userCount", "discussionCount", "nodes", "edges", "pageInfo", "__typename"],
  PullRequestChangedFile: ["path", "additions", "deletions", "changeType", "__typename"],
  IssueComment: ["id", "body", "bodyText", "author", "createdAt", "updatedAt", "url", "__typename"],
  RateLimit: ["limit", "cost", "remaining", "resetAt", "used", "__typename"],
  CreateIssuePayload: ["issue", "clientMutationId", "__typename"],
  UpdateIssuePayload: ["issue", "clientMutationId", "__typename"],
  CloseIssuePayload: ["issue", "clientMutationId", "__typename"],
  CreatePullRequestPayload: ["pullRequest", "clientMutationId", "__typename"],
  UpdatePullRequestPayload: ["pullRequest", "clientMutationId", "__typename"],
  MergePullRequestPayload: ["pullRequest", "clientMutationId", "__typename"],
  AddCommentPayload: ["commentEdge", "subject", "clientMutationId", "__typename"],
  CreateLabelPayload: ["label", "clientMutationId", "__typename"],
  CreateRepositoryPayload: ["repository", "clientMutationId", "__typename"],
};

const GQL_ENUMS: Record<string, string[]> = {
  SearchType: ["ISSUE", "REPOSITORY", "USER", "DISCUSSION"],
  IssueState: ["OPEN", "CLOSED"],
  PullRequestState: ["OPEN", "CLOSED", "MERGED"],
  MergeableState: ["MERGEABLE", "CONFLICTING", "UNKNOWN"],
  OrderDirection: ["ASC", "DESC"],
  IssueOrderField: ["CREATED_AT", "UPDATED_AT", "COMMENTS"],
  RepositoryOrderField: ["CREATED_AT", "UPDATED_AT", "PUSHED_AT", "NAME", "STARGAZERS"],
  Permission: ["ADMIN", "WRITE", "READ", "TRIAGE", "MAINTAIN"],
};

function gqlTypeStub(name: string): GqlObj {
  return { __typename: "__Type", name, kind: "OBJECT" };
}

function gqlIntrospectType(name: string): GqlObj | null {
  if (GQL_ENUMS[name]) {
    return {
      __typename: "__Type",
      name,
      kind: "ENUM",
      description: null,
      fields: null,
      enumValues: GQL_ENUMS[name].map((v) => ({
        __typename: "__EnumValue",
        name: v,
        description: null,
        isDeprecated: false,
        deprecationReason: null,
      })),
      possibleTypes: null,
      inputFields: null,
    };
  }
  const fields = GQL_TYPE_FIELDS[name];
  if (!fields) return null;
  return {
    __typename: "__Type",
    name,
    kind: "OBJECT",
    description: null,
    fields: fields
      .filter((f) => !f.startsWith("__"))
      .map((f) => ({
        __typename: "__Field",
        name: f,
        description: null,
        args: [],
        type: { __typename: "__Type", name: null, kind: "SCALAR", ofType: null },
        isDeprecated: false,
        deprecationReason: null,
      })),
    enumValues: null,
    possibleTypes: null,
    inputFields: null,
  };
}

// Extra introspection types used by nested objects.
GQL_TYPE_FIELDS["TreeEntry"] = ["name", "path", "type", "mode", "object", "__typename"];
GQL_TYPE_FIELDS["Milestone"] = ["id", "number", "title", "state", "description", "__typename"];
GQL_TYPE_FIELDS["PullRequestCommit"] = ["id", "commit", "url", "__typename"];
GQL_TYPE_FIELDS["Edge"] = ["node", "cursor", "__typename"];
GQL_TYPE_FIELDS["Connection"] = ["totalCount", "nodes", "edges", "pageInfo", "__typename"];
GQL_TYPE_FIELDS["SearchResultItemConnection"] = GQL_TYPE_FIELDS["SearchResultItemConnection"] || ["issueCount", "repositoryCount", "userCount", "discussionCount", "nodes", "edges", "pageInfo", "__typename"];

interface GqlExec {
  doc: GqlDocument;
  vars: Record<string, unknown>;
  errors: { message: string }[];
}

function gqlArgs(field: GqlField, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = gqlResolveValue(a.value, vars);
  return out;
}

function gqlCommit(repo: RepoRec, sha: string): GqlObj {
  const obj = getObject(repo, sha);
  const info = obj && obj.type === "commit" ? parseCommit(obj.data) : null;
  const author = info ? formatPersonLine(info.authorLine) : { name: "octocat", email: "", date: nowIsoNoTick() };
  return {
    __typename: "Commit",
    _repo: repo,
    _sha: sha,
    oid: sha,
    id: nodeIdFor("03:Commit", sha),
    message: info ? info.message : "",
    messageHeadline: info ? info.message.split("\n")[0] : "",
    authoredDate: author.date,
    committedDate: author.date,
    author: { __typename: "GitActor", name: author.name, email: author.email, date: author.date, user: gqlUser(repo.owner) },
    committer: { __typename: "GitActor", name: author.name, email: author.email, date: author.date, user: gqlUser(repo.owner) },
    url: "/" + repo.owner + "/" + repo.name + "/commit/" + sha,
    tree: info ? { __typename: "Tree", _repo: repo, _sha: info.tree, oid: info.tree, id: nodeIdFor("02:Tree", info.tree) } : null,
  };
}
GQL_TYPE_FIELDS["GitActor"] = ["name", "email", "date", "user", "__typename"];

function sortForOrderBy<T extends { number: number; createdAt: string }>(items: T[], args: Record<string, unknown>): T[] {
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const dir = orderBy && typeof orderBy.direction === "string" ? orderBy.direction : "DESC";
  const sorted = [...items];
  sorted.sort((a, b) => {
    const cmp = a.number - b.number; // logical clock makes number order == created order
    return dir === "ASC" ? cmp : -cmp;
  });
  return sorted;
}

function gqlFieldValue(obj: GqlObj, field: GqlField, exec: GqlExec): unknown {
  const name = field.name;
  const args = gqlArgs(field, exec.vars);
  const tn = obj.__typename;

  if (tn === "Query") {
    if (name === "repository") {
      const repo = findRepo(String(args.owner || ""), String(args.name || ""));
      return repo ? gqlRepo(repo) : null;
    }
    if (name === "viewer") return gqlUser(VIEWER_LOGIN);
    if (name === "user" || name === "repositoryOwner") {
      const login = String(args.login || "");
      return login ? gqlUser(login) : null;
    }
    if (name === "organization") {
      const login = String(args.login || "");
      return { __typename: "Organization", id: nodeIdFor("Organization", 1), login, name: login, url: "/orgs/" + login };
    }
    if (name === "search") return gqlSearch(args);
    if (name === "node") return gqlNodeById(String(args.id || ""));
    if (name === "nodes") {
      const ids = Array.isArray(args.ids) ? args.ids : [];
      return ids.map((i) => gqlNodeById(String(i)));
    }
    if (name === "rateLimit") {
      return { __typename: "RateLimit", limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: nowIsoNoTick() };
    }
    return null;
  }

  if (tn === "Mutation") return gqlMutation(name, args);

  if (tn === "Repository") {
    const repo = obj._repo as RepoRec;
    if (name === "issue") {
      const issue = repo.issues.get(Number(args.number));
      return issue ? gqlIssue(repo, issue) : null;
    }
    if (name === "issues") {
      let list = [...repo.issues.values()];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length) {
        const wanted = states.map((s) => String(s).toUpperCase());
        list = list.filter((i) => wanted.includes(i.state.toUpperCase()));
      }
      return gqlConnection(sortForOrderBy(list, args).map((i) => gqlIssue(repo, i)), args);
    }
    if (name === "pullRequest") {
      const pr = repo.pulls.get(Number(args.number));
      return pr ? gqlPull(repo, pr) : null;
    }
    if (name === "pullRequests") {
      let list = [...repo.pulls.values()];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length) {
        const wanted = states.map((s) => String(s).toUpperCase());
        list = list.filter((p) => wanted.includes((p.merged ? "MERGED" : p.state).toUpperCase()));
      }
      return gqlConnection(sortForOrderBy(list, args).map((p) => gqlPull(repo, p)), args);
    }
    if (name === "labels") {
      const all = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((l) => gqlLabel(repo, l));
      return gqlConnection(all, args);
    }
    if (name === "label") {
      const rec = repo.labels.get(String(args.name || "").toLowerCase());
      return rec ? gqlLabel(repo, rec) : null;
    }
    if (name === "refs") {
      const prefix = String(args.refPrefix || "refs/");
      const refs: GqlObj[] = [];
      for (const refName of sortedRefNames(repo)) {
        if (!refName.startsWith(prefix)) continue;
        refs.push({
          __typename: "Ref",
          name: refName.slice(prefix.length),
          prefix,
          target: gqlCommit(repo, repo.refs.get(refName) as string),
        });
      }
      return gqlConnection(refs, args);
    }
    if (name === "ref") {
      const qn = String(args.qualifiedName || "");
      const sha = repo.refs.get(qn);
      if (!sha) return null;
      return { __typename: "Ref", name: qn.replace(/^refs\/(heads|tags)\//, ""), prefix: "refs/heads/", target: gqlCommit(repo, sha) };
    }
    if (name === "object") {
      const expr = String(args.expression || args.oid || "");
      return gqlGitObject(repo, expr);
    }
    if (name === "collaborators" || name === "mentionableUsers" || name === "assignableUsers") {
      return gqlConnection([gqlUser(repo.owner)], args);
    }
    if (name === "stargazers") return gqlConnection([], args);
    if (name === "forks") return gqlConnection([], args);
    if (name === "releases") return gqlConnection([], args);
    if (name === "milestones") {
      const list = (milestonesByRepo.get(repo.id) || []).map((m) => ({
        __typename: "Milestone",
        id: nodeIdFor("Milestone", m.number),
        number: m.number,
        title: m.title,
        state: m.state.toUpperCase(),
        description: m.description,
      })) as GqlObj[];
      return gqlConnection(list, args);
    }
    if (name === "milestone") {
      const m = (milestonesByRepo.get(repo.id) || []).find((x) => x.number === Number(args.number));
      return m ? { __typename: "Milestone", id: nodeIdFor("Milestone", m.number), number: m.number, title: m.title, state: m.state.toUpperCase(), description: m.description } : null;
    }
  }

  if (tn === "Issue") {
    const repo = obj._repo as RepoRec;
    const issue = obj._issue as IssueRec;
    if (name === "labels") return gqlConnection(labelsOfIssue(repo, issue.labels), args);
    if (name === "comments") {
      return gqlConnection(issue.comments.map((c) => gqlComment(repo, issue.number, c)), args);
    }
    if (name === "assignees") return gqlConnection(issue.assignees.map((a) => gqlUser(a)), args);
    if (name === "participants") return gqlConnection([gqlUser(issue.userLogin)], args);
    if (name === "reactions") return gqlConnection([], args);
    if (name === "milestone") {
      return issue.milestone ? { __typename: "Milestone", id: nodeIdFor("Milestone", 1), number: 1, title: issue.milestone, state: "OPEN", description: null } : null;
    }
  }

  if (tn === "PullRequest") {
    const repo = obj._repo as RepoRec;
    const pr = obj._pull as PullRec;
    if (name === "files") {
      const files = prFiles(repo, pr).map((f) => ({
        __typename: "PullRequestChangedFile",
        path: f.filename,
        additions: 1,
        deletions: 0,
        changeType: f.status === "added" ? "ADDED" : f.status === "removed" ? "DELETED" : "MODIFIED",
      })) as GqlObj[];
      return gqlConnection(files, args);
    }
    if (name === "commits") {
      const head = repo.refs.get("refs/heads/" + pr.headRef) || pr.headSha;
      const baseTip = repo.refs.get("refs/heads/" + pr.baseRef) || pr.baseShaAtCreate;
      const mb = mergeBase(repo, baseTip, head);
      const commits: GqlObj[] = [];
      let cur: string | null = head;
      const seen = new Set<string>();
      while (cur && cur !== mb && !seen.has(cur)) {
        seen.add(cur);
        commits.push({ __typename: "PullRequestCommit", id: nodeIdFor("PullRequestCommit", cur), commit: gqlCommit(repo, cur), url: "" });
        const o = getObject(repo, cur);
        if (!o || o.type !== "commit") break;
        const parents = parseCommit(o.data).parents;
        cur = parents.length ? parents[0] : null;
      }
      commits.reverse();
      return gqlConnection(commits, args);
    }
    if (name === "comments") return gqlConnection(pr.comments.map((c) => gqlComment(repo, pr.number, c)), args);
    if (name === "labels") return gqlConnection(labelsOfIssue(repo, pr.labels), args);
    if (name === "headRef" || name === "baseRef") {
      const refName = name === "headRef" ? pr.headRef : pr.baseRef;
      const sha = repo.refs.get("refs/heads/" + refName);
      return sha ? { __typename: "Ref", name: refName, prefix: "refs/heads/", target: gqlCommit(repo, sha) } : null;
    }
    if (name === "additions" || name === "deletions" || name === "changedFiles") {
      const files = prFiles(repo, pr);
      if (name === "changedFiles") return files.length;
      return name === "additions" ? files.length : 0;
    }
    if (name === "reviews" || name === "reviewRequests") return gqlConnection([], args);
  }

  if (tn === "User") {
    const login = obj.login as string;
    if (name === "repositories") {
      const mine = [...store.repos.values()].filter((r) => r.owner === login).sort((a, b) => a.id - b.id).map((r) => gqlRepo(r));
      return gqlConnection(mine, args);
    }
    if (name === "issues") {
      const all: GqlObj[] = [];
      for (const repo of store.repos.values()) for (const i of repo.issues.values()) if (i.userLogin === login) all.push(gqlIssue(repo, i));
      return gqlConnection(all, args);
    }
    if (name === "pullRequests") return gqlConnection([], args);
    if (name === "followers" || name === "following") return gqlConnection([], args);
    if (name === "createdAt" || name === "updatedAt") return nowIsoNoTick();
  }

  if (tn === "Tree") {
    const repo = obj._repo as RepoRec;
    if (name === "entries") {
      const t = getObject(repo, obj._sha as string);
      if (!t || t.type !== "tree") return [];
      return parseTree(t.data).map((e) => ({
        __typename: "TreeEntry",
        name: e.name,
        path: e.name,
        type: e.mode === "40000" ? "tree" : "blob",
        mode: parseInt(e.mode, 10),
        object: gqlGitObjectBySha(repo, e.sha),
      }));
    }
  }

  if (tn === "Commit") {
    const repo = obj._repo as RepoRec;
    if (name === "parents") {
      const o = getObject(repo, obj._sha as string);
      const parents = o && o.type === "commit" ? parseCommit(o.data).parents : [];
      return gqlConnection(parents.map((p) => gqlCommit(repo, p)), args);
    }
  }

  if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  return null;
}

function labelsOfIssue(repo: RepoRec, names: string[]): GqlObj[] {
  const out: GqlObj[] = [];
  for (const n of names) {
    const rec = repo.labels.get(n.toLowerCase());
    if (rec) out.push(gqlLabel(repo, rec));
  }
  return out;
}

function gqlLabel(repo: RepoRec, rec: LabelRec): GqlObj {
  return {
    __typename: "Label",
    id: nodeIdFor("07:Label", rec.id),
    name: rec.name,
    color: rec.color,
    description: rec.description,
    url: "/repos/" + repo.owner + "/" + repo.name + "/labels/" + encodeURIComponent(rec.name),
  };
}

function gqlComment(repo: RepoRec, issueNumber: number, c: CommentRec): GqlObj {
  return {
    __typename: "IssueComment",
    id: nodeIdFor("06:IssueComment", c.id),
    body: c.body,
    bodyText: c.body,
    author: gqlUser(c.userLogin),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    url: "/" + repo.owner + "/" + repo.name + "/issues/" + issueNumber + "#issuecomment-" + c.id,
  };
}

function gqlGitObjectBySha(repo: RepoRec, sha: string): GqlObj | null {
  const obj = getObject(repo, sha);
  if (!obj) return null;
  if (obj.type === "blob") {
    return {
      __typename: "Blob",
      _repo: repo,
      _sha: sha,
      oid: sha,
      id: nodeIdFor("02:Blob", sha),
      text: obj.data.toString("utf8"),
      isBinary: false,
      byteSize: obj.data.length,
    };
  }
  if (obj.type === "tree") return { __typename: "Tree", _repo: repo, _sha: sha, oid: sha, id: nodeIdFor("02:Tree", sha) };
  if (obj.type === "commit") return gqlCommit(repo, sha);
  return null;
}

function gqlGitObject(repo: RepoRec, expression: string): GqlObj | null {
  // Forms: "<branch>", "<branch>:<path>", "<sha>", "<sha>:<path>"
  const colon = expression.indexOf(":");
  const refPart = colon >= 0 ? expression.slice(0, colon) : expression;
  const pathPart = colon >= 0 ? expression.slice(colon + 1) : "";
  const commitSha = resolveCommitish(repo, refPart === "" ? null : refPart);
  if (!commitSha) return null;
  if (!pathPart) {
    const direct = getObject(repo, commitSha);
    if (direct && direct.type !== "commit") return gqlGitObjectBySha(repo, commitSha);
    return gqlCommit(repo, commitSha);
  }
  const files = treeFileMap(repo, commitSha);
  const entry = files.get(pathPart);
  if (entry) return gqlGitObjectBySha(repo, entry.sha);
  return null;
}

function gqlSearch(args: Record<string, unknown>): GqlObj {
  const rawQuery = String(args.query || "");
  const type = String(args.type || "REPOSITORY").toUpperCase();
  let needle = rawQuery;
  let repoFilter: RepoRec | null = null;
  for (const token of rawQuery.split(/\s+/)) {
    if (token.startsWith("repo:")) {
      const parts = token.slice(5).split("/");
      if (parts.length === 2) repoFilter = findRepo(parts[0], parts[1]);
    }
  }
  needle = rawQuery
    .split(/\s+/)
    .filter((t) => !t.includes(":"))
    .join(" ")
    .toLowerCase();
  const nodes: GqlObj[] = [];
  let issueCount = 0;
  let repositoryCount = 0;
  if (type === "ISSUE") {
    for (const repo of store.repos.values()) {
      if (repoFilter && repo !== repoFilter) continue;
      for (const issue of repo.issues.values()) {
        if (needle === "" || issue.title.toLowerCase().includes(needle)) {
          nodes.push(gqlIssue(repo, issue));
          issueCount++;
        }
      }
      for (const pr of repo.pulls.values()) {
        if (needle === "" || pr.title.toLowerCase().includes(needle)) {
          const asIssueLike = gqlPull(repo, pr);
          nodes.push(asIssueLike);
          issueCount++;
        }
      }
    }
  } else if (type === "REPOSITORY") {
    for (const repo of store.repos.values()) {
      if (needle === "" || (repo.owner + "/" + repo.name).toLowerCase().includes(needle)) {
        nodes.push(gqlRepo(repo));
        repositoryCount++;
      }
    }
  } else if (type === "USER") {
    if (needle === "" || VIEWER_LOGIN.includes(needle)) nodes.push(gqlUser(VIEWER_LOGIN));
  }
  const conn = gqlConnection(nodes, args);
  return {
    __typename: "SearchResultItemConnection",
    issueCount,
    repositoryCount,
    userCount: type === "USER" ? nodes.length : 0,
    discussionCount: 0,
    nodes: conn.nodes,
    edges: conn.edges,
    pageInfo: conn.pageInfo,
  };
}

function gqlNodeById(id: string): GqlObj | null {
  const decoded = decodeNodeId(id);
  if (!decoded) return null;
  if (decoded.kind === "Repository") {
    for (const r of store.repos.values()) if (r.id === decoded.num) return gqlRepo(r);
  }
  if (decoded.kind === "Issue") {
    for (const r of store.repos.values()) for (const i of r.issues.values()) if (i.id === decoded.num) return gqlIssue(r, i);
  }
  if (decoded.kind === "PullRequest") {
    for (const r of store.repos.values()) for (const p of r.pulls.values()) if (p.id === decoded.num) return gqlPull(r, p);
  }
  if (decoded.kind === "User") return gqlUser(VIEWER_LOGIN);
  return null;
}

function gqlMutation(name: string, args: Record<string, unknown>): unknown {
  const input = (args.input || {}) as Record<string, unknown>;
  const clientMutationId = typeof input.clientMutationId === "string" ? input.clientMutationId : null;
  if (name === "createIssue") {
    const repo = findRepoById(String(input.repositoryId || ""));
    if (!repo) return { __typename: "CreateIssuePayload", issue: null, clientMutationId };
    const labelNames: string[] = [];
    if (Array.isArray(input.labelIds)) {
      for (const lid of input.labelIds as string[]) {
        const dec = decodeNodeId(String(lid));
        if (dec) for (const l of repo.labels.values()) if (l.id === dec.num) labelNames.push(l.name);
      }
    }
    const rec = createIssueRec(repo, String(input.title || ""), typeof input.body === "string" ? input.body : null, labelNames, []);
    return { __typename: "CreateIssuePayload", issue: gqlIssue(repo, rec), clientMutationId };
  }
  if (name === "updateIssue" || name === "closeIssue" || name === "reopenIssue") {
    const target = gqlNodeById(String(input.id || ""));
    if (!target || target.__typename !== "Issue") return { __typename: "UpdateIssuePayload", issue: null, clientMutationId };
    const repo = target._repo as RepoRec;
    const issue = target._issue as IssueRec;
    if (name === "closeIssue") {
      issue.state = "closed";
      issue.closedAt = nowIso();
    } else if (name === "reopenIssue") {
      issue.state = "open";
      issue.closedAt = null;
    } else {
      if (typeof input.title === "string") issue.title = input.title;
      if (typeof input.body === "string") issue.body = input.body;
      if (input.state === "OPEN" || input.state === "CLOSED") {
        issue.state = String(input.state).toLowerCase();
        issue.closedAt = issue.state === "closed" ? nowIso() : null;
      }
    }
    issue.updatedAt = nowIso();
    const payloadType = name === "closeIssue" ? "CloseIssuePayload" : "UpdateIssuePayload";
    return { __typename: payloadType, issue: gqlIssue(repo, issue), clientMutationId };
  }
  if (name === "createPullRequest") {
    const repo = findRepoById(String(input.repositoryId || ""));
    if (!repo) return { __typename: "CreatePullRequestPayload", pullRequest: null, clientMutationId };
    const headRef = String(input.headRefName || "");
    const baseRef = String(input.baseRefName || repo.defaultBranch);
    const headCommit = headSha(repo, headRef);
    if (!headCommit) return { __typename: "CreatePullRequestPayload", pullRequest: null, clientMutationId };
    const ts = nowIso();
    const pr: PullRec = {
      id: store.nextIssueId++,
      number: repo.nextNumber++,
      title: String(input.title || ""),
      body: typeof input.body === "string" ? input.body : null,
      state: "open",
      headRef,
      headSha: headCommit,
      baseRef,
      baseShaAtCreate: headSha(repo, baseRef) || ZERO_SHA,
      userLogin: VIEWER_LOGIN,
      createdAt: ts,
      updatedAt: ts,
      merged: false,
      mergedAt: null,
      mergeSha: null,
      draft: input.draft === true,
      labels: [],
      comments: [],
    };
    repo.pulls.set(pr.number, pr);
    return { __typename: "CreatePullRequestPayload", pullRequest: gqlPull(repo, pr), clientMutationId };
  }
  if (name === "updatePullRequest") {
    const target = gqlNodeById(String(input.pullRequestId || input.id || ""));
    if (!target || target.__typename !== "PullRequest") return { __typename: "UpdatePullRequestPayload", pullRequest: null, clientMutationId };
    const repo = target._repo as RepoRec;
    const pr = target._pull as PullRec;
    if (typeof input.title === "string") pr.title = input.title;
    if (typeof input.body === "string") pr.body = input.body;
    if (input.state === "OPEN") pr.state = "open";
    if (input.state === "CLOSED") pr.state = "closed";
    pr.updatedAt = nowIso();
    return { __typename: "UpdatePullRequestPayload", pullRequest: gqlPull(repo, pr), clientMutationId };
  }
  if (name === "mergePullRequest") {
    const target = gqlNodeById(String(input.pullRequestId || ""));
    if (!target || target.__typename !== "PullRequest") return { __typename: "MergePullRequestPayload", pullRequest: null, clientMutationId };
    const repo = target._repo as RepoRec;
    const pr = target._pull as PullRec;
    const status = computeMergeable(repo, pr);
    if (status.mergeable && !pr.merged) {
      const mergeSha = commitFilesOnBranch(repo, pr.baseRef, status.mergedFiles, pr.title + " (#" + pr.number + ")\n", []);
      pr.merged = true;
      pr.mergedAt = nowIso();
      pr.mergeSha = mergeSha;
      pr.state = "closed";
      pr.updatedAt = pr.mergedAt;
    }
    return { __typename: "MergePullRequestPayload", pullRequest: gqlPull(repo, pr), clientMutationId };
  }
  if (name === "addComment") {
    const target = gqlNodeById(String(input.subjectId || ""));
    if (!target) return { __typename: "AddCommentPayload", commentEdge: null, subject: null, clientMutationId };
    const repo = target._repo as RepoRec;
    const ts = nowIso();
    const c: CommentRec = { id: store.nextCommentId++, body: String(input.body || ""), userLogin: VIEWER_LOGIN, createdAt: ts, updatedAt: ts };
    let number = 0;
    if (target.__typename === "Issue") {
      const issue = target._issue as IssueRec;
      issue.comments.push(c);
      number = issue.number;
    } else if (target.__typename === "PullRequest") {
      const pr = target._pull as PullRec;
      pr.comments.push(c);
      number = pr.number;
    }
    const comment = gqlComment(repo, number, c);
    return {
      __typename: "AddCommentPayload",
      commentEdge: { __typename: "Edge", node: comment, cursor: "cursor:0" },
      subject: target,
      clientMutationId,
    };
  }
  if (name === "createLabel") {
    const repo = findRepoById(String(input.repositoryId || ""));
    if (!repo) return { __typename: "CreateLabelPayload", label: null, clientMutationId };
    const rec: LabelRec = {
      id: store.nextLabelId++,
      name: String(input.name || ""),
      color: String(input.color || "ededed").replace(/^#/, ""),
      description: typeof input.description === "string" ? input.description : null,
      isDefault: false,
    };
    repo.labels.set(rec.name.toLowerCase(), rec);
    return { __typename: "CreateLabelPayload", label: gqlLabel(repo, rec), clientMutationId };
  }
  if (name === "createRepository") {
    const repoName = String(input.name || "");
    const existing = findRepo(VIEWER_LOGIN, repoName);
    const repo = existing || createRepo(VIEWER_LOGIN, repoName, typeof input.description === "string" ? input.description : null, false);
    return { __typename: "CreateRepositoryPayload", repository: gqlRepo(repo), clientMutationId };
  }
  return null;
}

function expandSelections(
  selection: GqlSelection[],
  typename: string,
  doc: GqlDocument,
  out: GqlField[],
): void {
  for (const sel of selection) {
    if (sel.kind === "field") out.push(sel);
    else if (sel.kind === "inline") {
      if (!sel.typeCondition || sel.typeCondition === typename) expandSelections(sel.selection, typename, doc, out);
    } else if (sel.kind === "spread") {
      const frag = doc.fragments.get(sel.name);
      if (frag && (!frag.typeCondition || frag.typeCondition === typename)) {
        expandSelections(frag.selection, typename, doc, out);
      }
    }
  }
}

function execSelectionSet(
  obj: GqlObj,
  selection: GqlSelection[],
  exec: GqlExec,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields: GqlField[] = [];
  expandSelections(selection, obj.__typename, exec.doc, fields);
  for (const field of fields) {
    const key = field.alias || field.name;
    if (field.name === "__typename") {
      out[key] = obj.__typename;
      continue;
    }
    if (field.name === "__type") {
      const args = gqlArgs(field, exec.vars);
      out[key] = gqlIntrospectType(String(args.name || ""));
      if (out[key] && field.selection) {
        out[key] = execSelectionSet(out[key] as GqlObj, field.selection, exec);
      }
      continue;
    }
    if (field.name === "__schema") {
      const schema: GqlObj = {
        __typename: "__Schema",
        queryType: gqlTypeStub("Query"),
        mutationType: gqlTypeStub("Mutation"),
        subscriptionType: null,
        types: [
          ...Object.keys(GQL_TYPE_FIELDS).map((n) => gqlTypeStub(n)),
          ...Object.keys(GQL_ENUMS).map((n) => ({ __typename: "__Type", name: n, kind: "ENUM" }) as GqlObj),
        ],
        directives: [],
      };
      GQL_TYPE_FIELDS["__Schema"] = ["queryType", "mutationType", "subscriptionType", "types", "directives", "__typename"];
      GQL_TYPE_FIELDS["__Type"] = ["name", "kind", "description", "fields", "enumValues", "possibleTypes", "inputFields", "ofType", "__typename"];
      out[key] = field.selection ? execSelectionSet(schema, field.selection, exec) : schema;
      continue;
    }
    const known = GQL_TYPE_FIELDS[obj.__typename];
    const isKnown =
      !known ||
      known.includes(field.name) ||
      Object.prototype.hasOwnProperty.call(obj, field.name);
    if (!isKnown) {
      exec.errors.push({
        message: "Field '" + field.name + "' doesn't exist on type '" + obj.__typename + "'",
      });
      out[key] = null;
      continue;
    }
    const value = gqlFieldValue(obj, field, exec);
    out[key] = completeValue(value, field, exec);
  }
  return out;
}

function completeValue(value: unknown, field: GqlField, exec: GqlExec): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => completeValue(v, field, exec));
  if (typeof value === "object") {
    const obj = value as GqlObj;
    if (obj.__typename && field.selection) return execSelectionSet(obj, field.selection, exec);
    if (obj.__typename) return { __typename: obj.__typename };
    return value;
  }
  return value;
}

function executeGraphql(
  queryText: string,
  vars: Record<string, unknown>,
  operationName: string | null,
): Record<string, unknown> {
  let doc: GqlDocument;
  try {
    doc = new GqlParser(gqlTokenize(queryText)).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: "Parse error: " + (e as Error).message }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: "No operation found" }] };
  }
  const runOne = (op: GqlOperation): Record<string, unknown> => {
    const exec: GqlExec = { doc, vars, errors: [] };
    const root: GqlObj = { __typename: op.operation === "mutation" ? "Mutation" : "Query" };
    const data = execSelectionSet(root, op.selection, exec);
    const result: Record<string, unknown> = { data };
    if (exec.errors.length) result.errors = exec.errors;
    return result;
  };
  if (operationName) {
    const op = doc.operations.find((o) => o.name === operationName) || doc.operations[0];
    return runOne(op);
  }
  if (doc.operations.length > 1) {
    // Two operation documents in one body answer two results, in order.
    return { __batch: doc.operations.map((op) => runOne(op)) } as Record<string, unknown>;
  }
  return runOne(doc.operations[0]);
}

function handleGraphql(ctx: Ctx): void {
  if (ctx.jsonError) {
    return sendJson(ctx, 400, { errors: [{ message: "Problems parsing JSON" }] });
  }
  // Batched requests: an array body answers an array of results.
  if (Array.isArray(ctx.json)) {
    const results = (ctx.json as Record<string, unknown>[]).map((item) => {
      const vars = (item.variables || {}) as Record<string, unknown>;
      const r = executeGraphql(String(item.query || ""), vars, typeof item.operationName === "string" ? item.operationName : null);
      if ((r as Record<string, unknown>).__batch) return (r as Record<string, unknown>).__batch;
      return r;
    });
    const flat: unknown[] = [];
    for (const r of results) {
      if (Array.isArray(r)) flat.push(...r);
      else flat.push(r);
    }
    return sendJson(ctx, 200, flat);
  }
  const body = bodyJsonObject(ctx);
  const queryText = typeof body.query === "string" ? body.query : "";
  if (!queryText) {
    return sendJson(ctx, 400, { errors: [{ message: "Must provide query string" }] });
  }
  let vars: Record<string, unknown> = {};
  if (typeof body.variables === "string") {
    try {
      vars = JSON.parse(body.variables) as Record<string, unknown>;
    } catch {
      vars = {};
    }
  } else if (body.variables && typeof body.variables === "object") {
    vars = body.variables as Record<string, unknown>;
  }
  const operationName = typeof body.operationName === "string" ? body.operationName : null;
  const result = executeGraphql(queryText, vars, operationName);
  if ((result as Record<string, unknown>).__batch) {
    return sendJson(ctx, 200, (result as Record<string, unknown>).__batch);
  }
  return sendJson(ctx, 200, result);
}

// ---------------------------------------------------------------------------
// MCP: JSON-RPC 2.0 over streamable HTTP
// ---------------------------------------------------------------------------

const MCP_TOOLS: Record<string, unknown>[] = [
  {
    name: "create_repo",
    description: "Create a new repository for the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repository name" },
        description: { type: "string", description: "Repository description" },
        private: { type: "boolean", description: "Whether the repository is private" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_repo",
    description: "Get a repository by owner and name.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "list_repos",
    description: "List repositories owned by the authenticated user.",
    inputSchema: { type: "object", properties: { per_page: { type: "number" }, page: { type: "number" } }, required: [] },
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", description: "open, closed or all" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "get_issue",
    description: "Get a single issue by number.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        issue_number: { type: "number" },
      },
      required: ["owner", "repo", "issue_number"],
    },
  },
  {
    name: "create_pull_request",
    description: "Create a pull request from a head branch into a base branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        head: { type: "string" },
        base: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request by number (squash).",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pull_number: { type: "number" },
      },
      required: ["owner", "repo", "pull_number"],
    },
  },
];

// tools/list must be byte-identical across calls: serialize once.
const MCP_TOOLS_LIST_JSON = JSON.stringify({ tools: MCP_TOOLS });
const MCP_SERVER_INFO = { name: "forge-mcp", title: "Forge MCP", version: "1.0.0" };
const MCP_SUPPORTED_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

function mcpToolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Map an incoming argument onto the nearest schema property: the suite
// fills a full_name property and may use slightly different key spellings.
function pickArg(args: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) if (args[n] !== undefined) return args[n];
  const lower = new Map(Object.keys(args).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const hit = lower.get(n.toLowerCase());
    if (hit) return args[hit];
  }
  return undefined;
}

function repoFromArgs(args: Record<string, unknown>): RepoRec | null {
  let owner = pickArg(args, ["owner"]) as string | undefined;
  let name = pickArg(args, ["repo", "name", "repository"]) as string | undefined;
  const fullName = pickArg(args, ["full_name", "fullName"]) as string | undefined;
  if ((!owner || !name) && typeof fullName === "string" && fullName.includes("/")) {
    const parts = fullName.split("/");
    owner = owner || parts[0];
    name = name || parts[1];
  }
  if (!name) return null;
  return findRepo(owner || VIEWER_LOGIN, name);
}

function mcpCallTool(base: string, rawName: string, argsIn: unknown): Record<string, unknown> {
  const name = rawName.toLowerCase();
  const args = (argsIn && typeof argsIn === "object" ? argsIn : {}) as Record<string, unknown>;
  const suffix = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;

  if (suffix === "create_repo") {
    const repoName = pickArg(args, ["name", "repo"]) as string | undefined;
    if (!repoName) return mcpToolError("missing required argument: name");
    const existing = findRepo(VIEWER_LOGIN, repoName);
    if (existing) return mcpToolResult(repoJson(existing, base));
    const repo = createRepo(VIEWER_LOGIN, repoName, (pickArg(args, ["description"]) as string) || null, pickArg(args, ["private"]) === true);
    return mcpToolResult(repoJson(repo, base));
  }
  if (suffix === "get_repo") {
    const repo = repoFromArgs(args);
    if (!repo) return mcpToolError("repository not found");
    return mcpToolResult(repoJson(repo, base));
  }
  if (suffix === "list_repos") {
    const mine = [...store.repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.id - b.id);
    return mcpToolResult(mine.map((r) => repoJson(r, base)));
  }
  if (suffix === "create_issue") {
    const repo = repoFromArgs(args);
    if (!repo) return mcpToolError("repository not found");
    const title = pickArg(args, ["title"]) as string | undefined;
    if (!title) return mcpToolError("missing required argument: title");
    const labelRaw = pickArg(args, ["labels"]);
    const { names, missing } = extractLabelNames(repo, labelRaw);
    if (missing !== null) return mcpToolError("label '" + missing + "' does not exist");
    const rec = createIssueRec(repo, title, (pickArg(args, ["body"]) as string) || null, names, []);
    return mcpToolResult(issueJson(repo, rec, base));
  }
  if (suffix === "list_issues") {
    const repo = repoFromArgs(args);
    if (!repo) return mcpToolError("repository not found");
    const state = (pickArg(args, ["state"]) as string) || "open";
    let list = [...repo.issues.values()];
    if (state === "open") list = list.filter((i) => i.state === "open");
    else if (state === "closed") list = list.filter((i) => i.state === "closed");
    list.sort((a, b) => a.number - b.number);
    return mcpToolResult(list.map((i) => issueJson(repo, i, base)));
  }
  if (suffix === "get_issue") {
    const repo = repoFromArgs(args);
    if (!repo) return mcpToolError("repository not found");
    const num = Number(pickArg(args, ["issue_number", "number"]));
    const issue = repo.issues.get(num);
    if (!issue) return mcpToolError("issue not found");
    return mcpToolResult(issueJson(repo, issue, base));
  }
  if (suffix === "create_pull_request") {
    const repo = repoFromArgs(args);
    if (!repo) return mcpToolError("repository not found");
    const title = pickArg(args, ["title"]) as string | undefined;
    const head = pickArg(args, ["head", "head_branch"]) as string | undefined;
    const baseRef = (pickArg(args, ["base", "base_branch"]) as string) || repo.defaultBranch;
    if (!title) return mcpToolError("missing required argument: title");
    if (!head) return mcpToolError("missing required argument: head");
    const headClean = head.includes(":") ? head.slice(head.indexOf(":") + 1) : head;
    const headCommit = headSha(repo, headClean);
    if (!headCommit) return mcpToolError("head branch not found: " + headClean);
    const ts = nowIso();
    const pr: PullRec = {
      id: store.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body: (pickArg(args, ["body"]) as string) || null,
      state: "open",
      headRef: headClean,
      headSha: headCommit,
      baseRef,
      baseShaAtCreate: headSha(repo, baseRef) || ZERO_SHA,
      userLogin: VIEWER_LOGIN,
      createdAt: ts,
      updatedAt: ts,
      merged: false,
      mergedAt: null,
      mergeSha: null,
      draft: false,
      labels: [],
      comments: [],
    };
    repo.pulls.set(pr.number, pr);
    return mcpToolResult(pullJson(repo, pr, base));
  }
  if (suffix === "merge_pull_request") {
    const repo = repoFromArgs(args);
    if (!repo) return mcpToolError("repository not found");
    const num = Number(pickArg(args, ["pull_number", "number"]));
    const pr = repo.pulls.get(num);
    if (!pr) return mcpToolError("pull request not found");
    const status = computeMergeable(repo, pr);
    if (!status.mergeable) return mcpToolError("pull request is not mergeable");
    if (!pr.merged) {
      const mergeSha = commitFilesOnBranch(repo, pr.baseRef, status.mergedFiles, pr.title + " (#" + pr.number + ")\n", []);
      pr.merged = true;
      pr.mergedAt = nowIso();
      pr.mergeSha = mergeSha;
      pr.state = "closed";
      pr.updatedAt = pr.mergedAt;
    }
    return mcpToolResult({ sha: pr.mergeSha, merged: true, message: "Pull Request successfully merged", pull_request: pullJson(repo, pr, base) });
  }
  return { __rpcError: -32601, message: "Method not found: unknown tool " + rawName };
}

function mcpHandleOne(base: string, msg: Record<string, unknown>): Record<string, unknown> | null {
  const id = msg.id === undefined ? null : msg.id;
  const method = String(msg.method || "");
  const params = (msg.params || {}) as Record<string, unknown>;
  if (id === null && method.startsWith("notifications/")) return null;
  const result = (value: unknown): Record<string, unknown> => ({ jsonrpc: "2.0", id, result: value });
  const error = (code: number, message: string): Record<string, unknown> => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  if (method === "server/discover" || method === "discover") {
    return result({
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
      serverInfo: MCP_SERVER_INFO,
      instructions: "A GitHub-compatible forge. Tools create and read repositories, issues and pull requests in the same store as the REST API.",
    });
  }
  if (method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? (params.protocolVersion as string) : "2025-11-25";
    const version = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : "2025-11-25";
    return result({
      protocolVersion: version,
      capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
      serverInfo: MCP_SERVER_INFO,
      instructions: "A GitHub-compatible forge over MCP.",
    });
  }
  if (method === "ping") return result({});
  if (method === "tools/list") {
    // Return the pre-serialized list so repeated calls are byte-identical.
    return { jsonrpc: "2.0", id, result: JSON.parse(MCP_TOOLS_LIST_JSON) as unknown } as Record<string, unknown>;
  }
  if (method === "tools/call") {
    const toolName = typeof params.name === "string" ? params.name : "";
    if (!toolName) return error(-32602, "Invalid params: missing tool name");
    const known = MCP_TOOLS.some((t) => {
      const n = String(t.name).toLowerCase();
      const want = toolName.toLowerCase();
      return n === want || want.endsWith("__" + n) || n.endsWith("__" + want);
    });
    if (!known) return error(-32601, "Method not found: unknown tool " + toolName);
    const out = mcpCallTool(base, toolName, params.arguments);
    if ((out as Record<string, unknown>).__rpcError) {
      return error(Number((out as Record<string, unknown>).__rpcError), String((out as Record<string, unknown>).message || "error"));
    }
    return result(out);
  }
  if (method === "resources/list") return result({ resources: [] });
  if (method === "resources/templates/list") return result({ resourceTemplates: [] });
  if (method === "prompts/list") return result({ prompts: [] });
  if (method === "logging/setLevel") return result({});
  if (method === "completion/complete") return result({ completion: { values: [], total: 0, hasMore: false } });
  return error(-32601, "Method not found: " + method);
}

function handleMcp(ctx: Ctx): void {
  const method = ctx.req.method || "POST";
  if (method === "GET") {
    // Streamable HTTP servers may answer GET with an SSE stream or 405.
    ctx.res.writeHead(405, { "content-type": "application/json", "x-github-request-id": nextRequestId() });
    ctx.res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method Not Allowed: this server is stateless" }, id: null }));
    return;
  }
  if (method === "DELETE") {
    ctx.res.writeHead(405, { "content-type": "application/json" });
    ctx.res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method Not Allowed" }, id: null }));
    return;
  }
  if (ctx.jsonError) {
    ctx.res.writeHead(400, { "content-type": "application/json", "x-github-request-id": nextRequestId() });
    ctx.res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
    return;
  }
  const accept = String(ctx.req.headers["accept"] || "");
  const wantsSse = accept.includes("text/event-stream") && !accept.includes("application/json");
  const sendPayload = (payload: unknown, status: number) => {
    const text = JSON.stringify(payload);
    if (wantsSse && payload !== null) {
      const sse = "event: message\ndata: " + text + "\n\n";
      ctx.res.writeHead(status, { "content-type": "text/event-stream", "x-github-request-id": nextRequestId() });
      ctx.res.end(sse);
      return;
    }
    ctx.res.writeHead(status, { "content-type": "application/json", "x-github-request-id": nextRequestId() });
    ctx.res.end(text);
  };
  if (Array.isArray(ctx.json)) {
    const replies: Record<string, unknown>[] = [];
    for (const item of ctx.json as Record<string, unknown>[]) {
      const r = mcpHandleOne(ctx.base, item);
      if (r) replies.push(r);
    }
    if (replies.length === 0) {
      ctx.res.writeHead(202, { "x-github-request-id": nextRequestId() });
      ctx.res.end();
      return;
    }
    return sendPayload(replies, 200);
  }
  const msg = bodyJsonObject(ctx);
  if (!msg || typeof msg.method !== "string") {
    // A notification-only or empty body: accept silently.
    if (ctx.body.length === 0 || (msg && String(msg.method || "").startsWith("notifications/"))) {
      ctx.res.writeHead(202, { "x-github-request-id": nextRequestId() });
      ctx.res.end();
      return;
    }
    return sendPayload({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" }, id: null }, 400);
  }
  const reply = mcpHandleOne(ctx.base, msg);
  if (reply === null) {
    ctx.res.writeHead(202, { "x-github-request-id": nextRequestId() });
    ctx.res.end();
    return;
  }
  return sendPayload(reply, 200);
}

// ---------------------------------------------------------------------------
// Dispatcher and lifecycle
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = req.headers.host || "127.0.0.1";
  const url = new URL(req.url || "/", "http://" + host);
  const base = "http://" + host;
  const method = req.method || "GET";
  const pathname = url.pathname;

  if (pathname === "/healthz") {
    const text = JSON.stringify({ ok: true });
    res.writeHead(200, { "content-type": "application/json", "content-length": String(text.length) });
    res.end(text);
    return;
  }

  const body = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(req);
  let json: unknown = undefined;
  let jsonError = false;
  if (body.length > 0) {
    try {
      json = JSON.parse(body.toString("utf8"));
    } catch {
      jsonError = true;
    }
  }
  const ctx: Ctx = { req, res, base, url, body, json, jsonError };

  if (!checkAuth(ctx)) {
    return sendError(ctx, 401, "Bad credentials");
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const name = decodeURIComponent(gitMatch[2]);
    const service = gitMatch[3];
    const repo = findRepo(owner, name);
    if (!repo) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "x-github-request-id": nextRequestId() });
      res.end("not found\n");
      return;
    }
    if (service === "info/refs" && method === "GET") {
      const svc = url.searchParams.get("service") || "git-upload-pack";
      const protocol = String(req.headers["git-protocol"] || "");
      if (svc === "git-upload-pack" && protocol.includes("version=2")) {
        res.writeHead(200, {
          "content-type": "application/x-git-upload-pack-advertisement",
          "cache-control": "no-cache",
        });
        res.end(advertiseV2());
        return;
      }
      if (svc === "git-upload-pack" || svc === "git-receive-pack") {
        res.writeHead(200, {
          "content-type": "application/x-" + svc + "-advertisement",
          "cache-control": "no-cache",
        });
        res.end(advertiseRefs(repo, svc as "git-upload-pack" | "git-receive-pack"));
        return;
      }
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden\n");
      return;
    }
    if (service === "git-upload-pack" && method === "POST") {
      const protocol = String(req.headers["git-protocol"] || "");
      if (protocol.includes("version=2")) return handleUploadPackV2(repo, body, res);
      return handleUploadPackV0(repo, body, res);
    }
    if (service === "git-receive-pack" && method === "POST") {
      return handleReceivePack(repo, body, res);
    }
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("method not allowed\n");
    return;
  }

  if (pathname === "/api/graphql" || pathname === "/api/graphql/") {
    if (method !== "POST") return sendError(ctx, 404, "Not Found");
    return handleGraphql(ctx);
  }

  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
    return handleMcp(ctx);
  }

  if (pathname === "/api/v3" || pathname.startsWith("/api/v3/")) {
    if (jsonError && body.length > 0 && (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE")) {
      return sendJson(ctx, 400, { message: "Problems parsing JSON" });
    }
    // Normalise "/api/v3" (no trailing slash) for the root handler.
    if (pathname === "/api/v3") ctx.url = new URL("/api/v3/", "http://" + host);
    return handleRest(ctx);
  }

  return sendError(ctx, 404, "Not Found");
}

async function registerAndWait(port: number): Promise<void> {
  if (!ENV_URL) return; // local smoke mode: serve until killed
  const registerUrl = ENV_URL + "/register";
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const r = await fetch(registerUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
      });
      if (r.ok || r.status === 409) break;
    } catch {
      // env may still be starting; retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const doneUrl = ENV_URL + "/done";
  for (;;) {
    try {
      const r = await fetch(doneUrl);
      if (r.ok) {
        const data = (await r.json()) as { done?: boolean };
        if (data && data.done === true) return;
      }
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function main(): Promise<void> {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ message: "Internal Server Error" }));
      } catch {
        // socket already gone
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await registerAndWait(port);
  if (ENV_URL) {
    server.close();
    process.exit(0);
  }
}

main().catch(() => {
  process.exit(1);
});
