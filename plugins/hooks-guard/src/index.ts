/**
 * How a hunk is drawn, passed straight through.
 *
 * The interface reads changes through this plugin, so it asks this plugin for
 * their rows as well — one import rather than a second one that would put a
 * tool in the interface's dependencies for the sake of a formatting helper.
 */
export { hunkRows } from '@aidcrew/tool-fs'
export type { Collision, Open } from './collide.ts'
export { createRadar } from './collide.ts'
export { irreversible } from './irreversible.ts'
export type { GuardOptions, GuardRequest, Trust } from './plugin.ts'
export { createGuard, createGuardPlugin, default } from './plugin.ts'
export { refuseWrite } from './protected.ts'
export type { Revertable, Reverted } from './revert.ts'
export { revertable, revertHunk } from './revert.ts'
export type { Change, Snapshot } from './undo.ts'
export { changes, commit, discard, keep, snapshot, UNDO_DIR, undo, undoRoot } from './undo.ts'
export { fileOf, taskOf } from './worktree.ts'
