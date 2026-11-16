// A standalone, GitHub-compatible git forge in one process, standard library only.
//
// Surfaces (all served from one in-memory store, no git binary, no network):
//   git smart HTTP  /{owner}/{repo}.git  (upload-pack v2 + v0, receive-pack v0)
//   REST v3         /api/v3              (repos, branches, commits, contents, issues,
//                                        comments, labels, pull requests, merges)
//   GraphQL v4      /api/graphql         (the documents gh / github-mcp-server send)
//   MCP             /mcp                 (Streamable HTTP, revision 2026-07-28)
//
// Determinism: every id, timestamp and created_at in the store comes from counters
// seeded at fixed epochs, never from the wall clock or Math.random, so two runs over
// the same request sequence leave the same state.
//
// The viewer is the token owner of the trial's fixed scenario (wire.ts buildScenario,
// one constant seed): login "adaiversen". The bearer token itself is opaque
// (shpat_...), so the login is the scenario's, not something decoded from the token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- constants

const VIEWER_LOGIN = 'adaiversen';
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const VIEWER_ID = 1000;
const DEFAULT_BRANCH = 'main';
const ZERO_OID = '0'.repeat(40);
const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
// Fixed epochs: every stored timestamp derives from these plus a counter.
const COMMIT_EPOCH = 1700000000;
const TIME_EPOCH_MS = Date.UTC(2025, 0, 1, 0, 0, 0);

const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';

function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

function isOid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
}

// ---------------------------------------------------------------- git objects

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject { type: ObjType; data: Buffer; }

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([head, data]));
}

interface TreeEntry { mode: string; name: string; oid: string; }

function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.subarray(i, sp).toString('utf8');
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; }

function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

function buildCommit(f: { tree: string; parents: string[]; message: string; author: string; committer: string; timestamp: number }): Buffer {
  const who = (name: string): string => `${name} ${f.timestamp} +0000`;
  let s = `tree ${f.tree}\n`;
  for (const p of f.parents) s += `parent ${p}\n`;
  s += `author ${who(f.author)}\ncommitter ${who(f.committer)}\n\n${f.message.endsWith('\n') ? f.message : `${f.message}\n`}`;
  return Buffer.from(s, 'utf8');
}

interface TagView { object: string; type: string; tag: string; tagger: string; message: string; }

function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '', type = '', tag = '', tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// Reachable objects from roots. depthLimit caps commit generations (undefined = all).
// A tag root includes the tag and its target's closure.
function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  depthLimit?: number,
): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const r of roots) queue.push({ oid: r, depth: 0 });
  const visitTree = (oid: string): void => {
    const obj = lookup(oid);
    if (!obj || obj.type !== 'tree' || out.has(oid)) return;
    out.set(oid, obj);
    for (const e of parseTree(obj.data)) {
      const child = lookup(e.oid);
      if (!child) continue;
      if (child.type === 'tree') visitTree(e.oid);
      else if (!out.has(e.oid)) out.set(e.oid, child);
    }
  };
  const visitCommit = (oid: string, depth: number): void => {
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit' || out.has(oid)) return;
    if (depthLimit !== undefined && depth >= depthLimit) return;
    out.set(oid, obj);
    const c = parseCommit(obj.data);
    visitTree(c.tree);
    if (depthLimit === undefined || depth + 1 < depthLimit) {
      for (const p of c.parents) visitCommit(p, depth + 1);
    }
  };
  while (queue.length > 0) {
    const { oid, depth } = queue.pop()!;
    const obj = lookup(oid);
    if (!obj || out.has(oid)) continue;
    if (obj.type === 'commit') visitCommit(oid, depth);
    else if (obj.type === 'tree') visitTree(oid);
    else if (obj.type === 'tag') {
      out.set(oid, obj);
      const t = parseTag(obj.data);
      const target = lookup(t.object);
      if (target) {
        if (target.type === 'commit') visitCommit(t.object, depth);
        else if (target.type === 'tree') visitTree(t.object);
        else if (!out.has(t.object)) out.set(t.object, target);
      }
    } else out.set(oid, obj);
  }
  return out;
}

function isAncestor(ancestor: string, descendant: string, lookup: (oid: string) => GitObject | undefined): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = lookup(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      stack.push(p);
    }
  }
  return false;
}

// Merge-base: first common ancestor found walking from `a` (breadth-first by depth).
function mergeBase(a: string, b: string, lookup: (oid: string) => GitObject | undefined): string | null {
  const bAnc = new Set<string>();
  const stack = [b];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (bAnc.has(cur)) continue;
    bAnc.add(cur);
    const obj = lookup(cur);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  const queue: Array<{ oid: string; depth: number }> = [{ oid: a, depth: 0 }];
  const seen = new Set<string>();
  let best: string | null = null;
  let bestDepth = Infinity;
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (seen.has(oid) || depth >= bestDepth) continue;
    seen.add(oid);
    if (bAnc.has(oid)) { best = oid; bestDepth = depth; continue; }
    const obj = lookup(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, depth: depth + 1 });
  }
  return best;
}

// ---------------------------------------------------------------- pkt-line

function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface Pkt { kind: 'data' | 'flush' | 'delim'; payload: Buffer; }

function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len < 4 || i + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

// ---------------------------------------------------------------- packs

function packObjectHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let b = (TYPE_CODE[type] << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const o of list) {
    parts.push(packObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

interface PackEntry { type: ObjType; data: Buffer; oid: string; }

function readPack(buf: Buffer, lookup: (oid: string) => GitObject | undefined): PackEntry[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let off = 12;
  const readVarint = (): { size: number; first: number } => {
    let byte = buf[off];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    off += 1;
    while (byte & 0x80) {
      byte = buf[off++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    return { size, first };
  };
  const inflateAt = (at: number): { data: Buffer; next: number } => {
    const r = inflateSync(buf.subarray(at), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    return { data: r.buffer, next: at + r.engine.bytesWritten };
  };
  const applyDelta = (base: Buffer, delta: Buffer): Buffer => {
    let p = 0;
    const readSize = (): number => {
      let v = 0; let s = 0;
      for (;;) {
        const byte = delta[p++];
        v += (byte & 0x7f) * 2 ** s; s += 7;
        if (!(byte & 0x80)) break;
      }
      return v;
    };
    const srcSize = readSize();
    const tgtSize = readSize();
    if (srcSize !== base.length) throw new Error('delta base size mismatch');
    const out = Buffer.alloc(tgtSize);
    let w = 0;
    while (p < delta.length) {
      const op = delta[p++];
      if (op & 0x80) {
        let cpOff = 0; let cpSize = 0; let sh = 0;
        for (let bit = 0; bit < 4; bit++) { if (op & (1 << bit)) cpOff += delta[p++] * 2 ** sh; sh += 8; }
        sh = 0;
        for (let bit = 4; bit < 7; bit++) { if (op & (1 << bit)) cpSize += delta[p++] * 2 ** sh; sh += 8; }
        if (cpSize === 0) cpSize = 0x10000;
        base.copy(out, w, cpOff, cpOff + cpSize);
        w += cpSize;
      } else if (op !== 0) {
        delta.copy(out, w, p, p + op);
        p += op; w += op;
      } else throw new Error('delta opcode 0');
    }
    if (w !== tgtSize) throw new Error('delta size mismatch');
    return out;
  };
  for (let n = 0; n < count; n++) {
    const start = off;
    const { first } = readVarint();
    const typeCode = (first >> 4) & 0x07;
    let type: ObjType;
    let data: Buffer;
    if (typeCode === 6) {
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const inf = inflateAt(off);
      off = inf.next;
      const base = entries.find((e) => e.oid === baseOid)?.data ?? lookup(baseOid)?.data;
      if (!base) throw new Error('ref-delta base missing');
      data = applyDelta(base, inf.data);
      type = (entries.find((e) => e.oid === baseOid) ?? lookup(baseOid)!).type;
    } else if (typeCode === 7) {
      let byte = buf[off];
      off += 1;
      let baseOff = byte & 0x7f;
      while (byte & 0x80) { byte = buf[off++]; baseOff = ((baseOff + 1) * 128) + (byte & 0x7f); }
      const baseEntry = byOffset.get(start - baseOff);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const inf = inflateAt(off);
      off = inf.next;
      data = applyDelta(baseEntry.data, inf.data);
      type = baseEntry.type;
    } else {
      type = CODE_TYPE[typeCode];
      if (!type) throw new Error(`bad pack object type ${typeCode}`);
      const inf = inflateAt(off);
      off = inf.next;
      data = inf.data;
    }
    const oid = hashObject(type, data);
    const entry: PackEntry = { type, data, oid };
    entries.push(entry);
    byOffset.set(start, entry);
  }
  return entries;
}

// ---------------------------------------------------------------- store

interface Label { name: string; color: string; description: string; }
interface Comment { id: number; nodeId: string; body: string; user: string; createdSeq: number; }
interface Issue {
  id: number; nodeId: string; number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: Label[]; comments: Comment[]; createdSeq: number; closedAt: string | null;
}
interface PullFile { filename: string; status: string; additions: number; deletions: number; changes: number; }
interface Pull {
  id: number; nodeId: string; number: number; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  files: PullFile[]; createdSeq: number;
}
interface Repo {
  id: number; nodeId: string; name: string; owner: string; description: string; private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[]; issuesByNumber: Map<number, Issue>;
  pulls: Pull[]; pullsByNumber: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number; // shared issue+PR numbering, GitHub-style
  createdSeq: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextObjectId = 1; // numeric ids for issues/PRs/comments (stable, per-process counters)
let nextSeq = 1;      // creation ordering
let nextCommitSeq = 1;
let nextReqId = 1;

function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function gid(kind: string, id: string | number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}
function isoFromSeq(seq: number): string {
  return new Date(TIME_EPOCH_MS + seq * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function viewerUser(): { login: string; id: number; type: string; name: string; email: string } {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL };
}

function createRepoRecord(name: string, description: string, isPrivate: boolean): Repo {
  const id = nextRepoId++;
  const repo: Repo = {
    id, nodeId: gid('repo', id), name, owner: VIEWER_LOGIN,
    description: description ?? '', private: isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    objects: new Map(), refs: new Map(),
    issues: [], issuesByNumber: new Map(),
    pulls: [], pullsByNumber: new Map(),
    labels: new Map(), nextNumber: 1, createdSeq: nextSeq++,
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return repos.get(repoKey(owner, name));
}

function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function lookupIn(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid) => repo.objects.get(oid);
}

// Build a tree object from a path -> blob-oid map (nested dirs), reusing existing trees.
function treeOidForFiles(repo: Repo, files: Map<string, string>): string {
  interface Node { files: Map<string, string>; dirs: Map<string, Node>; }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], make());
      node = node.dirs.get(segs[i])!;
    }
    node.files.set(segs[segs.length - 1], oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of [...node.files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      entries.push({ mode: '100644', name, oid });
    }
    for (const [name, child] of [...node.dirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

// Flatten a tree object into path -> {oid, mode} (recursive).
function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}

function commitAt(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

function makeCommit(repo: Repo, files: Map<string, string>, parents: string[], message: string): string {
  const tree = treeOidForFiles(repo, files);
  const ts = COMMIT_EPOCH + nextCommitSeq++;
  const author = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const data = buildCommit({ tree, parents, message, author, committer: author, timestamp: ts });
  return storeObject(repo, 'commit', data);
}

// Commit history reachable from a tip, newest-first (depth-first, parents in order).
function listCommits(repo: Repo, tip: string, limit = 100): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    out.push({ sha: oid, message: c.message.replace(/\n$/, '') });
    for (const p of c.parents) stack.push(p);
  }
  return out;
}

// Diff two trees: list of changed paths with line counts (new vs old blob text).
function diffTrees(repo: Repo, baseTree: string | null, headTree: string): PullFile[] {
  const base = baseTree ? flattenTree(repo, baseTree) : new Map<string, { oid: string; mode: string }>();
  const head = flattenTree(repo, headTree);
  const files: PullFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && h && b.oid === h.oid) continue;
    const oldText = b ? (repo.objects.get(b.oid)?.data.toString('utf8') ?? '') : '';
    const newText = h ? (repo.objects.get(h.oid)?.data.toString('utf8') ?? '') : '';
    const countLines = (s: string): number => (s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0));
    let additions = 0; let deletions = 0;
    if (!b) { additions = countLines(newText); }
    else if (!h) { deletions = countLines(oldText); }
    else {
      const oldLines = new Set(oldText.split('\n'));
      const newLines = newText.split('\n');
      for (const line of newLines) if (!oldLines.has(line)) additions++;
      const newSet = new Set(newLines);
      for (const line of oldText.split('\n')) if (!newSet.has(line)) deletions++;
      if (additions === 0 && deletions === 0) { additions = 1; }
    }
    const status = !b ? 'added' : !h ? 'removed' : 'modified';
    files.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return files;
}

function prConflict(repo: Repo, pr: Pull): boolean {
  // The base is the CURRENT tip of the base branch, not the tip recorded when
  // the PR was opened: another PR may have merged onto it since.
  const currentBase = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  const base = mergeBase(pr.headSha, currentBase, lookupIn(repo));
  if (base === null) return false;
  const baseObj = repo.objects.get(currentBase);
  const headObj = repo.objects.get(pr.headSha);
  const baseTree = baseObj?.type === 'commit' ? parseCommit(baseObj.data).tree : null;
  const headTree = headObj?.type === 'commit' ? parseCommit(headObj.data).tree : null;
  const mbObj = repo.objects.get(base);
  const mbTree = mbObj?.type === 'commit' ? parseCommit(mbObj.data).tree : null;
  if (headTree === null || baseTree === null || mbTree === null) return false;
  const mb = flattenTree(repo, mbTree);
  const bt = flattenTree(repo, baseTree);
  const ht = flattenTree(repo, headTree);
  for (const [path, h] of ht) {
    const m = mb.get(path);
    const b = bt.get(path);
    if (m && b && m.oid !== b.oid && h.oid !== b.oid) return true; // changed on both sides, differently
    if (!m && b && h.oid !== b.oid) return true; // added on head, changed on base
  }
  for (const [path, m] of mb) {
    const b = bt.get(path);
    const h = ht.get(path);
    if (b && b.oid !== m.oid && !h) return true; // deleted on head, changed on base
    if (!b && h && h.oid !== m.oid) return true;
  }
  return false;
}

function mergeableState(repo: Repo, pr: Pull): string {
  if (pr.merged) return 'UNKNOWN';
  return prConflict(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
}

// Squash-merge a PR onto its base branch. Returns the squash commit oid, or null on conflict.
function squashMerge(repo: Repo, pr: Pull): string | null {
  if (pr.merged) return pr.mergeCommitSha;
  if (prConflict(repo, pr)) return null;
  const headObj = repo.objects.get(pr.headSha);
  if (!headObj || headObj.type !== 'commit') return null;
  const headTree = parseCommit(headObj.data).tree;
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!baseTip) return null;
  const ts = COMMIT_EPOCH + nextCommitSeq++;
  const author = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const message = `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}\n`;
  const data = buildCommit({ tree: headTree, parents: [baseTip], message, author, committer: author, timestamp: ts });
  const sha = storeObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
  pr.merged = true;
  pr.state = 'closed';
  pr.mergedAt = isoFromSeq(nextSeq);
  pr.mergeCommitSha = sha;
  return sha;
}

// ---------------------------------------------------------------- JSON views

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, node_id: repo.nodeId, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private, description: repo.description, default_branch: repo.defaultBranch,
    created_at: isoFromSeq(repo.createdSeq), updated_at: isoFromSeq(repo.createdSeq),
    pushed_at: isoFromSeq(repo.createdSeq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    homepage: '', language: null, forks_count: 0, stargazers_count: 0, watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    has_issues: true, has_projects: true, has_wiki: true, has_pages: false,
    archived: false, disabled: false, visibility: repo.private ? 'private' : 'public',
    topics: [], license: null, allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true,
  };
}

function labelJson(l: Label): Record<string, unknown> {
  return { name: l.name, color: l.color, description: l.description, default: false };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, node_id: issue.nodeId, number: issue.number, title: issue.title, body: issue.body,
    state: issue.state, labels: issue.labels.map(labelJson),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignees: [], milestone: null, locked: false,
    comments: issue.comments.length,
    created_at: isoFromSeq(issue.createdSeq), updated_at: isoFromSeq(issue.createdSeq),
    closed_at: issue.closedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullJson(repo: Repo, pr: Pull): Record<string, unknown> {
  const headUser = { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' };
  return {
    id: pr.id, node_id: pr.nodeId, number: pr.number, title: pr.title, body: pr.body,
    state: pr.state, merged: pr.merged, merged_at: pr.mergedAt, merge_commit_sha: pr.mergeCommitSha,
    mergeable: mergeableState(repo, pr) === 'MERGEABLE',
    head: { ref: pr.headRef, sha: pr.headSha, label: `${VIEWER_LOGIN}:${pr.headRef}`, user: headUser },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${VIEWER_LOGIN}:${pr.baseRef}`, user: headUser },
    user: headUser,
    created_at: isoFromSeq(pr.createdSeq), updated_at: isoFromSeq(pr.createdSeq),
    closed_at: pr.state === 'closed' ? pr.mergedAt : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

// ---------------------------------------------------------------- http plumbing

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function reqId(): string {
  return `req-${(nextReqId++).toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': reqId(),
    ...extra,
  });
  res.end(text);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': reqId() });
  res.end();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const v = JSON.parse(raw.toString('utf8')) as unknown;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown> };
    return { ok: true, value: {} };
  } catch {
    return { ok: false };
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7);
}

function authed(req: IncomingMessage): boolean {
  const tok = bearerToken(req);
  if (tok === null || tok === '') return false;
  if (EXPECTED_TOKEN !== '' && tok !== EXPECTED_TOKEN) return false;
  return true;
}

function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const u = new URL(req.url ?? '/', 'http://entry');
    return { pathname: u.pathname, query: u.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((s) => s !== '').map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}

function linkHeader(req: IncomingMessage, basePath: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page >= lastPage) return null;
  const host = req.headers.host ?? 'localhost';
  const proto = 'http';
  const mk = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${proto}://${host}${basePath}?${q.toString()}>`;
  };
  const parts = [`${mk(page + 1)}; rel="next"`, `${mk(lastPage)}; rel="last"`];
  if (page > 1) parts.push(`${mk(1)}; rel="first"`, `${mk(page - 1)}; rel="prev"`);
  return parts.join(', ');
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

// ---------------------------------------------------------------- REST v3

async function handleRest(req: IncomingMessage, res: ServerResponse, segs: string[], query: URLSearchParams): Promise<boolean> {
  // segs already has the 'api/v3' prefix stripped by createApp.
  const rest = segs;
  const method = req.method ?? 'GET';

  if (!authed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }

  // Bodies for methods that carry one.
  let body: Record<string, unknown> = {};
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return true;
    }
    body = parsed.value;
  }

  const notFound = (msg = 'Not Found'): void => sendJson(res, 404, { message: msg });
  const needRepo = (owner: string, name: string): Repo | null => {
    const repo = getRepo(owner, name);
    if (!repo) { notFound(); return null; }
    return repo;
  };
  const branchTip = (repo: Repo, branch: string): string | undefined => repo.refs.get(`refs/heads/${branch}`);
  const resolveRef = (repo: Repo, ref: string): string | undefined => {
    if (ref === '') return branchTip(repo, repo.defaultBranch);
    const byBranch = branchTip(repo, ref);
    if (byBranch) return byBranch;
    if (isOid(ref) && repo.objects.get(ref)?.type === 'commit') return ref;
    return undefined;
  };

  // GET /api/v3/  (root)
  if (rest.length === 0) {
    if (method !== 'GET') { notFound(); return true; }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') { notFound(); return true; }
    sendJson(res, 200, { ...viewerUser(), html_url: 'https://example.invalid/adaiversen', url: '/api/v3/user', type: 'User', site_admin: false });
    return true;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') { notFound(); return true; }
    sendJson(res, 200, { installed_version: SERVER_VERSION, verifiable_password_authentication: false, github_services_sha: '0000000000000000000000000000000000000000' });
    return true;
  }

  // GET /api/v3/rate_limit
  if (rest.length === 1 && rest[0] === 'rate_limit') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 1800000000, used: 1 }, search: { limit: 30, remaining: 30, reset: 1800000000, used: 0 } }, rate: { limit: 5000, remaining: 4999, reset: 1800000000, used: 1 } });
    return true;
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = pageParams(query);
      const all = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.createdSeq - b.createdSeq);
      const link = linkHeader(req, '/api/v3/user/repos', query, page, perPage, all.length);
      sendJson(res, 200, paginate(all, page, perPage).map(repoJson), link ? { link } : {});
      return true;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        sendJson(res, 422, { message: 'Invalid repository name' });
        return true;
      }
      if (repos.has(repoKey(VIEWER_LOGIN, name))) {
        sendJson(res, 422, { message: 'Repository already exists', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
        return true;
      }
      const repo = createRepoRecord(name, typeof body.description === 'string' ? body.description : '', body.private === true);
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    notFound();
    return true;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1];
    const name = rest[2];
    const repo = needRepo(owner, name);
    if (!repo) return true;
    const tail = rest.slice(3);

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) repo.defaultBranch = body.default_branch;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        sendNoContent(res);
        return true;
      }
      notFound();
      return true;
    }

    // branches
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort()
          .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r)! }, protected: false }));
        sendJson(res, 200, list);
        return true;
      }
      if (tail.length === 2 && method === 'GET') {
        const tip = branchTip(repo, tail[1]);
        if (!tip) { notFound('Branch not found'); return true; }
        sendJson(res, 200, { name: tail[1], commit: { sha: tip, url: `/api/v3/repos/${owner}/${name}/commits/${tip}` }, protected: false });
        return true;
      }
      notFound();
      return true;
    }

    // git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha) || repo.objects.get(sha)?.type !== 'commit') {
          sendJson(res, 422, { message: 'Invalid ref or sha' });
          return true;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: 'Reference already exists' });
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` } });
        return true;
      }
      if (method === 'GET') {
        if (tail.length === 2) {
          const all = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
            .map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
          sendJson(res, 200, all);
          return true;
        }
        const ref = tail.slice(2).join('/');
        const sha = repo.refs.get(ref);
        if (!sha) { notFound('Reference not found'); return true; }
        sendJson(res, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
        return true;
      }
      notFound();
      return true;
    }

    // commits
    if (tail[0] === 'commits') {
      if (tail.length === 1 && method === 'GET') {
        const shaParam = query.get('sha') ?? '';
        const tip = resolveRef(repo, shaParam);
        if (!tip) { sendJson(res, 200, []); return true; }
        const { page, perPage } = pageParams(query);
        const list = listCommits(repo, tip, 1000).map((c) => {
          const obj = repo.objects.get(c.sha)!;
          const cv = parseCommit(obj.data);
          return {
            sha: c.sha, commit: { message: cv.message.replace(/\n+$/, ''), author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoFromSeq(1) }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoFromSeq(1) }, tree: { sha: cv.tree } },
            author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            parents: cv.parents.map((p) => ({ sha: p })),
            url: `/api/v3/repos/${owner}/${name}/commits/${c.sha}`,
          };
        });
        sendJson(res, 200, paginate(list, page, perPage));
        return true;
      }
      if (tail.length === 2 && method === 'GET') {
        const obj = repo.objects.get(tail[1]);
        if (!obj || obj.type !== 'commit') { notFound('Commit not found'); return true; }
        const cv = parseCommit(obj.data);
        sendJson(res, 200, {
          sha: tail[1], commit: { message: cv.message.replace(/\n+$/, ''), author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoFromSeq(1) }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoFromSeq(1) }, tree: { sha: cv.tree } },
          author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
          parents: cv.parents.map((p) => ({ sha: p })),
        });
        return true;
      }
      notFound();
      return true;
    }

    // contents
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      const refParam = query.get('ref') ?? '';
      if (method === 'GET') {
        const tip = resolveRef(repo, refParam);
        if (!tip) { notFound(); return true; }
        const commitObj = repo.objects.get(tip)!;
        const rootTree = parseCommit(commitObj.data).tree;
        const flat = flattenTree(repo, rootTree);
        if (filePath === '') {
          const entries = dirEntries(repo, rootTree, '');
          sendJson(res, 200, entries);
          return true;
        }
        const file = flat.get(filePath);
        if (file) {
          const blob = repo.objects.get(file.oid)!;
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: blob.data.length, name: filePath.split('/').pop(),
            path: filePath, content: blob.data.toString('base64'), sha: file.oid,
            url: `/api/v3/repos/${owner}/${name}/contents/${filePath}`,
            html_url: `https://example.invalid/${owner}/${name}/blob/${repo.defaultBranch}/${filePath}`,
          });
          return true;
        }
        // directory?
        const dirOid = subtreeOid(repo, rootTree, filePath);
        if (dirOid) {
          sendJson(res, 200, dirEntries(repo, dirOid, filePath));
          return true;
        }
        notFound();
        return true;
      }
      if (method === 'PUT') {
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const refName = `refs/heads/${branch}`;
        const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${filePath}`;
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        let content: Buffer;
        try { content = Buffer.from(contentB64, 'base64'); } catch { sendJson(res, 422, { message: 'Invalid base64 content' }); return true; }
        let tip = repo.refs.get(refName);
        let baseFiles = new Map<string, string>();
        let parents: string[] = [];
        if (tip) {
          const c = repo.objects.get(tip);
          if (c?.type === 'commit') {
            baseFiles = new Map([...flattenTree(repo, parseCommit(c.data).tree)].map(([p, e]) => [p, e.oid] as [string, string]));
            parents = [tip];
          }
        } else if (repo.refs.size > 0) {
          // Implicit branch from the default branch tip (GitHub contents behaviour).
          const defTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (defTip) {
            const c = repo.objects.get(defTip);
            if (c?.type === 'commit') {
              baseFiles = new Map([...flattenTree(repo, parseCommit(c.data).tree)].map(([p, e]) => [p, e.oid] as [string, string]));
              parents = [defTip];
            }
          }
        }
        const existing = baseFiles.get(filePath);
        const suppliedSha = typeof body.sha === 'string' ? body.sha : undefined;
        if (existing) {
          if (suppliedSha === undefined) { sendJson(res, 422, { message: 'sha must be supplied when updating a file' }); return true; }
          if (suppliedSha !== existing) { sendJson(res, 409, { message: 'The file has changed since you last read it' }); return true; }
        }
        const blobOid = storeObject(repo, 'blob', content);
        const files = new Map<string, string>(baseFiles);
        files.set(filePath, blobOid);
        const commitSha = makeCommit(repo, files, parents, message);
        repo.refs.set(refName, commitSha);
        sendJson(res, existing ? 200 : 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitSha, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        if (!tip) { notFound(); return true; }
        const c = repo.objects.get(tip);
        if (!c || c.type !== 'commit') { notFound(); return true; }
        const baseFiles = new Map([...flattenTree(repo, parseCommit(c.data).tree)].map(([p, e]) => [p, e.oid] as [string, string]));
        const existing = baseFiles.get(filePath);
        if (!existing) { notFound(); return true; }
        const suppliedSha = typeof body.sha === 'string' ? body.sha : undefined;
        if (suppliedSha !== undefined && suppliedSha !== existing) { sendJson(res, 409, { message: 'The file has changed since you last read it' }); return true; }
        const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${filePath}`;
        baseFiles.delete(filePath);
        const commitSha = makeCommit(repo, baseFiles, [tip], message);
        repo.refs.set(refName, commitSha);
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return true;
      }
      notFound();
      return true;
    }

    // labels
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map(labelJson));
        return true;
      }
      if (method === 'POST' && tail.length === 1) {
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') { sendJson(res, 422, { message: 'Label name is required' }); return true; }
        let label = repo.labels.get(name);
        if (!label) {
          label = { name, color: typeof body.color === 'string' ? body.color : 'ededed', description: typeof body.description === 'string' ? body.description : '' };
          repo.labels.set(name, label);
        }
        sendJson(res, 201, labelJson(label));
        return true;
      }
      notFound();
      return true;
    }

    // issues
    if (tail[0] === 'issues') {
      // comments
      if (tail.length === 3 && tail[2] === 'comments') {
        const n = Number(tail[1]);
        const issue = repo.issuesByNumber.get(n);
        if (!issue) { notFound('Issue not found'); return true; }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({
            id: c.id, node_id: c.nodeId, body: c.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            created_at: isoFromSeq(c.createdSeq), updated_at: isoFromSeq(c.createdSeq),
            html_url: `https://example.invalid/${owner}/${name}/issues/${n}#issuecomment-${c.id}`,
            url: `/api/v3/repos/${owner}/${name}/issues/comments/${c.id}`,
          })));
          return true;
        }
        if (method === 'POST') {
          const text = typeof body.body === 'string' ? body.body : '';
          const comment: Comment = { id: nextObjectId++, nodeId: gid('comment', nextObjectId), body: text, user: VIEWER_LOGIN, createdSeq: nextSeq++ };
          comment.nodeId = gid('comment', comment.id);
          issue.comments.push(comment);
          sendJson(res, 201, {
            id: comment.id, node_id: comment.nodeId, body: comment.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            created_at: isoFromSeq(comment.createdSeq), updated_at: isoFromSeq(comment.createdSeq),
          });
          return true;
        }
        notFound();
        return true;
      }
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = (query.get('state') ?? 'open').toLowerCase();
          const sort = (query.get('sort') ?? 'created').toLowerCase();
          const direction = (query.get('direction') ?? 'desc').toLowerCase();
          let list = [...repo.issues];
          if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
          if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          const { page, perPage } = pageParams(query);
          sendJson(res, 200, paginate(list, page, perPage).map((i) => issueJson(repo, i)));
          return true;
        }
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          const text = typeof body.body === 'string' ? body.body : '';
          const rawLabels = Array.isArray(body.labels) ? body.labels : [];
          const labels: Label[] = [];
          for (const raw of rawLabels) {
            const lname = typeof raw === 'string' ? raw : (raw as Record<string, unknown>)?.name;
            if (typeof lname !== 'string') continue;
            const label = repo.labels.get(lname);
            if (!label) { sendJson(res, 422, { message: `Label does not exist: ${lname}` }); return true; }
            labels.push(label);
          }
          const number = repo.nextNumber++;
          const id = nextObjectId++;
          const issue: Issue = {
            id, nodeId: gid('issue', id), number, title, body: text, state: 'open',
            labels, comments: [], createdSeq: nextSeq++, closedAt: null,
          };
          repo.issues.push(issue);
          repo.issuesByNumber.set(number, issue);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        notFound();
        return true;
      }
      if (tail.length === 2) {
        const n = Number(tail[1]);
        const issue = repo.issuesByNumber.get(n);
        if (!issue) { notFound('Issue not found'); return true; }
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return true; }
        if (method === 'PATCH') {
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') {
            issue.state = body.state;
            issue.closedAt = body.state === 'closed' ? isoFromSeq(nextSeq) : null;
          }
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        notFound();
        return true;
      }
      notFound();
      return true;
    }

    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = (query.get('state') ?? 'open').toLowerCase();
          let list = [...repo.pulls];
          if (state === 'open' || state === 'closed') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.createdSeq - a.createdSeq);
          const { page, perPage } = pageParams(query);
          sendJson(res, 200, paginate(list, page, perPage).map((p) => pullJson(repo, p)));
          return true;
        }
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          const text = typeof body.body === 'string' ? body.body : '';
          const headRaw = typeof body.head === 'string' ? body.head : '';
          const baseRaw = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
          const base = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
          const headSha = branchTip(repo, head);
          const baseSha = branchTip(repo, base);
          if (!headSha || !baseSha) { sendJson(res, 422, { message: 'Head or base branch does not exist' }); return true; }
          const openDup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head);
          if (openDup) { sendJson(res, 422, { message: 'A pull request already exists for this head branch' }); return true; }
          const headTree = parseCommit(repo.objects.get(headSha)!.data).tree;
          const baseTree = parseCommit(repo.objects.get(baseSha)!.data).tree;
          const number = repo.nextNumber++;
          const id = nextObjectId++;
          const pr: Pull = {
            id, nodeId: gid('pr', id), number, title, body: text, state: 'open', merged: false,
            mergedAt: null, mergeCommitSha: null, headRef: head, baseRef: base,
            headSha, baseSha, files: diffTrees(repo, baseTree, headTree), createdSeq: nextSeq++,
          };
          repo.pulls.push(pr);
          repo.pullsByNumber.set(number, pr);
          sendJson(res, 201, pullJson(repo, pr));
          return true;
        }
        notFound();
        return true;
      }
      if (tail.length === 2) {
        const n = Number(tail[1]);
        const pr = repo.pullsByNumber.get(n);
        if (!pr) { notFound('Pull request not found'); return true; }
        if (method === 'GET') { sendJson(res, 200, pullJson(repo, pr)); return true; }
        notFound();
        return true;
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        const n = Number(tail[1]);
        const pr = repo.pullsByNumber.get(n);
        if (!pr) { notFound('Pull request not found'); return true; }
        sendJson(res, 200, pr.files.map((f) => ({
          filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes,
          patch: '',
        })));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        const n = Number(tail[1]);
        const pr = repo.pullsByNumber.get(n);
        if (!pr) { notFound('Pull request not found'); return true; }
        if (pr.merged) { sendJson(res, 405, { message: 'Pull request has already been merged' }); return true; }
        const sha = squashMerge(repo, pr);
        if (sha === null) { sendJson(res, 405, { message: 'Merge conflict: the pull request cannot be merged cleanly' }); return true; }
        sendJson(res, 200, { sha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
      notFound();
      return true;
    }

    notFound();
    return true;
  }

  return false;
}

