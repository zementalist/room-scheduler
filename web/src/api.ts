// One import point for the UI. The backend is chosen at build time:
//   VITE_BACKEND=static  -> GitHub Pages edition (data in the repo, rules in the browser)
//   otherwise            -> the Node/SQLite server over /api
import * as local from './staticApi.ts';
import * as server from './serverApi.ts';

export { ApiFail } from '../../shared/apiError.ts';
export type { Diagnostic, ImportPreview, RoomBody, SemesterBody, Summary } from './apiTypes.ts';

/** True in the GitHub Pages build: admin signs in with an access token instead of a password. */
export const STATIC = import.meta.env.VITE_BACKEND === 'static';

const impl = STATIC ? local : server;
export const api = impl.api;
export const download = impl.download;
export const setUnauthorizedHandler = impl.setUnauthorizedHandler;
