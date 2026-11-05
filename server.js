// OpenCode 2.0.24 resolves local plugin directories by filename (unlike npm packages).
// Keep this shim so the built checkout works as a `plugins` directory entry too.
export { default } from './dist/plugin/index.js';