// Directory listing entries for a tree object at a path prefix.
function dirEntries(repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data).map((e) => {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    const child = repo.objects.get(e.oid);
    const size = child?.type === 'blob' ? child.data.length : 0;
    return {
      type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path, sha: e.oid, size,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    };
  });
}

// The tree oid of a directory path inside a root tree, or null.
function subtreeOid(repo: Repo, rootTree: string, dirPath: string): string | null {
  let cur = rootTree;
  for (const seg of dirPath.split('/')) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    const e = parseTree(obj.data).find((x) => x.name === seg && x.mode === '40000');
    if (!e) return null;
    cur = e.oid;
  }
  return cur;
}

// ---------------------------------------------------------------- git smart HTTP

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function peelTag(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const t = parseTag(obj.data);
  const target = repo.objects.get(t.object);
  if (!target) return null;
  if (target.type === 'commit') return t.object;
  if (target.type === 'tag') return peelTag(repo, t.object);
  return null;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? 'multi_ack multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=forge/1.0.0'
    : 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=forge/1.0.0';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const mainTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const line = (text: string): void => {
      if (first) { parts.push(pktLine(`${text}\0${caps}\n`)); first = false; }
      else parts.push(pktLine(`${text}\n`));
    };
    if (mainTip) line(`${mainTip} HEAD`);
    for (const [name, oid] of refs) {
      line(`${oid} ${name}`);
      const peeled = peelTag(repo, oid);
      if (peeled) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine('agent=forge/1.0.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

// Objects the server may send for a fetch: closure of wants (depth-limited),
// minus what the client already holds (haves; shallow boundaries count as held
// only for themselves and their trees, not their ancestors).
function fetchObjects(repo: Repo, wants: string[], haves: string[], shallow: string[], depth?: number): Map<string, GitObject> {
  const lookup = lookupIn(repo);
  const wantSet = new Map<string, GitObject>();
  for (const w of wants) {
    for (const [oid, obj] of collectReachable([w], lookup, depth)) wantSet.set(oid, obj);
  }
  const shallowSet = new Set(shallow);
  const haveSet = new Map<string, GitObject>();
  for (const h of haves) {
    const limit = shallowSet.has(h) ? 1 : undefined;
    for (const [oid, obj] of collectReachable([h], lookup, limit)) haveSet.set(oid, obj);
  }
  for (const oid of haveSet.keys()) wantSet.delete(oid);
  return wantSet;
}

// New shallow boundaries of a depth-limited fetch, and old boundaries that
// are no longer shallow because their parents are now included.
function shallowInfo(repo: Repo, wants: string[], oldShallow: string[], depth: number | undefined, sent: Map<string, GitObject>): { shallow: string[]; unshallow: string[] } {
  const lookup = lookupIn(repo);
  const shallow: string[] = [];
  if (depth !== undefined) {
    // Commits at exactly depthLimit-1 from a want, with a parent beyond the cut.
    const seen = new Set<string>();
    const queue: Array<{ oid: string; d: number }> = wants.map((w) => ({ oid: w, d: 0 }));
    while (queue.length > 0) {
      const { oid, d } = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = lookup(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (d === depth - 1) {
        if (parents.length > 0 && sent.has(oid)) shallow.push(oid);
      } else if (d < depth - 1) {
        for (const p of parents) queue.push({ oid: p, d: d + 1 });
      }
    }
  }
  const unshallow: string[] = [];
  for (const b of oldShallow) {
    const obj = lookup(b);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && sent.has(b) && parents.every((p) => sent.has(p))) unshallow.push(b);
  }
  return { shallow: [...new Set(shallow)], unshallow: [...new Set(unshallow)] };
}

function handleLsRefs(repo: Repo, packets: Pkt[]): Buffer {
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const out: Buffer[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (repo.refs.size === 0) {
    if (unborn && keep('HEAD')) out.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
  } else {
    if (mainTip && keep('HEAD')) {
      out.push(pktLine(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
    for (const [name, oid] of sortedRefs(repo)) {
      if (!keep(name)) continue;
      let line = `${oid} ${name}`;
      if (peel) {
        const peeled = peelTag(repo, oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
      out.push(pktLine(`${line}\n`));
    }
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

function handleFetchV2(repo: Repo, packets: Pkt[]): Buffer {
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) { const n = Number(line.slice(7)); if (Number.isFinite(n)) depth = n; }
  }
  const lookup = lookupIn(repo);
  let common: string | null = null;
  for (const h of haves) {
    if (wants.some((w) => isAncestor(h, w, lookup))) { common = h; break; }
  }
  const sent = fetchObjects(repo, wants, haves, shallow, depth);
  const pack = writePack(sent.values());
  const out: Buffer[] = [];
  out.push(pktLine('acknowledgments\n'));
  out.push(pktLine(common ? `ACK ${common}\n` : 'NAK\n'));
  out.push(PKT_DELIM);
  if (depth !== undefined || shallow.length > 0) {
    const info = shallowInfo(repo, wants, shallow, depth, sent);
    out.push(pktLine('shallow-info\n'));
    for (const s of info.shallow) out.push(pktLine(`shallow ${s}\n`));
    for (const s of info.unshallow) out.push(pktLine(`unshallow ${s}\n`));
    out.push(PKT_DELIM);
  }
  out.push(pktLine('packfile\n'));
  out.push(...sidebandPackets(pack));
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

function handleFetchV0(repo: Repo, packets: Pkt[]): Buffer {
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const first = line.slice(5).split(' ')[0];
      if (isOid(first)) wants.push(first);
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) { const n = Number(line.slice(7)); if (Number.isFinite(n)) depth = n; }
  }
  const lookup = lookupIn(repo);
  let common: string | null = null;
  for (const h of haves) {
    if (wants.some((w) => isAncestor(h, w, lookup))) { common = h; break; }
  }
  const sent = fetchObjects(repo, wants, haves, shallow, depth);
  const pack = writePack(sent.values());
  const out: Buffer[] = [];
  out.push(pktLine(common ? `ACK ${common}\n` : 'NAK\n'));
  if (depth !== undefined || shallow.length > 0) {
    const info = shallowInfo(repo, wants, shallow, depth, sent);
    for (const s of info.shallow) out.push(pktLine(`shallow ${s}\n`));
    for (const s of info.unshallow) out.push(pktLine(`unshallow ${s}\n`));
  }
  out.push(...sidebandPackets(pack));
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  // Commands are pkt-lines up to the first flush; the pack follows it raw.
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let packStart = body.length;
  let i = 0;
  while (i + 4 <= body.length) {
    const len = parseInt(body.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0 || (len !== 0 && len !== 1 && len < 4)) throw new Error('malformed pkt-line');
    if (len === 0) { packStart = i + 4; break; }
    if (len === 1) { i += 4; continue; }
    if (i + len > body.length) throw new Error('truncated pkt-line');
    let text = body.subarray(i + 4, i + len).toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const line = text.replace(/\n$/, '');
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!m) throw new Error(`bad receive-pack command: ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    i += len;
  }
  const packBytes = body.subarray(packStart);
  const report: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  if (hasUpdates && packBytes.length > 0) {
    try {
      const entries = readPack(packBytes, lookupIn(repo));
      for (const e of entries) {
        if (!repo.objects.has(e.oid)) repo.objects.set(e.oid, { type: e.type, data: e.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  } else if (hasUpdates && packBytes.length === 0) {
    unpackOk = false;
    unpackDetail = 'unpacker error: no packfile';
  }
  const lookup = lookupIn(repo);
  for (const cmd of commands) {
    if (!unpackOk) { report.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' }); continue; }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (current === undefined) { report.push({ ref: cmd.ref, ok: false, reason: 'no such ref' }); continue; }
      if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) { report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
      repo.refs.delete(cmd.ref);
      report.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) { report.push({ ref: cmd.ref, ok: false, reason: 'missing object' }); continue; }
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) { report.push({ ref: cmd.ref, ok: false, reason: 'already exists' }); continue; }
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (current === undefined) { report.push({ ref: cmd.ref, ok: false, reason: 'no such ref' }); continue; }
    if (cmd.oldOid !== current) { report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
    if (cmd.newOid === current) { report.push({ ref: cmd.ref, ok: true, reason: '' }); continue; }
    if (!isAncestor(current, cmd.newOid, lookup)) { report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
    repo.refs.set(cmd.ref, cmd.newOid);
    report.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  const lines: Buffer[] = [];
  lines.push(pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`));
  for (const r of report) {
    lines.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  }
  const reportBytes = Buffer.concat(lines);
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let i = 0; i < reportBytes.length; i += CHUNK) {
    const slice = reportBytes.subarray(i, Math.min(reportBytes.length, i + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, segs: string[], query: URLSearchParams): Promise<boolean> {
  if (segs.length < 2 || !segs[1].endsWith('.git')) return false;
  const owner = segs[0];
  const name = segs[1].slice(0, -4);
  const method = req.method ?? 'GET';
  const repo = getRepo(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const tail = segs.slice(2);
  try {
    if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
      const service = query.get('service') ?? '';
      if (service === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        sendRaw(res, 200, UPLOAD_AD, v2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack'));
        return true;
      }
      if (service === 'git-receive-pack') {
        sendRaw(res, 200, RECEIVE_AD, v0Advertisement(repo, 'git-receive-pack'));
        return true;
      }
      sendJson(res, 400, { message: 'Unknown service' });
      return true;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
      const body = await readBody(req);
      const packets = decodePktLines(body);
      const first = packets.find((p) => p.kind === 'data')?.payload.toString('utf8') ?? '';
      // v2 requests carry a command= line; route on it, v0 requests on the want lines.
      const out = first.startsWith('command=ls-refs')
        ? handleLsRefs(repo, packets)
        : first.startsWith('command=fetch')
          ? handleFetchV2(repo, packets)
          : handleFetchV0(repo, packets);
      sendRaw(res, 200, UPLOAD_RESULT, out);
      return true;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
      const body = await readBody(req);
      const out = handleReceivePack(repo, body);
      sendRaw(res, 200, RECEIVE_RESULT, out);
      return true;
    }
  } catch (err) {
    sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad request' });
    return true;
  }
  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

// ---------------------------------------------------------------- GraphQL v4

// A small parser for the GraphQL subset gh / github-mcp-server send:
// operations, variables, aliases, arguments (literals, variables, lists, input
// objects, enums), inline fragments, named fragments, __type introspection.

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface GqlField {
  alias: string | null; name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selections: GqlSelection[] | null;
}
type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'inline'; type: string | null; selections: GqlSelection[] }
  | { kind: 'spread'; name: string };
interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}
interface GqlDocument { operations: GqlOperation[]; fragments: Map<string, GqlSelection[]>; }

function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(c)) { tokens.push(c); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else { out += src[j]; j++; }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_.-]/.test(src[j])) j++;
    if (j === i) { i++; continue; }
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

function parseGql(src: string): GqlDocument {
  const tokens = gqlTokenize(src);
  let pos = 0;
  const peek = (): string => tokens[pos] ?? '';
  const next = (): string => tokens[pos++] ?? '';
  const expect = (t: string): void => { if (next() !== t) throw new Error(`expected ${t}`); };

  const parseValue = (): GqlValue => {
    const t = next();
    if (t === '$') return { kind: 'var', name: next() };
    if (t === '[') {
      const values: GqlValue[] = [];
      while (peek() !== ']') values.push(parseValue());
      expect(']');
      return { kind: 'list', values };
    }
    if (t === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (peek() !== '}') {
        const name = next();
        expect(':');
        fields.push({ name, value: parseValue() });
      }
      expect('}');
      return { kind: 'object', fields };
    }
    if (t.startsWith('"')) return { kind: 'string', value: JSON.parse(t) as string };
    if (t === 'true') return { kind: 'bool', value: true };
    if (t === 'false') return { kind: 'bool', value: false };
    if (t === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: Number(t) };
    if (/^-?\d+\.\d+$/.test(t)) return { kind: 'float', value: Number(t) };
    return { kind: 'enum', value: t };
  };

  const skipDirectives = (): void => {
    while (peek() === '@') {
      next();
      if (peek() === '(') {
        let depth = 0;
        while (pos < tokens.length) {
          const t = next();
          if (t === '(') depth++;
          else if (t === ')') { depth--; if (depth === 0) break; }
        }
      }
    }
  };

  const parseSelectionSet = (): GqlSelection[] => {
    expect('{');
    const out: GqlSelection[] = [];
    while (peek() !== '}') {
      if (peek() === '...') {
        next();
        if (peek() === 'on') {
          next();
          const type = next();
          skipDirectives();
          out.push({ kind: 'inline', type, selections: parseSelectionSet() });
        } else {
          out.push({ kind: 'spread', name: next() });
          skipDirectives();
        }
        continue;
      }
      let name = next();
      let alias: string | null = null;
      if (peek() === ':') { next(); alias = name; name = next(); }
      const args: Array<{ name: string; value: GqlValue }> = [];
      if (peek() === '(') {
        next();
        while (peek() !== ')') {
          const aname = next();
          expect(':');
          args.push({ name: aname, value: parseValue() });
        }
        expect(')');
      }
      skipDirectives();
      const selections = peek() === '{' ? parseSelectionSet() : null;
      out.push({ kind: 'field', field: { alias, name, args, selections } });
    }
    expect('}');
    return out;
  };

  const skipVarDefs = (): void => {
    if (peek() !== '(') return;
    let depth = 0;
    while (pos < tokens.length) {
      const t = next();
      if (t === '(' || t === '[' || t === '{') depth++;
      else if (t === ')' || t === ']' || t === '}') { depth--; if (depth === 0) break; }
    }
  };

  const operations: GqlOperation[] = [];
  const fragments = new Map<string, GqlSelection[]>();
  while (pos < tokens.length) {
    const t = peek();
    if (t === 'query' || t === 'mutation') {
      next();
      const kind = t as 'query' | 'mutation';
      let name: string | null = null;
      if (peek() !== '(' && peek() !== '{') name = next();
      skipVarDefs();
      skipDirectives();
      operations.push({ kind, name, selections: parseSelectionSet() });
    } else if (t === 'fragment') {
      next();
      const name = next();
      next(); // on
      next(); // type
      skipDirectives();
      fragments.set(name, parseSelectionSet());
    } else if (t === '{') {
      operations.push({ kind: 'query', name: null, selections: parseSelectionSet() });
    } else {
      pos++;
    }
  }
  return { operations, fragments };
}

function resolveGqlValue(v: GqlValue, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return variables[v.name];
    case 'string': case 'int': case 'float': case 'bool': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'list': return v.values.map((x) => resolveGqlValue(x, variables));
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const f of v.fields) o[f.name] = resolveGqlValue(f.value, variables);
      return o;
    }
  }
}

function argsMap(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveGqlValue(a.value, variables);
  return out;
}

// ---- schema tables for introspection

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'closedAt'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRefOid', 'baseRefOid', 'mergedAt', 'mergeCommit', 'author', 'createdAt', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'isPrivate', 'forkCount', 'stargazerCount'],
  User: ['login', 'id', 'name', 'email', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Ref: ['name', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};
const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

type GqlObj = Record<string, unknown> & { __typename: string };

function issueObj(repo: Repo, issue: Issue): GqlObj {
  return {
    __typename: 'Issue', id: issue.nodeId, number: issue.number, title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED', body: issue.body,
    createdAt: isoFromSeq(issue.createdSeq), updatedAt: isoFromSeq(issue.createdSeq),
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    _repo: repo, _issue: issue,
  };
}

function pullObj(repo: Repo, pr: Pull): GqlObj {
  return {
    __typename: 'PullRequest', id: pr.nodeId, number: pr.number, title: pr.title, body: pr.body,
    state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged, mergeable: mergeableState(repo, pr),
    headRefName: pr.headRef, baseRefName: pr.baseRef,
    headRefOid: pr.headSha, baseRefOid: pr.baseSha,
    mergedAt: pr.mergedAt,
    createdAt: isoFromSeq(pr.createdSeq),
    url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    _repo: repo, _pr: pr,
  };
}

function repoObj(repo: Repo): GqlObj {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    __typename: 'Repository', id: repo.nodeId, databaseId: repo.id, name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL },
    defaultBranchRef: tip ? { __typename: 'Ref', name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN', hasIssuesEnabled: true,
    description: repo.description, isPrivate: repo.private,
    createdAt: isoFromSeq(repo.createdSeq),
    url: `https://example.invalid/${repo.owner}/${repo.name}`,
    _repo: repo,
  };
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}
function seqFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObj {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((i) => wanted.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const field = String(orderBy?.field ?? 'CREATED_AT');
  const direction = String(orderBy?.direction ?? 'ASC');
  if (field === 'CREATED_AT' && direction === 'DESC') {
    list.sort((a, b) => (b.createdSeq - a.createdSeq) || (b.number - a.number));
  } else {
    list.sort((a, b) => (a.createdSeq - b.createdSeq) || (a.number - b.number));
  }
  const afterSeq = seqFromCursor(args.after);
  if (afterSeq > 0) list = list.filter((i) => i.createdSeq > afterSeq);
  const first = typeof args.first === 'number' ? args.first : 10;
  const page = list.slice(0, Math.max(0, first));
  const hasNext = list.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].createdSeq) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => issueObj(repo, i)),
    pageInfo: { __typename: 'PageInfo', hasNextPage: hasNext, hasPreviousPage: afterSeq > 0, startCursor: page.length > 0 ? cursorFor(page[0].createdSeq) : null, endCursor },
    totalCount: repo.issues.length,
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): GqlObj {
  let list = [...repo.pulls];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((p) => wanted.has(p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED'));
  } else {
    list = list.filter((p) => p.state === 'open');
  }
  list.sort((a, b) => b.createdSeq - a.createdSeq);
  const first = typeof args.first === 'number' ? args.first : 10;
  const page = list.slice(0, Math.max(0, first));
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((p) => pullObj(repo, p)),
    pageInfo: { __typename: 'PageInfo', hasNextPage: list.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null },
    totalCount: repo.pulls.length,
  };
}

function findByGlobalId(id: string): GqlObj | null {
  let decoded = '';
  try { decoded = Buffer.from(id, 'base64').toString('utf8'); } catch { return null; }
  const [kind, num] = decoded.split(':');
  const n = Number(num);
  if (!Number.isFinite(n)) return null;
  for (const repo of repos.values()) {
    if (kind === 'repo' && repo.id === n) return repoObj(repo);
    if (kind === 'issue') {
      const issue = repo.issues.find((i) => i.id === n);
      if (issue) return issueObj(repo, issue);
    }
    if (kind === 'pr') {
      const pr = repo.pulls.find((p) => p.id === n);
      if (pr) return pullObj(repo, pr);
    }
    if (kind === 'comment') {
      for (const issue of repo.issues) {
        const c = issue.comments.find((x) => x.id === n);
        if (c) return { __typename: 'IssueComment', id: c.nodeId, body: c.body, createdAt: isoFromSeq(c.createdSeq) };
      }
    }
  }
  return null;
}

function createIssueStore(repo: Repo, title: string, body: string): Issue {
  const number = repo.nextNumber++;
  const id = nextObjectId++;
  const issue: Issue = {
    id, nodeId: gid('issue', id), number, title, body: body ?? '', state: 'open',
    labels: [], comments: [], createdSeq: nextSeq++, closedAt: null,
  };
  repo.issues.push(issue);
  repo.issuesByNumber.set(number, issue);
  return issue;
}

function createPullStore(repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return null;
  const openDup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head);
  if (openDup) return openDup;
  const headTree = parseCommit(repo.objects.get(headSha)!.data).tree;
  const baseTree = parseCommit(repo.objects.get(baseSha)!.data).tree;
  const number = repo.nextNumber++;
  const id = nextObjectId++;
  const pr: Pull = {
    id, nodeId: gid('pr', id), number, title, body: body ?? '', state: 'open', merged: false,
    mergedAt: null, mergeCommitSha: null, headRef: head, baseRef: base,
    headSha, baseSha, files: diffTrees(repo, baseTree, headTree), createdSeq: nextSeq++,
  };
  repo.pulls.push(pr);
  repo.pullsByNumber.set(number, pr);
  return pr;
}

