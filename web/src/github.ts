// GitHub as the database: schedule/data.json in the repository.
//  - Everyone reads the copy published with the site (data.json next to index.html).
//  - The admin reads and writes the file through the GitHub API with a repository-scoped token.
//    Every save is a commit (full history), and the file's sha makes a concurrent edit fail instead of overwriting.
import { ApiFail } from '../../shared/apiError.ts';
import { normalizeData, serialize, type Data } from '../../shared/engine.ts';

export const REPO: string = import.meta.env.VITE_GH_REPO ?? '';
const BRANCH: string = import.meta.env.VITE_GH_BRANCH || 'main';
const PATH = 'schedule/data.json';
/** Overridable only so the build can be tested against a local stand-in for the GitHub API. */
const API: string = import.meta.env.VITE_GH_API || 'https://api.github.com';

const NETWORK = 'Cannot reach GitHub. Check your connection and try again.';

function headers(token: string): Record<string, string> {
  return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
}

async function call(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new ApiFail(0, 'network', NETWORK);
  }
}

function authError(res: Response): ApiFail | null {
  if (res.status === 401) return new ApiFail(401, 'unauthorized', 'GitHub did not accept the access token. It may have expired or been revoked.');
  if (res.status === 403 || res.status === 404) {
    return new ApiFail(403, 'forbidden', 'The access token cannot write to this repository. It needs "Contents: Read and write" on this repository only.');
  }
  return null;
}

const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromBase64 = (b64: string): string => {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

/** The published copy: what visitors see. Revalidated on every load so a new deploy shows up promptly. */
export async function readPublic(): Promise<Data> {
  const res = await call(new URL('data.json', document.baseURI).href, { cache: 'no-cache' });
  if (!res.ok) throw new ApiFail(res.status, 'load_failed', `Could not load the schedule (${res.status}).`);
  try {
    return normalizeData(await res.json());
  } catch (e) {
    throw new ApiFail(500, 'bad_data', e instanceof Error ? e.message : 'The schedule file is unreadable.');
  }
}

export interface Fresh {
  data: Data;
  /** Blob sha to send back with the next save; null when the file does not exist yet. */
  sha: string | null;
}

/** The latest committed copy, straight from the repository (not the possibly older published one). */
export async function readFresh(token: string): Promise<Fresh> {
  const res = await call(`${API}/repos/${REPO}/contents/${PATH}?ref=${encodeURIComponent(BRANCH)}`, { headers: headers(token), cache: 'no-store' });
  if (res.status === 404) {
    const forbidden = await call(`${API}/repos/${REPO}`, { headers: headers(token), cache: 'no-store' });
    if (forbidden.ok) return { data: normalizeData({ version: 1, rooms: [], semesters: [], reservations: [] }), sha: null };
  }
  const err = authError(res);
  if (err) throw err;
  if (!res.ok) throw new ApiFail(res.status, 'load_failed', `GitHub returned ${res.status} while loading the schedule.`);
  const body = (await res.json()) as { sha: string; content: string };
  try {
    return { data: normalizeData(JSON.parse(fromBase64(body.content))), sha: body.sha };
  } catch (e) {
    throw new ApiFail(500, 'bad_data', e instanceof Error ? e.message : 'The schedule file is unreadable.');
  }
}

/** Commit `data`. Returns the new sha. Throws 409 `stale` if someone else saved since `sha` was read. */
export async function write(token: string, data: Data, sha: string | null, message: string): Promise<string> {
  const res = await call(`${API}/repos/${REPO}/contents/${PATH}`, {
    method: 'PUT',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: toBase64(serialize(data)), branch: BRANCH, ...(sha ? { sha } : {}) }),
  });
  if (res.status === 409 || res.status === 422) {
    throw new ApiFail(409, 'stale', 'The schedule was changed somewhere else. The latest version has been loaded; please repeat your change.');
  }
  const err = authError(res);
  if (err) throw err;
  if (!res.ok) throw new ApiFail(res.status, 'save_failed', `GitHub refused the save (${res.status}).`);
  return ((await res.json()) as { content: { sha: string } }).content.sha;
}

/** Check a pasted token: it must be accepted and be allowed to push to the repository. Returns the GitHub user name. */
export async function verify(token: string): Promise<string> {
  if (!REPO) throw new ApiFail(400, 'not_configured', 'This build is not linked to a GitHub repository (VITE_GH_REPO is empty).');
  const repo = await call(`${API}/repos/${REPO}`, { headers: headers(token), cache: 'no-store' });
  if (repo.status === 401 || repo.status === 404) {
    throw new ApiFail(401, 'invalid_credentials', 'GitHub did not accept that token for this repository. Check it was copied completely and is limited to this repository.');
  }
  if (!repo.ok) throw new ApiFail(repo.status, 'verify_failed', `GitHub returned ${repo.status} while checking the token.`);
  const info = (await repo.json()) as { permissions?: { push?: boolean } };
  if (info.permissions?.push === false) {
    throw new ApiFail(403, 'forbidden', 'That token can only read this repository. Give it "Contents: Read and write".');
  }
  const user = await call(`${API}/user`, { headers: headers(token), cache: 'no-store' });
  return user.ok ? (((await user.json()) as { login?: string }).login ?? 'admin') : 'admin';
}