// Resolve one field on a parent object. Returns the raw value (scalar, GqlObj,
// array, or null). Unknown fields append an error and return null.
function resolveField(parent: GqlObj, field: GqlField, variables: Record<string, unknown>, errors: Array<{ message: string }>): unknown {
  const typeName = parent.__typename;
  const args = argsMap(field, variables);
  const unknown = (): null => {
    errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  };
  if (field.name === '__typename') return typeName;

  if (typeName === 'Query') {
    if (field.name === 'viewer') return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
    if (field.name === 'repository') {
      const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoObj(repo) : null;
    }
    if (field.name === 'node') return findByGlobalId(String(args.id ?? ''));
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      if (GQL_TYPE_FIELDS[name]) {
        return { __typename: '__Type', name, kind: 'OBJECT', fields: GQL_TYPE_FIELDS[name].map((n) => ({ __typename: '__Field', name: n })), enumValues: null };
      }
      if (GQL_ENUM_VALUES[name]) {
        return { __typename: '__Type', name, kind: 'ENUM', fields: null, enumValues: GQL_ENUM_VALUES[name].map((n) => ({ __typename: '__EnumValue', name: n })) };
      }
      return null;
    }
    if (field.name === '__schema') {
      return { __typename: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [] };
    }
    return unknown();
  }

  if (typeName === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = findByGlobalId(String(input.repositoryId ?? ''));
      if (!target || target.__typename !== 'Repository') { errors.push({ message: 'createIssue: repository not found' }); return null; }
      const repo = (target as GqlObj)._repo as Repo;
      const issue = createIssueStore(repo, String(input.title ?? ''), String(input.body ?? ''));
      return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue) };
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = findByGlobalId(String(input.issueId ?? ''));
      if (!target || target.__typename !== 'Issue') { errors.push({ message: 'closeIssue: issue not found' }); return null; }
      const issue = (target as GqlObj)._issue as Issue;
      issue.state = 'closed';
      issue.closedAt = isoFromSeq(nextSeq);
      const repo = (target as GqlObj)._repo as Repo;
      return { __typename: 'CloseIssuePayload', issue: issueObj(repo, issue) };
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = findByGlobalId(String(input.repositoryId ?? ''));
      if (!target || target.__typename !== 'Repository') { errors.push({ message: 'createPullRequest: repository not found' }); return null; }
      const repo = (target as GqlObj)._repo as Repo;
      const pr = createPullStore(repo, String(input.title ?? ''), String((input as Record<string, unknown>).body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if (!pr) { errors.push({ message: 'createPullRequest: head or base branch not found' }); return null; }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pr) };
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = findByGlobalId(String(input.pullRequestId ?? ''));
      if (!target || target.__typename !== 'PullRequest') { errors.push({ message: 'mergePullRequest: pull request not found' }); return null; }
      const pr = (target as GqlObj)._pr as Pull;
      const repo = (target as GqlObj)._repo as Repo;
      if (!pr.merged) {
        const sha = squashMerge(repo, pr);
        if (sha === null) { errors.push({ message: 'mergePullRequest: merge conflict' }); return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pr) }; }
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pr) };
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = findByGlobalId(String(input.subjectId ?? ''));
      if (!target || target.__typename !== 'Issue') { errors.push({ message: 'addComment: subject not found' }); return null; }
      const issue = (target as GqlObj)._issue as Issue;
      const id = nextObjectId++;
      const comment: Comment = { id, nodeId: gid('comment', id), body: String(input.body ?? ''), user: VIEWER_LOGIN, createdSeq: nextSeq++ };
      issue.comments.push(comment);
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', id: comment.nodeId, body: comment.body, createdAt: isoFromSeq(comment.createdSeq) } } };
    }
    return unknown();
  }

  if (typeName === 'Repository') {
    const repo = parent._repo as Repo;
    switch (field.name) {
      case 'id': return parent.id;
      case 'databaseId': return parent.databaseId;
      case 'name': return parent.name;
      case 'nameWithOwner': return parent.nameWithOwner;
      case 'owner': return parent.owner;
      case 'defaultBranchRef': return parent.defaultBranchRef;
      case 'viewerPermission': return parent.viewerPermission;
      case 'hasIssuesEnabled': return parent.hasIssuesEnabled;
      case 'description': return parent.description;
      case 'isPrivate': return parent.isPrivate;
      case 'createdAt': return parent.createdAt;
      case 'url': return parent.url;
      case 'issue': {
        const issue = repo.issuesByNumber.get(Number(args.number));
        return issue ? issueObj(repo, issue) : null;
      }
      case 'issues': return issuesConnection(repo, args);
      case 'pullRequests': return pullsConnection(repo, args);
      case 'pullRequest': {
        const pr = repo.pullsByNumber.get(Number(args.number));
        return pr ? pullObj(repo, pr) : null;
      }
      default: return unknown();
    }
  }

  if (typeName === 'Issue') {
    const issue = parent._issue as Issue;
    switch (field.name) {
      case 'id': case 'number': case 'title': case 'state': case 'body': case 'createdAt': case 'updatedAt': case 'url':
        return parent[field.name];
      case 'closedAt': return issue.closedAt;
      case 'author': return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
      case 'labels': return { __typename: 'LabelConnection', nodes: issue.labels.map((l) => ({ __typename: 'Label', name: l.name, color: l.color })) };
      case 'comments': return { __typename: 'IssueCommentConnection', nodes: issue.comments.map((c) => ({ __typename: 'IssueComment', id: c.nodeId, body: c.body })) };
      default: return unknown();
    }
  }

  if (typeName === 'PullRequest') {
    const pr = parent._pr as Pull;
    const repo = parent._repo as Repo;
    switch (field.name) {
      case 'id': case 'number': case 'title': case 'body': case 'state': case 'merged': case 'mergeable':
      case 'headRefName': case 'baseRefName': case 'headRefOid': case 'baseRefOid': case 'mergedAt': case 'createdAt': case 'url':
        return parent[field.name];
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 10;
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: pr.files.slice(0, Math.max(0, first)).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() })),
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: pr.files.length,
        };
      }
      case 'mergeCommit': return pr.mergeCommitSha ? { __typename: 'Commit', oid: pr.mergeCommitSha } : null;
      case 'author': return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
      default: return unknown();
    }
  }

  // Generic scalar passthrough for simple objects (User, Ref, PageInfo, payloads, __Type...).
  if (field.name in parent && typeof parent[field.name] !== 'object') return parent[field.name];
  if (field.name in parent) return parent[field.name];
  return unknown();
}

function executeSelections(parent: unknown, selections: GqlSelection[], doc: GqlDocument, variables: Record<string, unknown>, errors: Array<{ message: string }>): unknown {
  if (parent === null || parent === undefined) return null;
  if (Array.isArray(parent)) return parent.map((item) => executeSelections(item, selections, doc, variables, errors));
  if (typeof parent !== 'object') return parent;
  const obj = parent as GqlObj;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = doc.fragments.get(sel.name);
      if (frag) {
        const sub = executeSelections(parent, frag, doc, variables, errors) as Record<string, unknown>;
        Object.assign(out, sub);
      }
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.type !== null && sel.type !== obj.__typename) continue;
      const sub = executeSelections(parent, sel.selections, doc, variables, errors) as Record<string, unknown>;
      Object.assign(out, sub);
      continue;
    }
    const field = sel.field;
    const key = field.alias ?? field.name;
    const value = resolveField(obj, field, variables, errors);
    if (field.selections && value !== null && value !== undefined) {
      out[key] = executeSelections(value, field.selections, doc, variables, errors);
    } else {
      out[key] = value === undefined ? null : value;
    }
  }
  return out;
}

function executeOperation(doc: GqlDocument, op: GqlOperation, variables: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  const root: GqlObj = { __typename: op.kind === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelections(root, op.selections, doc, variables, errors);
  return errors.length > 0 ? { data, errors } : { data };
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
    return true;
  }
  const runOne = (entry: unknown): { data: unknown; errors?: Array<{ message: string }> } => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'Request body must be a JSON object with query and variables' }] };
    }
    const query = (entry as Record<string, unknown>).query;
    const variables = ((entry as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
    if (typeof query !== 'string') {
      return { data: null, errors: [{ message: 'Request body must carry a query string' }] };
    }
    let doc: GqlDocument;
    try {
      doc = parseGql(query);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Could not parse query' }] };
    }
    if (doc.operations.length === 0) return { data: {}, errors: [{ message: 'No operation in query' }] };
    const op = doc.operations[0];
    return executeOperation(doc, op, variables);
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return true;
  }
  sendJson(res, 200, runOne(parsed));
  return true;
}

// ---------------------------------------------------------------- MCP

const MCP_TOOLS: Array<{ name: string; description: string; inputSchema: { type: string; properties: Record<string, { type: string; description: string }>; required: string[] } }> = [
  {
    name: 'create_repo', description: 'Create a new repository for the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] },
  },
  {
    name: 'get_repo', description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue', description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'get_issue', description: 'Get an issue by number.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, issue_number: { type: 'number', description: 'Issue number' } }, required: ['owner', 'repo', 'issue_number'] },
  },
  {
    name: 'list_issues', description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed, or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request', description: 'Create a pull request in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, body: { type: 'string', description: 'Pull request body' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'list_pull_requests', description: 'List pull requests in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Pull request state: open, closed, or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'merge_pull_request', description: 'Merge a pull request using squash.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'number', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

function mcpResult(id: unknown, result: unknown): unknown {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function mcpError(id: unknown, code: number, message: string, data?: unknown): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}
function toolText(payload: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown; isError: false } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
}
function toolErrorText(message: string): { content: Array<{ type: string; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, mcpError(null, -32700, 'Parse error'));
    return true;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, mcpError(null, -32600, 'Invalid Request'));
    return true;
  }
  const body = parsed as Record<string, unknown>;
  const id = (body.id ?? null) as unknown;
  const method = String(body.method ?? '');
  const params = (body.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id: acknowledge with 202 and no body.
  if (id === null || id === undefined) {
    res.writeHead(202);
    res.end();
    return true;
  }

  if (method === 'server/discover') {
    sendJson(res, 200, mcpResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25'],
      serverInfo: { name: 'forge', version: '1.0.0' },
      capabilities: { tools: {} },
    }));
    return true;
  }
  if (method === 'initialize') {
    sendJson(res, 200, mcpResult(id, {
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    }));
    return true;
  }
  if (method === 'ping') {
    sendJson(res, 200, mcpResult(id, {}));
    return true;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, mcpResult(id, { tools: MCP_TOOLS }));
    return true;
  }
  if (method === 'tools/call') {
    const requested = String((params.name as string) ?? '');
    const tool = MCP_TOOLS.find((t) => t.name === requested || requested.toLowerCase().endsWith(t.name));
    if (!tool) {
      sendJson(res, 200, mcpError(id, -32602, `Unknown tool: ${requested}`));
      return true;
    }
    const args = ((params.arguments ?? {}) as Record<string, unknown>);
    // The suite fills full_name with owner/repo; split it for tools that take both.
    if (typeof args.full_name === 'string') {
      const [o, r] = (args.full_name as string).split('/');
      if (o && r) { args.owner = o; args.repo = r; }
    }
    for (const reqProp of tool.inputSchema.required) {
      if (args[reqProp] === undefined || args[reqProp] === null || args[reqProp] === '') {
        sendJson(res, 200, mcpError(id, -32602, `Missing required argument: ${reqProp}`));
        return true;
      }
    }
    const owner = String(args.owner ?? '');
    const repoName = String(args.repo ?? '');
    const state = String(args.state ?? 'open');
    switch (tool.name) {
      case 'create_repo': {
        const name = String(args.name ?? '');
        if (getRepo(VIEWER_LOGIN, name)) {
          sendJson(res, 200, mcpResult(id, toolErrorText(`Repository ${name} already exists`)));
          return true;
        }
        const repo = createRepoRecord(VIEWER_LOGIN, name, String(args.description ?? ''), Boolean(args.private ?? false));
        sendJson(res, 200, mcpResult(id, toolText(repoJson(repo))));
        return true;
      }
      case 'get_repo': {
        const repo = getRepo(owner, repoName);
        if (!repo) { sendJson(res, 200, mcpResult(id, toolErrorText(`Repository ${owner}/${repoName} not found`))); return true; }
        sendJson(res, 200, mcpResult(id, toolText(repoJson(repo))));
        return true;
      }
      case 'create_issue': {
        const repo = getRepo(owner, repoName);
        if (!repo) { sendJson(res, 200, mcpResult(id, toolErrorText(`Repository ${owner}/${repoName} not found`))); return true; }
        const issue = createIssueStore(repo, String(args.title ?? ''), String(args.body ?? ''));
        sendJson(res, 200, mcpResult(id, toolText(issueJson(repo, issue))));
        return true;
      }
      case 'get_issue': {
        const repo = getRepo(owner, repoName);
        const issue = repo?.issuesByNumber.get(Number(args.issue_number));
        if (!issue) { sendJson(res, 200, mcpResult(id, toolErrorText('Issue not found'))); return true; }
        sendJson(res, 200, mcpResult(id, toolText(issueJson(repo!, issue))));
        return true;
      }
      case 'list_issues': {
        const repo = getRepo(owner, repoName);
        if (!repo) { sendJson(res, 200, mcpResult(id, toolErrorText(`Repository ${owner}/${repoName} not found`))); return true; }
        const list = repo.issues.filter((i) => state === 'all' || i.state === state);
        sendJson(res, 200, mcpResult(id, toolText(list.map((i) => issueJson(repo, i)))));
        return true;
      }
      case 'create_pull_request': {
        const repo = getRepo(owner, repoName);
        if (!repo) { sendJson(res, 200, mcpResult(id, toolErrorText(`Repository ${owner}/${repoName} not found`))); return true; }
        const pr = createPullStore(repo, String(args.title ?? ''), String(args.body ?? ''), String(args.head ?? ''), String(args.base ?? ''));
        if (!pr) { sendJson(res, 200, mcpResult(id, toolErrorText('Head or base branch not found'))); return true; }
        sendJson(res, 200, mcpResult(id, toolText(pullJson(repo, pr))));
        return true;
      }
      case 'list_pull_requests': {
        const repo = getRepo(owner, repoName);
        if (!repo) { sendJson(res, 200, mcpResult(id, toolErrorText(`Repository ${owner}/${repoName} not found`))); return true; }
        const list = repo.pulls.filter((p) => state === 'all' || (state === 'open' ? p.state === 'open' : p.state === state));
        sendJson(res, 200, mcpResult(id, toolText(list.map((p) => pullJson(repo, p)))));
        return true;
      }
      case 'merge_pull_request': {
        const repo = getRepo(owner, repoName);
        const pr = repo?.pullsByNumber.get(Number(args.pull_number));
        if (!pr || !repo) { sendJson(res, 200, mcpResult(id, toolErrorText('Pull request not found'))); return true; }
        const sha = squashMerge(repo, pr);
        if (sha === null) { sendJson(res, 200, mcpResult(id, toolErrorText('Merge conflict'))); return true; }
        sendJson(res, 200, mcpResult(id, toolText({ sha, merged: true, message: `Merge pull request #${pr.number} from ${pr.headRef}` })));
        return true;
      }
      default:
        sendJson(res, 200, mcpError(id, -32601, `Method not found: ${tool.name}`));
        return true;
    }
  }
  sendJson(res, 200, mcpError(id, -32601, `Method not found: ${method}`));
  return true;
}

// ---------------------------------------------------------------- app wiring

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
    const segs = splitPath(parsed.pathname);
    const query = parsed.searchParams;
    try {
      if (req.method === 'GET' && parsed.pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (segs[0] === 'api' && segs[1] === 'v3') {
        if (await handleRest(req, res, segs.slice(2), query)) return;
      } else if (segs[0] === 'api' && segs[1] === 'graphql' && req.method === 'POST') {
        if (await handleGraphQL(req, res)) return;
      } else if (segs[0] === 'mcp' && req.method === 'POST') {
        if (await handleMcp(req, res)) return;
      } else if (segs.length >= 2 && segs[1].endsWith('.git')) {
        if (await handleGit(req, res, segs, query)) return;
      }
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
      } else {
        res.end();
      }
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
  });
}

// Deterministic state export: every timestamp is derived from sequence numbers
// and object ids, so two runs on the same instance leave identical state.
export function exportState(): unknown {
  const repoList = [...repos.values()].sort((a, b) => a.id - b.id).map((r) => repoJson(r));
  return { repos: repoList, nextRepoId, nextObjectId, nextSeq, nextCommitSeq, nextReqId };
}
